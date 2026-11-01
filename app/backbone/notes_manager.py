# backbone/notes_manager.py
import os
import io
import shutil
import zipfile
import logging
from pathlib import Path

class NotesManager:
    """Handles all file system operations for the Notes feature."""
    def __init__(self, notes_root_path):
        self.root_path = Path(notes_root_path)
        self.root_path.mkdir(parents=True, exist_ok=True)

    def _is_safe_path(self, path):
        """Prevents directory traversal: the resolved path must be the notes root or inside it."""
        base = os.path.realpath(self.root_path)
        try:
            return os.path.commonpath([base, os.path.realpath(path)]) == base
        except ValueError:
            return False

    def get_tree(self):
        """Recursively scans the notes directory to build a file tree."""
        items = []
        for item in sorted(self.root_path.iterdir()):
            if not item.name.startswith('.'): # Ignore hidden files
                items.append(self._get_item_details(item))
        return items

    def _get_item_details(self, item_path):
        """Helper to get details for a single file or folder."""
        # Normalize path separators to forward slashes for consistency across platforms
        rel_path = str(item_path.relative_to(self.root_path)).replace('\\', '/')
        details = {
            "name": item_path.name,
            "path": rel_path,
            "type": "folder" if item_path.is_dir() else "file"
        }
        if item_path.is_dir():
            details["children"] = [
                self._get_item_details(child)
                for child in sorted(item_path.iterdir()) if not child.name.startswith('.')
            ]
        return details

    def get_note_content(self, relative_path):
        """Reads the content of a note file."""
        full_path = self.root_path / relative_path
        if not self._is_safe_path(full_path) or not full_path.is_file():
            return None, "File not found or access denied."
        try:
            return full_path.read_text(encoding='utf-8'), None
        except Exception as e:
            logging.error(f"Error reading note {full_path}: {e}")
            return None, "Could not read file."

    def save_note_content(self, relative_path, content):
        """Saves content to a note file."""
        full_path = self.root_path / relative_path
        if not self._is_safe_path(full_path):
            return False, "Access denied."
        try:
            full_path.write_text(content, encoding='utf-8')
            return True, "Note saved."
        except Exception as e:
            logging.error(f"Error saving note {full_path}: {e}")
            return False, "Could not save note."

    def create_item(self, relative_path, item_type):
        """Creates a new note (file) or folder."""
        full_path = self.root_path / relative_path
        if not self._is_safe_path(full_path) or full_path.exists():
            return False, "Item already exists or path is invalid."
        try:
            if item_type == 'folder':
                full_path.mkdir()
            else: # file
                full_path.touch()
            return True, "Item created successfully."
        except Exception as e:
            logging.error(f"Error creating item {full_path}: {e}")
            return False, "Could not create item."

    def move_item(self, source_rel_path, dest_dir_rel_path):
        """Moves a file or folder to a new directory."""
        source_full_path = self.root_path / source_rel_path
        # Accept empty string or '.' as root directory
        dest_dir_full_path = self.root_path if dest_dir_rel_path in (".", "") else self.root_path / dest_dir_rel_path

        if not self._is_safe_path(source_full_path) or not source_full_path.exists():
            return False, "Source item does not exist."
        if not self._is_safe_path(dest_dir_full_path) or not dest_dir_full_path.is_dir():
            return False, "Destination is not a valid folder."

        if source_full_path.is_dir() and dest_dir_full_path.is_relative_to(source_full_path):
             return False, "Cannot move a folder into itself."

        new_path = dest_dir_full_path / source_full_path.name
        if new_path.exists():
            return False, f"An item named '{source_full_path.name}' already exists in the destination."

        try:
            shutil.move(str(source_full_path), str(dest_dir_full_path))
            return True, "Item moved successfully."
        except Exception as e:
            logging.error(f"Error moving {source_full_path} to {dest_dir_full_path}: {e}")
            return False, "Could not move the item."

    def rename_item(self, old_relative_path, new_name):
        """Renames a file or folder."""
        import re
        if not new_name or re.search(r'[\\/:*?"<>|]', new_name):
                return False, "New name contains invalid characters."
    
        old_full_path = self.root_path / old_relative_path
        if not self._is_safe_path(old_full_path) or not old_full_path.exists():
            return False, "Source item not found."

        new_full_path = old_full_path.parent / new_name
        if not self._is_safe_path(new_full_path) or new_full_path.exists():
            return False, "New name is invalid or already exists."
        
        try:
            old_full_path.rename(new_full_path)
            return True, "Item renamed successfully."
        except Exception as e:
            logging.error(f"Error renaming {old_full_path} to {new_full_path}: {e}")
            return False, "Could not rename the item."
            
    # --- MODIFIED: The zipping logic is now smarter ---
    def zip_items(self, relative_paths):
        """
        Zips a list of files and folders into a memory buffer, avoiding duplication
        of items inside an already-included folder.
        """
        # 1. Convert string paths to resolved Path objects for reliable comparison.
        full_paths = []
        for p in set(relative_paths): # Use set to remove duplicate paths from frontend
            full_p = (self.root_path / p).resolve()
            if self._is_safe_path(full_p) and full_p.exists():
                full_paths.append(full_p)

        # 2. Identify the top-level paths to be zipped.
        #    An item is top-level if it's not a child of another item in the list.
        top_level_paths = []
        for path_to_check in full_paths:
            is_subpath = False
            for potential_parent in full_paths:
                if path_to_check != potential_parent:
                    try:
                        # is_relative_to() checks if path_to_check is inside potential_parent
                        if path_to_check.is_relative_to(potential_parent):
                            is_subpath = True
                            break
                    except ValueError:
                        # This occurs if paths are not related (e.g., C:\ and D:\), safe to ignore
                        continue
            if not is_subpath:
                top_level_paths.append(path_to_check)
        
        # 3. Zip the filtered, top-level paths.
        memory_file = io.BytesIO()
        with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for full_path in top_level_paths:
                if full_path.is_file():
                    # For top-level files, arcname is just the file's name.
                    zipf.write(full_path, arcname=full_path.name)
                elif full_path.is_dir():
                    # For directories, walk them and preserve their structure relative to
                    # the notes root directory, so the folder itself is included.
                    for root, _, files in os.walk(full_path):
                        for file in files:
                            file_path = Path(root) / file
                            arcname = file_path.relative_to(self.root_path)
                            zipf.write(file_path, arcname=arcname)
        
        memory_file.seek(0)
        return memory_file

    def delete_item(self, relative_path):
        """Deletes a note or folder."""
        full_path = self.root_path / relative_path
        if not self._is_safe_path(full_path) or not full_path.exists():
            return False, "Item not found."
        if os.path.realpath(full_path) == os.path.realpath(self.root_path):
            return False, "Cannot delete the notes root."
        try:
            if full_path.is_dir():
                shutil.rmtree(full_path)
            else:
                full_path.unlink()
            return True, "Item deleted."
        except Exception as e:
            logging.error(f"Error deleting item {full_path}: {e}")
            return False, "Could not delete item."