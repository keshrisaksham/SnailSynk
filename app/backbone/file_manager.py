# backbone/file_manager.py
import os
import io
import re
import posixpath
import json
import uuid
import time
import shutil
import base64
import zipfile
import tempfile
import logging
from pathlib import Path
from urllib.parse import quote
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from rich.markup import escape
from .utils import log_history, format_size
from .storage import atomic_write_json, load_json

class FileManager:
    """Handles all file-related operations."""
    def __init__(self, files_folder, instance_path):
        if not files_folder or not os.path.isdir(files_folder):
            raise ValueError("Invalid files_folder provided to FileManager.")
        self.files_folder = files_folder
        self.supported_image_extensions = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'}

        self.metadata_path = os.path.join(instance_path, 'file_metadata.json')
        self.share_links_path = os.path.join(instance_path, 'share_links.json')
        self.ph = PasswordHasher()
        self.metadata = self._load_metadata()
        self.share_links = self._load_share_links()
        self._size_cache = {}   # folder path -> (expiry, total bytes)
        self._remove_stale_uploads()

    def _load_metadata(self):
        return load_json(self.metadata_path, {}, dict, 'file metadata (locks/favorites)')

    def _save_metadata(self):
        try:
            atomic_write_json(self.metadata_path, self.metadata, mode=0o600)
        except OSError as e:
            logging.error(f"Could not save file metadata to {self.metadata_path}: {e}")

    def _load_share_links(self):
        return load_json(self.share_links_path, {}, dict, 'share links')

    def _save_share_links(self):
        try:
            atomic_write_json(self.share_links_path, self.share_links, mode=0o600)
        except OSError as e:
            logging.error(f"Could not save share links to {self.share_links_path}: {e}")

    def _remove_stale_uploads(self):
        """Delete '.<id>.part' temp files left behind if the server was killed mid-upload."""
        pattern = re.compile(r'^\.[0-9a-f]{32}\.part$')
        for dirpath, _dirs, filenames in os.walk(self.files_folder):
            for name in filenames:
                if pattern.match(name):
                    try:
                        os.unlink(os.path.join(dirpath, name))
                    except OSError:
                        pass

    FOLDER_SIZE_TTL = 30  # seconds

    def _folder_size(self, full_path):
        """Total size of a folder tree. Cached briefly: listing a folder otherwise re-walks every
        subtree on each refresh (and each real-time broadcast), which is slow on big shares."""
        now = time.monotonic()
        cached = self._size_cache.get(full_path)
        if cached and cached[0] > now:
            return cached[1]
        total = 0
        for dirpath, _dirnames, filenames in os.walk(full_path):
            for name in filenames:
                try:
                    total += os.path.getsize(os.path.join(dirpath, name))
                except OSError:
                    pass
        if len(self._size_cache) > 2000:
            self._size_cache.clear()
        self._size_cache[full_path] = (now + self.FOLDER_SIZE_TTL, total)
        return total

    def _new_zip_buffer(self):
        """Zips are built in an anonymous temp file (deleted on close) rather than in RAM, so
        zipping a large folder cannot exhaust memory."""
        return tempfile.TemporaryFile()

    def _generate_unique_filename(self, file_path):
        if not os.path.exists(file_path): return file_path
        directory, filename = os.path.split(file_path)
        name, ext = os.path.splitext(filename)
        counter = 1
        while True:
            new_path = os.path.join(directory, f"{name} ({counter}){ext}")
            if not os.path.exists(new_path): return new_path
            counter += 1

    def normalize_rel(self, path):
        """Canonical, relative, forward-slash form of `path` ('' for the root), or None if it
        is invalid or tries to leave the files folder. Lock metadata is keyed on this form, so
        'a/../secret.txt' and './secret.txt' cannot dodge a lock on 'secret.txt'."""
        if path is None:
            return ''
        if not isinstance(path, str) or '\x00' in path:
            return None
        norm = posixpath.normpath(path.replace('\\', '/'))
        if norm == '.':
            return ''
        if norm.startswith('/') or norm == '..' or norm.startswith('../') or re.match(r'^[A-Za-z]:', norm):
            return None
        return norm

    def _is_within(self, path):
        """True if `path` (after resolving symlinks) is the files folder or inside it."""
        base = os.path.realpath(self.files_folder)
        target = os.path.realpath(path)
        try:
            return os.path.commonpath([base, target]) == base
        except ValueError:  # e.g. different drives on Windows
            return False

    def _validate_subpath(self, subpath):
        """Validate and resolve a subpath within files_folder. Returns the absolute path or raises ValueError."""
        norm = self.normalize_rel(subpath)
        if norm is None:
            raise ValueError("Invalid path.")
        if norm == '':
            return self.files_folder
        full_path = os.path.join(self.files_folder, *norm.split('/'))
        if not self._is_within(full_path):
            raise ValueError("Access denied.")
        return full_path

    @staticmethod
    def _clean_name(name):
        """Validate a single file/folder name WITHOUT altering it (spaces and unicode are kept).
        Returns the stripped name, or None if it is empty or could escape its directory."""
        if not isinstance(name, str):
            return None
        name = name.strip()
        if not name or name in ('.', '..') or '\x00' in name or '/' in name or '\\' in name:
            return None
        return name

    def _move_metadata_prefix(self, old_prefix, new_prefix):
        """Re-key metadata (file locks, favorites, folder locks) when a path moves or is renamed."""
        changed = False
        for key in list(self.metadata):
            if key.startswith('folder:'):
                path, tag = key[len('folder:'):], 'folder:'
            else:
                path, tag = key, ''
            if path == old_prefix or path.startswith(old_prefix + '/'):
                self.metadata[tag + new_prefix + path[len(old_prefix):]] = self.metadata.pop(key)
                changed = True
        if changed:
            self._save_metadata()

    def _drop_metadata_prefix(self, prefix):
        """Remove metadata for a path and everything beneath it (after a delete)."""
        stale = [k for k in self.metadata
                 if (k[len('folder:'):] if k.startswith('folder:') else k) == prefix
                 or (k[len('folder:'):] if k.startswith('folder:') else k).startswith(prefix + '/')]
        for k in stale:
            del self.metadata[k]
        if stale:
            self._save_metadata()

    def is_locked(self, filename):
        filename = self.normalize_rel(filename)
        if filename is None:
            return True  # invalid path: fail closed
        meta = self.metadata.get(filename, {})
        if isinstance(meta, dict):
            return 'password_hash' in meta
        return False

    def lock_file(self, filename, password):
        filename = self.normalize_rel(filename)
        if not filename: return False, "Invalid path."
        if not password: return False, "Password cannot be empty."
        if not os.path.isfile(os.path.join(self.files_folder, filename)): return False, "File not found."
        password_hash = self.ph.hash(password)
        meta = self.metadata.get(filename)
        if not isinstance(meta, dict):
            meta = {}
        meta['password_hash'] = password_hash  # keep other flags such as 'favorite'
        self.metadata[filename] = meta
        self._save_metadata()
        return True, f"File '{filename}' locked."

    def unlock_file(self, filename):
        filename = self.normalize_rel(filename)
        meta = self.metadata.get(filename) if filename else None
        if meta and isinstance(meta, dict) and 'password_hash' in meta:
            del meta['password_hash']
            # Drop the entry entirely if nothing else (e.g. a favorite flag) remains
            if not meta:
                del self.metadata[filename]
            self._save_metadata()
            return True, f"File '{filename}' unlocked."
        return False, "File was not locked."

    def verify_file_password(self, filename, password):
        filename = self.normalize_rel(filename)
        if not filename or not self.is_locked(filename): return False
        password_hash = self.metadata[filename].get('password_hash')
        try:
            self.ph.verify(password_hash, password)
            return True
        except VerifyMismatchError: return False
        except Exception as e:
            logging.error(f"Error during file password verification for {filename}: {e}")
            return False

    def list_files(self, subpath=''):
        """List files and folders in the given subpath."""
        items = []
        try:
            target_dir = self._validate_subpath(subpath)
            if not os.path.isdir(target_dir):
                return items
            raw_entries = os.listdir(target_dir)
            entries = sorted([e for e in raw_entries if not e.startswith('.')], key=str.lower)
            # Folders first, then files
            folders = []
            files = []
            for entry in entries:
                full_path = os.path.join(target_dir, entry)
                # Build the relative path from files_folder root for encoded_name
                rel_path = f"{subpath}/{entry}" if subpath else entry
                if os.path.isdir(full_path):
                    # Calculate folder size (sum of all files recursively)
                    folder_size = self._folder_size(full_path)
                    folders.append({
                        'name': entry,
                        'encoded_name': quote(rel_path, safe='/'),
                        'type': 'folder',
                        'is_locked': self.is_folder_locked(rel_path),
                        'mtime': os.path.getmtime(full_path),
                        'size': folder_size,
                        'is_favorite': self.is_favorite(rel_path)
                    })
                elif os.path.isfile(full_path):
                    files.append({
                        'name': entry,
                        'encoded_name': quote(rel_path, safe='/'),
                        'type': 'file',
                        'is_locked': self.is_locked(rel_path),
                        'mtime': os.path.getmtime(full_path),
                        'size': os.path.getsize(full_path),
                        'is_favorite': self.is_favorite(rel_path)
                    })
            items = folders + files
        except ValueError as e:
            logging.warning(f"Invalid subpath requested: {subpath} - {e}")
        except Exception as e:
            logging.error(f"Error listing files in {self.files_folder}/{subpath}: {e}")
            raise
        return items

    def _publish_unique(self, part_path, desired_path):
        """Move a finished upload to `desired_path`, or 'name (1).ext', 'name (2).ext'... if taken.
        Uses a hard link, which fails if the target exists, so two simultaneous uploads of the
        same name can never overwrite each other."""
        directory, filename = os.path.split(desired_path)
        stem, ext = os.path.splitext(filename)
        for counter in range(0, 10000):
            candidate = desired_path if counter == 0 else os.path.join(directory, f"{stem} ({counter}){ext}")
            try:
                os.link(part_path, candidate)
                return candidate
            except FileExistsError:
                continue
            except OSError:
                # Filesystem without hard links (e.g. FAT/exFAT): fall back to check-then-rename
                if not os.path.exists(candidate):
                    os.replace(part_path, candidate)
                    return candidate
        raise OSError("Could not find a free file name.")

    MAX_UPLOAD_DEPTH = 32
    IGNORED_UPLOAD_NAMES = {'.ds_store', 'thumbs.db', 'desktop.ini'}   # OS junk that rides along with folders

    def save_uploaded_files(self, uploaded_files, remote_addr, subpath='', is_admin=False, relpaths=None, quiet=False):
        """Save uploaded files into `subpath`.

        `relpaths` (optional, one per file, same order) are paths like 'photos/2024/a.jpg' used for folder
        uploads: the sub-folders are created as needed. Every segment is validated, and the usual lock rules
        apply to every folder the files would land in. `quiet` skips the per-file terminal line (folder
        uploads send hundreds of files and report once at the end instead).
        """
        success_messages, error_messages, uploaded_count = [], [], 0
        ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
        if not uploaded_files or all(f.filename == '' for f in uploaded_files):
            return [], ['No files selected for uploading.']
        subpath = self.normalize_rel(subpath)
        if subpath is None:
            return [], ['Invalid upload directory.']
        try:
            base_dir = self._validate_subpath(subpath)
        except ValueError:
            return [], ['Invalid upload directory.']
        if not os.path.isdir(base_dir):
            return [], ['Upload directory does not exist.']
        # Non-admin users cannot upload to locked folders (or folders inside one)
        if not is_admin and self.is_any_parent_locked(subpath):
            return [], ['This folder is locked. Only admins can upload here.']
        use_relpaths = bool(relpaths) and len(relpaths) == len(uploaded_files)
        for index, file in enumerate(uploaded_files):
            if not file or file.filename == '': continue
            # The client controls the names. Without relpaths keep only the final component of the file name, so a
            # crafted "../../x" can never leave the target folder. With relpaths, validate every folder segment.
            claimed = (relpaths[index] if use_relpaths else file.filename) or ''
            parts = claimed.replace('\\', '/').split('/')
            original_filename = self._clean_name(parts[-1])
            dirs = [self._clean_name(d) for d in parts[:-1]] if use_relpaths else []
            if not original_filename or None in dirs or len(dirs) > self.MAX_UPLOAD_DEPTH:
                error_messages.append(f'Filename "{claimed}" is not allowed.')
                continue
            if original_filename.lower() in self.IGNORED_UPLOAD_NAMES:
                continue
            target_dir, rel_target = base_dir, subpath
            if dirs:
                target_dir = os.path.join(base_dir, *dirs)
                rel_target = '/'.join(p for p in [subpath, *dirs] if p)
                if not self._is_within(target_dir):
                    error_messages.append(f'Filename "{claimed}" is not allowed.')
                    continue
                if not is_admin and self.is_any_parent_locked(rel_target):
                    error_messages.append(f'"{rel_target}" is locked. Only admins can upload there.')
                    continue
                try:
                    os.makedirs(target_dir, exist_ok=True)
                except OSError as e:
                    logging.error(f'Could not create upload folder {target_dir}: {e}')
                    error_messages.append(f'Could not create folder "{rel_target}".')
                    continue
            part_path = os.path.join(target_dir, f".{uuid.uuid4().hex}.part")   # hidden from listings
            try:
                file.save(part_path)
                unique_path = self._publish_unique(part_path, os.path.join(target_dir, original_filename))
                final_filename = os.path.basename(unique_path)
                display_path = f"{rel_target}/{final_filename}" if rel_target else final_filename
                if not quiet:
                    log_history("File Uploaded", f"'{escape(display_path)}' ({format_size(os.path.getsize(unique_path))}) from [{ip_color}]{remote_addr}[/]")
                if final_filename == original_filename: success_messages.append(f'File "{original_filename}" uploaded successfully.')
                else: success_messages.append(f'File "{original_filename}" was renamed to "{final_filename}".')
                uploaded_count += 1
            except Exception as e:
                error_messages.append(f'Error saving file "{original_filename}". Check server logs.')
                logging.error(f'Error saving file {original_filename} to {target_dir}: {e}')
            finally:
                try: os.unlink(part_path)   # only still exists if the upload failed part-way
                except OSError: pass
        self._size_cache.clear()
        if uploaded_count == 0 and any(f.filename for f in uploaded_files if f) and not error_messages:
            return success_messages, ['No files were successfully uploaded.']
        if uploaded_count == 0 and any(f.filename for f in uploaded_files if f):
            error_messages.append('No files were successfully uploaded.')
        return success_messages, error_messages

    def move_file(self, filename, source_path, dest_path, remote_addr):
        """Move a file from source_path to dest_path. Both are relative subpaths."""
        self._size_cache.clear()
        try:
            source_dir = self._validate_subpath(source_path)
            dest_dir = self._validate_subpath(dest_path)
        except ValueError:
            return False, "Invalid path."
        source_file = os.path.join(source_dir, filename)
        if not os.path.isfile(source_file):
            return False, f"File '{filename}' not found in source."
        if not os.path.isdir(dest_dir):
            return False, "Destination folder does not exist."
        dest_file = self._generate_unique_filename(os.path.join(dest_dir, filename))
        try:
            shutil.move(source_file, dest_file)
            # Update metadata (lock info) if the file was locked
            old_rel = f"{source_path}/{filename}" if source_path else filename
            new_rel = f"{dest_path}/{os.path.basename(dest_file)}" if dest_path else os.path.basename(dest_file)
            if old_rel in self.metadata:
                self.metadata[new_rel] = self.metadata.pop(old_rel)
                self._save_metadata()
            ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
            log_history("File Moved", f"'{escape(old_rel)}' -> '{escape(new_rel)}' by [{ip_color}]{remote_addr}[/]")
            return True, f"File '{filename}' moved successfully."
        except Exception as e:
            logging.error(f"Error moving file {source_file} to {dest_file}: {e}")
            return False, "An unexpected server error occurred."

    def move_folder(self, folder_name, source_path, dest_path, remote_addr):
        """Move a folder between subpaths, carrying its locks/favorites with it."""
        self._size_cache.clear()
        name = self._clean_name(folder_name)
        if not name:
            return False, "Invalid folder name."
        try:
            source_dir = self._validate_subpath(source_path)
            dest_dir = self._validate_subpath(dest_path)
        except ValueError:
            return False, "Invalid path."
        source_item = os.path.join(source_dir, name)
        dest_item = os.path.join(dest_dir, name)
        if not os.path.isdir(source_item):
            return False, "Folder not found."
        if not os.path.isdir(dest_dir):
            return False, "Destination folder does not exist."
        if os.path.exists(dest_item):
            return False, "Folder already exists at destination."
        if os.path.abspath(dest_dir) == os.path.abspath(source_item) or \
                os.path.abspath(dest_dir).startswith(os.path.abspath(source_item) + os.sep):
            return False, "Cannot move a folder into itself."
        try:
            shutil.move(source_item, dest_item)
            old_rel = f"{source_path}/{name}" if source_path else name
            new_rel = f"{dest_path}/{name}" if dest_path else name
            self._move_metadata_prefix(old_rel, new_rel)
            ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
            log_history("Folder Moved", f"'{escape(old_rel)}' -> '{escape(new_rel)}' by [{ip_color}]{remote_addr}[/]")
            return True, f"Folder '{name}' moved successfully."
        except Exception as e:
            logging.error(f"Error moving folder {source_item} to {dest_item}: {e}")
            return False, "An unexpected server error occurred."

    def list_all_folders(self, base_path=''):
        """Recursively list all folder paths relative to files_folder root."""
        folders = [{'path': '', 'name': 'Root'}]
        def _walk(rel_path):
            try:
                target_dir = self._validate_subpath(rel_path)
            except ValueError:
                return
            if not os.path.isdir(target_dir):
                return
            try:
                for entry in sorted(os.listdir(target_dir), key=str.lower):
                    if entry.startswith('.'):
                        continue
                    full = os.path.join(target_dir, entry)
                    if os.path.isdir(full):
                        child_rel = f"{rel_path}/{entry}" if rel_path else entry
                        folders.append({'path': child_rel, 'name': child_rel})
                        _walk(child_rel)
            except Exception as e:
                logging.error(f"Error walking folders in {target_dir}: {e}")
        _walk(base_path)
        return folders

    # --- Lock Ancestry Check ---
    def is_any_parent_locked(self, subpath):
        """Check if the folder at `subpath`, or any folder above it, is locked."""
        norm = self.normalize_rel(subpath)
        if norm is None:
            return True  # invalid path: fail closed
        if not norm:
            return False
        parts = norm.split('/')
        return any(self.is_folder_locked('/'.join(parts[:i + 1])) for i in range(len(parts)))

    def can_access(self, rel_path, unlocked_files=(), unlocked_folders=(), is_folder=False):
        """True if a file/folder may be read: it and every locked folder above it must have
        been unlocked (by exact path) in the caller's session."""
        norm = self.normalize_rel(rel_path)
        if norm is None:
            return False
        unlocked_files, unlocked_folders = set(unlocked_files or ()), set(unlocked_folders or ())
        if not is_folder:
            if self.is_locked(norm) and norm not in unlocked_files:
                return False
            norm = norm.rsplit('/', 1)[0] if '/' in norm else ''
        if not norm:
            return True
        parts = norm.split('/')
        for i in range(len(parts)):
            ancestor = '/'.join(parts[:i + 1])
            if self.is_folder_locked(ancestor) and ancestor not in unlocked_folders:
                return False
        return True

    # --- Folder Locking ---
    def is_folder_locked(self, subpath):
        """Check if a folder is locked. Uses metadata key 'folder:<subpath>'."""
        subpath = self.normalize_rel(subpath)
        if subpath is None:
            return True  # invalid path: fail closed
        if not subpath:
            return False  # Root folder can never be locked
        key = f"folder:{subpath}"
        meta = self.metadata.get(key, {})
        if isinstance(meta, dict):
            return 'password_hash' in meta
        return key in self.metadata

    def lock_folder(self, subpath, password):
        """Lock a folder with a password so non-admin users cannot upload to it."""
        subpath = self.normalize_rel(subpath)
        if subpath is None:
            return False, "Invalid path."
        if not subpath:
            return False, "Cannot lock the root folder."
        if not password:
            return False, "Password cannot be empty."
        try:
            if not os.path.isdir(self._validate_subpath(subpath)):
                return False, "Folder not found."
        except ValueError:
            return False, "Invalid path."
        key = f"folder:{subpath}"
        password_hash = self.ph.hash(password)
        self.metadata[key] = {'locked': True, 'password_hash': password_hash}
        self._save_metadata()
        return True, f"Folder '{subpath}' locked."

    def unlock_folder(self, subpath, password):
        """Unlock a folder by verifying its password."""
        subpath = self.normalize_rel(subpath)
        if subpath is None:
            return False, "Invalid path."
        if not subpath:
            return False, "Root folder is always unlocked."
        if not password:
            return False, "Password cannot be empty."
        key = f"folder:{subpath}"
        if key not in self.metadata:
            return False, "Folder was not locked."
        if not self.verify_folder_password(subpath, password):
            return False, "Incorrect password."
        del self.metadata[key]
        self._save_metadata()
        return True, f"Folder '{subpath}' unlocked."

    def remove_folder_lock(self, subpath):
        """Remove a folder's lock without password verification (admin action)."""
        subpath = self.normalize_rel(subpath)
        if subpath is None:
            return False, "Invalid path."
        if not subpath:
            return False, "Root folder is always unlocked."
        key = f"folder:{subpath}"
        if key not in self.metadata:
            return False, "Folder was not locked."
        del self.metadata[key]
        self._save_metadata()
        return True, f"Lock removed from folder '{subpath}'."

    def verify_folder_password(self, subpath, password):
        """Verify a folder's lock password."""
        subpath = self.normalize_rel(subpath)
        if not subpath:
            return False
        key = f"folder:{subpath}"
        if key not in self.metadata:
            return False
        password_hash = self.metadata[key].get('password_hash')
        if not password_hash:
            return False
        try:
            self.ph.verify(password_hash, password)
            return True
        except VerifyMismatchError:
            return False
        except Exception as e:
            logging.error(f"Error during folder password verification for {subpath}: {e}")
            return False

    def zip_selected_files(self, filenames, remote_addr, subpath='', unlocked_files=(), unlocked_folders=()):
        """Zip the selected items. Locked files/folders (and anything inside them) are left out
        unless the caller has unlocked them."""
        memory_file, skipped_files = self._new_zip_buffer(), []
        ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
        try:
            target_dir = self._validate_subpath(subpath)
        except ValueError:
            return self._new_zip_buffer(), filenames
        base_rel = self.normalize_rel(subpath) or ''
        with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for filename in filenames:
                name = self._clean_name(filename)
                full_path = os.path.join(target_dir, name) if name else None
                rel = f"{base_rel}/{name}" if base_rel else name
                if not name or os.path.islink(full_path) or not self._is_within(full_path):
                    skipped_files.append(filename)
                elif os.path.isfile(full_path):
                    if self.can_access(rel, unlocked_files, unlocked_folders):
                        zipf.write(full_path, arcname=name)
                    else:
                        skipped_files.append(filename)
                elif os.path.isdir(full_path):
                    if self.can_access(rel, unlocked_files, unlocked_folders, is_folder=True):
                        self._zip_dir(zipf, full_path, rel, name, unlocked_files, unlocked_folders)
                    else:
                        skipped_files.append(filename)
                else:
                    skipped_files.append(filename)
        memory_file.seek(0)
        return memory_file, skipped_files

    def _zip_dir(self, zipf, dir_full, dir_rel, arc_root, unlocked_files, unlocked_folders):
        """Add a directory tree to `zipf` under `arc_root`, pruning locked folders and files."""
        for dirpath, dirnames, filenames in os.walk(dir_full):
            rel_dir = dir_rel + '/' + os.path.relpath(dirpath, dir_full).replace(os.sep, '/')
            rel_dir = dir_rel if rel_dir.endswith('/.') else rel_dir
            dirnames[:] = [d for d in dirnames
                           if not os.path.islink(os.path.join(dirpath, d))
                           and self.can_access(f"{rel_dir}/{d}", unlocked_files, unlocked_folders, is_folder=True)]
            for f in filenames:
                if f.startswith('.') and f.endswith('.part'):   # an upload still in progress
                    continue
                file_full = os.path.join(dirpath, f)
                if os.path.islink(file_full) or not self.can_access(f"{rel_dir}/{f}", unlocked_files, unlocked_folders):
                    continue
                zipf.write(file_full, arcname=os.path.join(arc_root, os.path.relpath(file_full, dir_full)))

    def zip_folder(self, subpath, folder_name, remote_addr, unlocked_files=(), unlocked_folders=()):
        """Recursively zip a folder and return a seekable file object. Locked content is left out
        unless the caller has unlocked it."""
        safe_name = self._clean_name(folder_name)
        if not safe_name:
            return None, "Invalid folder name."
        try:
            target_dir = self._validate_subpath(subpath)
        except ValueError:
            return None, "Invalid path."
        folder_path = os.path.join(target_dir, safe_name)
        if not os.path.isdir(folder_path):
            return None, "Folder not found."
        if not self._is_within(folder_path):
            return None, "Access denied."
        base_rel = self.normalize_rel(subpath) or ''
        folder_rel = f"{base_rel}/{safe_name}" if base_rel else safe_name
        if not self.can_access(folder_rel, unlocked_files, unlocked_folders, is_folder=True):
            return None, "This folder is locked."
        memory_file = self._new_zip_buffer()
        try:
            with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zipf:
                self._zip_dir(zipf, folder_path, folder_rel, safe_name, unlocked_files, unlocked_folders)
            memory_file.seek(0)
            return memory_file, None
        except Exception as e:
            memory_file.close()
            logging.error(f"Error zipping folder {folder_path}: {e}")
            return None, "An unexpected server error occurred."

    def delete_file(self, filepath, remote_addr):
        """Delete a file. filepath is relative to files_folder (e.g. 'subfolder/file.txt')."""
        self._size_cache.clear()
        filepath = self.normalize_rel(filepath)
        if not filepath: return False, "Access denied."
        file_path = os.path.join(self.files_folder, *filepath.split('/'))
        if not self._is_within(file_path):
            return False, "Access denied."
        if not os.path.isfile(file_path): return False, "File not found."
        try:
            os.remove(file_path)
            self._drop_metadata_prefix(filepath)
            ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
            log_history("File Deleted", f"'{escape(filepath)}' by [{ip_color}]{remote_addr}[/]")
            return True, f"File '{filepath}' was successfully deleted."
        except Exception as e:
            logging.error(f"Error while deleting file {file_path} by {remote_addr}: {e}")
            return False, "An unexpected server error occurred."

    def rename_file(self, subpath, old_name, new_name, remote_addr):
        """Rename a file within the given subpath."""
        self._size_cache.clear()
        safe_new_name = self._clean_name(new_name)
        if not safe_new_name:
            return False, "Invalid new filename."
        try:
            target_dir = self._validate_subpath(subpath)
        except ValueError:
            return False, "Invalid path."
        old_path = os.path.join(target_dir, old_name)
        if not os.path.isfile(old_path):
            return False, "File not found."
        if not self._is_within(old_path):
            return False, "Access denied."
        # Preserve extension if not provided in the new name
        _, old_ext = os.path.splitext(old_name)
        _, new_ext = os.path.splitext(safe_new_name)
        if old_ext and not new_ext:
            safe_new_name += old_ext
        new_path = os.path.join(target_dir, safe_new_name)
        if os.path.exists(new_path):
            return False, f"A file named '{safe_new_name}' already exists."
        try:
            os.rename(old_path, new_path)
            # Update metadata (lock info)
            old_rel = f"{subpath}/{old_name}" if subpath else old_name
            new_rel = f"{subpath}/{safe_new_name}" if subpath else safe_new_name
            if old_rel in self.metadata:
                self.metadata[new_rel] = self.metadata.pop(old_rel)
                self._save_metadata()
            ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
            log_history("File Renamed", f"'{escape(old_rel)}' -> '{escape(new_rel)}' by [{ip_color}]{remote_addr}[/]")
            return True, f"File renamed to '{safe_new_name}'."
        except Exception as e:
            logging.error(f"Error renaming file {old_path} to {new_path}: {e}")
            return False, "An unexpected server error occurred."

    def rename_folder(self, subpath, old_name, new_name, remote_addr):
        """Rename a folder within the given subpath."""
        self._size_cache.clear()
        safe_old = self._clean_name(old_name)
        safe_new = self._clean_name(new_name)
        if not safe_old or not safe_new:
            return False, "Invalid folder name."
        try:
            target_dir = self._validate_subpath(subpath)
        except ValueError:
            return False, "Invalid path."
        old_path = os.path.join(target_dir, safe_old)
        if not os.path.isdir(old_path):
            return False, "Folder not found."
        if not self._is_within(old_path):
            return False, "Access denied."
        new_path = os.path.join(target_dir, safe_new)
        if os.path.exists(new_path):
            return False, f"A folder named '{safe_new}' already exists."
        try:
            os.rename(old_path, new_path)
            # Update metadata keys for all items inside the folder
            old_prefix = f"{subpath}/{safe_old}" if subpath else safe_old
            new_prefix = f"{subpath}/{safe_new}" if subpath else safe_new
            self._move_metadata_prefix(old_prefix, new_prefix)
            ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
            log_history("Folder Renamed", f"'{escape(old_prefix)}' -> '{escape(new_prefix)}' by [{ip_color}]{remote_addr}[/]")
            return True, f"Folder renamed to '{safe_new}'."
        except Exception as e:
            logging.error(f"Error renaming folder {old_path} to {new_path}: {e}")
            return False, "An unexpected server error occurred."

    def create_folder(self, subpath, folder_name, remote_addr):
        """Create a new folder inside the given subpath."""
        safe_name = self._clean_name(folder_name)
        if not safe_name:
            return False, "Invalid folder name."
        try:
            target_dir = self._validate_subpath(subpath)
        except ValueError:
            return False, "Invalid path."
        new_folder_path = os.path.join(target_dir, safe_name)
        if not self._is_within(new_folder_path):
            return False, "Access denied."
        if os.path.exists(new_folder_path):
            return False, f"A folder named '{safe_name}' already exists."
        try:
            os.makedirs(new_folder_path)
            ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
            display_path = f"{subpath}/{safe_name}" if subpath else safe_name
            log_history("Folder Created", f"'{escape(display_path)}' by [{ip_color}]{remote_addr}[/]")
            return True, f"Folder '{safe_name}' created successfully."
        except Exception as e:
            logging.error(f"Error creating folder {new_folder_path}: {e}")
            return False, "An unexpected server error occurred."

    def create_folder_unique(self, subpath, folder_name, remote_addr, quiet=False):
        """Create a folder, or 'Name (1)', 'Name (2)'... if that name is taken (used for folder uploads, which
        must never merge into an existing folder). Returns (actual_name, message) or (None, error)."""
        safe_name = self._clean_name(folder_name)
        if not safe_name:
            return None, "Invalid folder name."
        try:
            target_dir = self._validate_subpath(subpath)
        except ValueError:
            return None, "Invalid path."
        if not os.path.isdir(target_dir):
            return None, "Destination folder does not exist."
        for counter in range(10000):
            candidate = safe_name if counter == 0 else f"{safe_name} ({counter})"
            path = os.path.join(target_dir, candidate)
            if not self._is_within(path):
                return None, "Access denied."
            try:
                os.mkdir(path)   # atomic: fails if the name is taken, so two uploads can never share a folder
            except FileExistsError:
                continue
            except OSError as e:
                logging.error(f"Error creating folder {path}: {e}")
                return None, "An unexpected server error occurred."
            self._size_cache.clear()
            if not quiet:
                ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
                display_path = f"{subpath}/{candidate}" if subpath else candidate
                log_history("Folder Created", f"'{escape(display_path)}' by [{ip_color}]{remote_addr}[/]")
            return candidate, f"Folder '{candidate}' created successfully."
        return None, "Could not find a free folder name."

    def delete_folder(self, subpath, folder_name, remote_addr):
        """Recursively delete a folder. Admin only."""
        self._size_cache.clear()
        safe_name = self._clean_name(folder_name)
        if not safe_name:
            return False, "Invalid folder name."
        try:
            target_dir = self._validate_subpath(subpath)
        except ValueError:
            return False, "Invalid path."
        folder_path = os.path.join(target_dir, safe_name)
        if not self._is_within(folder_path):
            return False, "Access denied."
        if not os.path.isdir(folder_path):
            return False, "Folder not found."
        try:
            shutil.rmtree(folder_path)
            self._drop_metadata_prefix(f"{subpath}/{safe_name}" if subpath else safe_name)
            ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
            display_path = f"{subpath}/{safe_name}" if subpath else safe_name
            log_history("Folder Deleted", f"'{escape(display_path)}' by [{ip_color}]{remote_addr}[/]")
            return True, f"Folder '{safe_name}' deleted successfully."
        except Exception as e:
            logging.error(f"Error deleting folder {folder_path}: {e}")
            return False, "An unexpected server error occurred."
        
    MAX_PREVIEW_BYTES = 20 * 1024 * 1024

    def get_image_preview_b64(self, filepath):
        """filepath is relative to files_folder (e.g. 'subfolder/image.png')."""
        filepath = self.normalize_rel(filepath)
        if not filepath: return None
        _, extension = os.path.splitext(filepath)
        if extension.lower() not in self.supported_image_extensions: return None
        file_path = os.path.join(self.files_folder, *filepath.split('/'))
        if not self._is_within(file_path): return None
        if not os.path.isfile(file_path) or os.path.getsize(file_path) > self.MAX_PREVIEW_BYTES: return None
        try:
            with open(file_path, "rb") as image_file:
                encoded_string = base64.b64encode(image_file.read()).decode('utf-8')
            mime_type = f"image/{extension.lower().lstrip('.').replace('jpg', 'jpeg')}"
            if extension.lower() == '.svg': mime_type = 'image/svg+xml'
            return f"data:{mime_type};base64,{encoded_string}"
        except Exception as e:
            logging.error(f"Could not read and encode image file for preview '{file_path}': {e}")
            return None

    # --- Share Link Methods ---
    def create_share_link(self, filepath, expiry_hours=None):
        """Create a shareable link for a file or folder. Returns (token, error_string or None)."""
        filepath = self.normalize_rel(filepath)
        if not filepath:
            return None, "Access denied."
        full_path = os.path.join(self.files_folder, *filepath.split('/'))
        if not self._is_within(full_path):
            return None, "Access denied."
        if os.path.isfile(full_path):
            link_type = 'file'
        elif os.path.isdir(full_path):
            link_type = 'folder'
        else:
            return None, "File or folder not found."
        token = uuid.uuid4().hex + uuid.uuid4().hex[:8]
        link_data = {
            'filepath': filepath,
            'type': link_type,
            'created': time.time()
        }
        if expiry_hours and expiry_hours > 0:
            link_data['expires'] = time.time() + (expiry_hours * 3600)
        self.share_links[token] = link_data
        self._save_share_links()
        return token, None

    def resolve_share_link(self, token):
        """Resolve a share token to a filepath. Returns filepath or None."""
        self.cleanup_expired_links()
        link_data = self.share_links.get(token)
        if not link_data:
            return None
        filepath = self.normalize_rel(link_data.get('filepath'))
        if not filepath:
            return None
        full_path = os.path.join(self.files_folder, *filepath.split('/'))
        if not self._is_within(full_path) or not os.path.exists(full_path):
            return None
        return filepath

    def cleanup_expired_links(self):
        """Remove expired share links."""
        now = time.time()
        expired = [t for t, d in self.share_links.items() if d.get('expires') and d['expires'] < now]
        if expired:
            for token in expired:
                del self.share_links[token]
            self._save_share_links()

    # --- Favorites Methods ---
    def is_favorite(self, filepath):
        """Check if a file or folder is favorited."""
        meta = self.metadata.get(self.normalize_rel(filepath) or filepath, {})
        if isinstance(meta, dict):
            return meta.get('favorite', False)
        return False

    def toggle_favorite(self, filepath):
        """Toggle the favorite status of a file or folder. Returns new state."""
        filepath = self.normalize_rel(filepath)
        if not filepath:
            return False
        if filepath not in self.metadata:
            self.metadata[filepath] = {}
        elif not isinstance(self.metadata[filepath], dict):
            # Legacy format (was just a lock hash string), wrap it
            self.metadata[filepath] = {'lock_hash': self.metadata[filepath]}
        current = self.metadata[filepath].get('favorite', False)
        self.metadata[filepath]['favorite'] = not current
        self._save_metadata()
        return not current
