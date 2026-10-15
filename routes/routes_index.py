# routes/routes-index.py
import os
import re
import logging
from flask import (Blueprint, request, redirect, url_for, render_template,
                   send_from_directory, send_file, flash, jsonify, Response, session, abort)
from flask_socketio import emit, join_room
from datetime import datetime, timezone

from qr_gen import generate_custom_qr_svg, QR_SHAPES
from backbone.rate_limiter import RateLimiter
from backbone.utils import log_history, format_size
from rich.markup import escape
from .utils import get_local_ip, get_current_ssid

main_bp = Blueprint('main', __name__, template_folder='../templates')

# Managers will be initialized by the main app
file_manager, content_manager, action_logger, socketio = None, None, None, None

# Brute-force protection for file/folder password prompts (per client IP)
unlock_limiter = RateLimiter(max_attempts=8, window=600, lockout=300)

MAX_SHARED_TEXT = 1_000_000   # characters
MAX_PIN_TEXT = 100_000
HEX_COLOR_RE = re.compile(r'^#[0-9a-fA-F]{3,8}$')

def init_index_routes(fm, cm, al, sio):
    """Initialize the blueprint with managers from the main app."""
    global file_manager, content_manager, action_logger, socketio
    file_manager, content_manager, action_logger, socketio = fm, cm, al, sio

def _unlocked():
    """(unlocked_files, unlocked_folders) this browser session has opened with a password."""
    return session.get('unlocked_files', []), session.get('unlocked_folders', [])

def _can_read(rel_path, is_folder=False):
    uf, ufo = _unlocked()
    return file_manager.can_access(rel_path, uf, ufo, is_folder=is_folder)

def _throttled():
    """JSON 429 response if this client is locked out of password attempts, else None."""
    wait = unlock_limiter.retry_after(request.remote_addr)
    if wait:
        return jsonify(success=False, error=f"Too many failed attempts. Try again in {wait} seconds."), 429
    return None

def _emit_file_list(path=''):
    """Broadcast a folder listing to clients - but never the contents of a locked folder."""
    if file_manager.is_any_parent_locked(path):
        return
    socketio.emit('file_list_updated', {'files': file_manager.list_files(path), 'path': path})

def _json_body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}

@main_bp.route('/')
def index():
    try: files = file_manager.list_files()
    except Exception:
        files = []
        flash("Error listing files. Check server logs for details.", "error")
    is_admin = session.get('admin_logged_in', False)
    return render_template('index.html', files=files, server_ip=get_local_ip(), current_ssid=get_current_ssid(), is_admin=is_admin)

FOLDER_UPLOAD_HEADER = 'X-Snail-Folder-Upload'   # set by the page on every batch of a folder upload

def _client_color():
    return "yellow" if request.remote_addr != "127.0.0.1" else "cyan"

@main_bp.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files or not request.files.getlist('file'):
        return jsonify(success=False, error="No file part in the request."), 400

    uploaded_files = request.files.getlist('file')
    subpath = request.form.get('subpath', '')
    # Folder uploads send the path of each file inside the folder, in the same order as the files
    relpaths = request.form.getlist('relpaths') or None
    in_folder_upload = bool(request.headers.get(FOLDER_UPLOAD_HEADER))
    is_admin = session.get('admin_logged_in', False)
    success_msgs, error_msgs = file_manager.save_uploaded_files(
        uploaded_files, request.remote_addr, subpath=subpath, is_admin=is_admin,
        relpaths=relpaths, quiet=in_folder_upload)
    if error_msgs and not in_folder_upload:   # folder uploads report once, at the end (/api/upload/folder/finish)
        log_history("Upload Failed", f"{escape(' '.join(error_msgs))} (from [{_client_color()}]{request.remote_addr}[/])")

    if success_msgs:
        names = [f.filename for f in uploaded_files if f.filename]
        action_logger.log(request.remote_addr, 'FILE_UPLOAD', {'files': names[:20] + (['...'] if len(names) > 20 else []), 'count': len(names), 'path': subpath})
        # After a successful upload, broadcast for the uploaded path
        try:
            _emit_file_list(file_manager.normalize_rel(subpath) or '')
        except Exception as e:
            logging.error(f"Failed to get updated file list after upload: {e}")

    return jsonify(success=True, messages={'success': success_msgs, 'error': error_msgs})

@main_bp.route('/api/upload/folder/start', methods=['POST'])
def folder_upload_start():
    """First half of a folder upload: create the (uniquely named) destination folder and announce the upload.
    The page then sends the files in batches and closes with /api/upload/folder/finish."""
    data = _json_body()
    subpath = file_manager.normalize_rel(data.get('path', ''))
    name = str(data.get('name', '')).strip()
    if subpath is None:
        return jsonify(success=False, error="Invalid path."), 400
    if not name:
        return jsonify(success=False, error="Folder name is required."), 400
    if not session.get('admin_logged_in') and file_manager.is_any_parent_locked(subpath):
        return jsonify(success=False, error="This folder is locked. Only admins can upload here."), 403
    created, message = file_manager.create_folder_unique(subpath, name, request.remote_addr, quiet=True)
    if not created:
        return jsonify(success=False, error=message), 400
    try:
        count, total = max(int(data.get('files', 0)), 0), max(int(data.get('bytes', 0)), 0)
    except (TypeError, ValueError):
        count, total = 0, 0
    log_history("Folder Upload Started", f"'{escape(created)}' ({count:,} files, {format_size(total)}) from [{_client_color()}]{request.remote_addr}[/]")
    try:
        _emit_file_list(subpath)
    except Exception as e:
        logging.error(f"Failed to broadcast after folder upload start: {e}")
    return jsonify(success=True, name=created, path=f"{subpath}/{created}" if subpath else created)

@main_bp.route('/api/upload/folder/finish', methods=['POST'])
def folder_upload_finish():
    """Second half: report how the folder upload ended (the numbers come from the page, for the log only)."""
    data = _json_body()
    subpath = file_manager.normalize_rel(data.get('path', '')) or ''
    name = str(data.get('name', ''))[:255]
    def num(key):
        try: return max(int(data.get(key, 0)), 0)
        except (TypeError, ValueError): return 0
    uploaded, failed, total = num('uploaded'), num('failed'), num('bytes')
    seconds = min(float(data.get('seconds', 0) or 0), 10 ** 7) if str(data.get('seconds', 0)).replace('.', '', 1).isdigit() else 0
    outcome = data.get('outcome')
    who = f"[{_client_color()}]{request.remote_addr}[/]"
    shown = escape(name)
    if outcome == 'cancelled':
        log_history("Folder Upload Interrupted", f"'{shown}' stopped after {uploaded:,} files ({format_size(total)}) from {who}")
    elif outcome == 'error' or failed:
        log_history("Folder Upload Failed", f"'{shown}': {uploaded:,} files uploaded, {failed:,} failed from {who}")
    else:
        log_history("Folder Uploaded", f"'{shown}' - {uploaded:,} files ({format_size(total)}) in {seconds:.1f}s from {who}")
    action_logger.log(request.remote_addr, 'FOLDER_UPLOAD', {'name': name, 'path': subpath, 'uploaded': uploaded, 'failed': failed, 'outcome': outcome or 'done'})
    try:
        _emit_file_list(subpath)
        if subpath and name:
            _emit_file_list(f"{subpath}/{name}")
    except Exception as e:
        logging.error(f"Failed to broadcast after folder upload: {e}")
    return jsonify(success=True)

@main_bp.route('/files/<path:filename>', methods=['GET'])
def download_file(filename):
    # Flask has already URL-decoded the path; decoding again would let '%252e' style tricks
    # make the checked name differ from the served name.
    rel = file_manager.normalize_rel(filename)
    if not rel:
        return jsonify(success=False, error="Invalid path."), 400
    if not _can_read(rel):
        return jsonify(success=False, error="This file (or its folder) is locked. Enter the password to download.", is_locked=True), 403
    action_logger.log(request.remote_addr, 'FILE_DOWNLOAD', {'file': rel})
    return send_from_directory(file_manager.files_folder, rel, as_attachment=True)

@main_bp.route('/delete/<path:filename>', methods=['DELETE'])
def delete_file(filename):
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    decoded_filename = file_manager.normalize_rel(filename) or ''
    # Determine the parent subpath for broadcasting
    parts = decoded_filename.replace('\\', '/').rsplit('/', 1)
    subpath = parts[0] if len(parts) > 1 else ''
    success, message = file_manager.delete_file(decoded_filename, request.remote_addr)
    if success:
        action_logger.log(request.remote_addr, 'FILE_DELETE', {'file': decoded_filename})
        try:
            _emit_file_list(subpath)
        except Exception as e:
            logging.error(f"Failed to get updated file list after delete: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 404

@main_bp.route('/download_selected', methods=['POST'])
def download_selected_files():
    selected_filenames = request.form.getlist('selected_files')
    subpath = file_manager.normalize_rel(request.form.get('subpath', ''))
    if subpath is None:
        flash("Invalid folder.", "error")
        return redirect(url_for('.index'))
    if not selected_filenames:
        flash("No files selected for download.", "warning")
        return redirect(url_for('.index'))
    if not _can_read(subpath, is_folder=True):
        flash("This folder is locked. You cannot download its contents.", "error")
        return redirect(url_for('.index'))
    unlocked_files, unlocked_folders = _unlocked()
    try:
        memory_file, skipped = file_manager.zip_selected_files(
            selected_filenames, request.remote_addr, subpath=subpath,
            unlocked_files=unlocked_files, unlocked_folders=unlocked_folders)
        if len(skipped) == len(selected_filenames):
            flash("None of the selected items could be downloaded (missing or locked).", "error")
            return redirect(url_for('.index'))
        action_logger.log(request.remote_addr, 'FILES_DOWNLOAD_ZIP', {'files': selected_filenames, 'skipped': skipped})
        memory_file.seek(0)
        return send_file(memory_file, mimetype='application/zip', as_attachment=True, download_name='SnailSynk_Selected_Files.zip')
    except Exception as e:
        logging.error(f"Error creating ZIP for download: {e}")
        flash("An error occurred while creating the download.", "error")
        return redirect(url_for('.index'))

@main_bp.route('/api/files/lock_batch', methods=['POST'])
def lock_batch_files():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    
    data = request.get_json()
    filenames = data.get('filenames', [])
    password = data.get('password')
    subpath = data.get('subpath', '')

    if not isinstance(filenames, list) or not password:
        return jsonify(success=False, error="Invalid request data."), 400

    locked_files, failed_files = [], []
    for filename in filenames:
        # Determine if file or folder
        try:
            target_dir = file_manager._validate_subpath(subpath)
        except ValueError:
            failed_files.append(filename)
            continue
        full_path = os.path.join(target_dir, filename)
        if os.path.isdir(full_path):
            folder_subpath = f"{subpath}/{filename}" if subpath else filename
            success, _ = file_manager.lock_folder(folder_subpath, password)
        else:
            rel_path = f"{subpath}/{filename}" if subpath else filename
            success, _ = file_manager.lock_file(rel_path, password)
        if success:
            locked_files.append(filename)
        else:
            failed_files.append(filename)
    
    if locked_files:
        action_logger.log(request.remote_addr, 'FILES_LOCK_BATCH', {'files': locked_files})
        try:
            _emit_file_list(subpath)
        except Exception as e:
            logging.error(f"Failed to get updated file list after batch lock: {e}")

    return jsonify(
        success=True, 
        message="Batch lock operation complete.",
        details={'locked': locked_files, 'failed': failed_files}
    )

@main_bp.route('/api/files/delete_batch', methods=['DELETE'])
def delete_batch_files():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403

    data = request.get_json()
    filenames = data.get('filenames', [])
    subpath = data.get('subpath', '')

    if not isinstance(filenames, list):
        return jsonify(success=False, error="Invalid request data."), 400

    deleted_files, failed_files = [], []
    for filename in filenames:
        try:
            target_dir = file_manager._validate_subpath(subpath)
        except ValueError:
            failed_files.append(filename)
            continue
        full_path = os.path.join(target_dir, filename)
        if os.path.isdir(full_path):
            success, _ = file_manager.delete_folder(subpath, filename, request.remote_addr)
        else:
            rel_path = f"{subpath}/{filename}" if subpath else filename
            success, _ = file_manager.delete_file(rel_path, request.remote_addr)
        if success:
            deleted_files.append(filename)
        else:
            failed_files.append(filename)

    if deleted_files:
        action_logger.log(request.remote_addr, 'FILES_DELETE_BATCH', {'files': deleted_files})
        try:
            _emit_file_list(subpath)
        except Exception as e:
            logging.error(f"Failed to get updated file list after batch delete: {e}")

    return jsonify(
        success=True, 
        message="Batch delete operation complete.",
        details={'deleted': deleted_files, 'failed': failed_files}
    )

@main_bp.route('/api/files/unlock_batch', methods=['POST'])
def unlock_batch_files():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    
    data = request.get_json()
    filenames = data.get('filenames', [])
    password = data.get('password')
    subpath = data.get('subpath', '')

    if not isinstance(filenames, list) or password is None:
        return jsonify(success=False, error="Invalid request data."), 400

    unlocked_files, failed_files = [], []
    for filename in filenames:
        try:
            target_dir = file_manager._validate_subpath(subpath)
        except ValueError:
            failed_files.append(filename)
            continue
        full_path = os.path.join(target_dir, filename)
        if os.path.isdir(full_path):
            folder_subpath = f"{subpath}/{filename}" if subpath else filename
            success, _ = file_manager.unlock_folder(folder_subpath, password)
        else:
            rel_path = f"{subpath}/{filename}" if subpath else filename
            if file_manager.verify_file_password(rel_path, password):
                success, _ = file_manager.unlock_file(rel_path)
            else:
                success = False
        if success:
            unlocked_files.append(filename)
        else:
            failed_files.append(filename)
    
    if unlocked_files:
        action_logger.log(request.remote_addr, 'FILES_UNLOCK_BATCH', {'files': unlocked_files})
        try:
            _emit_file_list(subpath)
        except Exception as e:
            logging.error(f"Failed to get updated file list after batch unlock: {e}")

    return jsonify(
        success=True, 
        message="Batch unlock operation complete.",
        details={'unlocked': unlocked_files, 'failed': failed_files}
    )

@main_bp.route('/api/files/move_batch', methods=['POST'])
def move_batch_files():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403

    data = request.get_json()
    filenames = data.get('filenames', [])
    source_path = data.get('source_path', '')
    dest_path = data.get('dest_path', '')

    if not isinstance(filenames, list) or dest_path is None:
        return jsonify(success=False, error="Invalid request data."), 400

    moved_files, failed_files = [], []
    for filename in filenames:
        try:
            source_dir = file_manager._validate_subpath(source_path)
            dest_dir = file_manager._validate_subpath(dest_path)
        except ValueError:
            failed_files.append({'file': filename, 'reason': 'Invalid path.'})
            continue
        source_item = os.path.join(source_dir, filename)
        if os.path.isdir(source_item):
            success, msg = file_manager.move_folder(filename, source_path, dest_path, request.remote_addr)
            if success:
                moved_files.append(filename)
            else:
                failed_files.append({'file': filename, 'reason': msg})
        else:
            success, msg = file_manager.move_file(filename, source_path, dest_path, request.remote_addr)
            if success:
                moved_files.append(filename)
            else:
                failed_files.append({'file': filename, 'reason': msg})

    if moved_files:
        action_logger.log(request.remote_addr, 'FILES_MOVE_BATCH', {'files': moved_files, 'from': source_path, 'to': dest_path})
        try:
            _emit_file_list(source_path)
            _emit_file_list(dest_path)
        except Exception as e:
            logging.error(f"Failed to broadcast after batch move: {e}")

    return jsonify(
        success=True,
        message="Batch move operation complete.",
        details={'moved': moved_files, 'failed': failed_files}
    )

# --- Folder Management API ---
@main_bp.route('/api/files/list', methods=['GET'])
def list_files_api():
    """AJAX endpoint to list files in a given subpath."""
    subpath = file_manager.normalize_rel(request.args.get('path', ''))
    if subpath is None:
        return jsonify(success=False, error="Invalid path."), 400
    # Block ALL users from browsing into locked folders (must unlock via password)
    if subpath and not _can_read(subpath, is_folder=True):
        return jsonify(success=False, error="This folder is locked. Enter the password to access it.", is_locked=True), 403
    try:
        files = file_manager.list_files(subpath)
        is_folder_locked = file_manager.is_folder_locked(subpath)
        return jsonify(success=True, files=files, path=subpath, is_folder_locked=is_folder_locked)
    except Exception as e:
        logging.error(f"Error listing files for path '{subpath}': {e}")
        return jsonify(success=False, error="Failed to list files."), 500

@main_bp.route('/api/folder/verify_password', methods=['POST'])
def verify_folder_password_api():
    """Verify a folder password and unlock it for this session."""
    blocked = _throttled()
    if blocked: return blocked
    data = _json_body()
    folder_path = file_manager.normalize_rel(data.get('path', ''))
    password = data.get('password', '')
    if not folder_path or not isinstance(password, str) or not password:
        return jsonify(success=False, error="Folder path and password are required."), 400
    if not file_manager.is_folder_locked(folder_path):
        return jsonify(success=False, error="This folder is not locked."), 400
    if file_manager.verify_folder_password(folder_path, password):
        unlock_limiter.reset(request.remote_addr)
        unlocked = session.get('unlocked_folders', [])
        if folder_path not in unlocked:
            unlocked.append(folder_path)
            session['unlocked_folders'] = unlocked
        return jsonify(success=True, message="Folder unlocked successfully.")
    unlock_limiter.record_failure(request.remote_addr)
    return jsonify(success=False, error="Incorrect password."), 403

@main_bp.route('/api/file/verify_password', methods=['POST'])
def verify_file_password_api():
    """Verify a file password and unlock it for this session."""
    blocked = _throttled()
    if blocked: return blocked
    data = _json_body()
    filepath = file_manager.normalize_rel(data.get('filepath', ''))
    password = data.get('password', '')
    if not filepath or not isinstance(password, str) or not password:
        return jsonify(success=False, error="File path and password are required."), 400
    if not file_manager.is_locked(filepath):
        return jsonify(success=False, error="This file is not locked."), 400
    if file_manager.verify_file_password(filepath, password):
        unlock_limiter.reset(request.remote_addr)
        unlocked = session.get('unlocked_files', [])
        if filepath not in unlocked:
            unlocked.append(filepath)
            session['unlocked_files'] = unlocked
        return jsonify(success=True, message="File unlocked successfully.")
    unlock_limiter.record_failure(request.remote_addr)
    return jsonify(success=False, error="Incorrect password."), 403

@main_bp.route('/api/file/move', methods=['POST'])
def move_file():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    data = request.get_json()
    if not data or 'filename' not in data or 'dest_path' not in data:
        return jsonify(success=False, error="Missing required fields."), 400
    filename = data['filename']
    source_path = data.get('source_path', '')
    dest_path = data['dest_path']
    success, message = file_manager.move_file(filename, source_path, dest_path, request.remote_addr)
    if success:
        action_logger.log(request.remote_addr, 'FILE_MOVE', {'file': filename, 'from': source_path, 'to': dest_path})
        # Broadcast updated file lists for both source and destination
        try:
            _emit_file_list(source_path)
            _emit_file_list(dest_path)
        except Exception as e:
            logging.error(f"Failed to broadcast after file move: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 400

@main_bp.route('/api/folders/list', methods=['GET'])
def list_all_folders():
    """Return all folder paths for the folder picker."""
    try:
        folders = file_manager.list_all_folders()
        return jsonify(success=True, folders=folders)
    except Exception as e:
        logging.error(f"Error listing all folders: {e}")
        return jsonify(success=False, error="Failed to list folders."), 500

@main_bp.route('/api/folder/lock', methods=['POST'])
def lock_folder():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    data = request.get_json()
    if not data or 'path' not in data or 'password' not in data:
        return jsonify(success=False, error="Folder path and password are required."), 400
    subpath = data['path']
    password = data['password']
    success, message = file_manager.lock_folder(subpath, password)
    if success:
        action_logger.log(request.remote_addr, 'FOLDER_LOCK', {'path': subpath})
        try:
            # Broadcast updated list for the parent folder
            parent = '/'.join(subpath.replace('\\', '/').split('/')[:-1])
            _emit_file_list(parent)
        except Exception as e:
            logging.error(f"Failed to broadcast after folder lock: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 400

@main_bp.route('/api/folder/unlock', methods=['POST'])
def unlock_folder():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    data = request.get_json()
    if not data or 'path' not in data or 'password' not in data:
        return jsonify(success=False, error="Folder path and password are required."), 400
    subpath = data['path']
    password = data['password']
    success, message = file_manager.unlock_folder(subpath, password)
    if success:
        action_logger.log(request.remote_addr, 'FOLDER_UNLOCK', {'path': subpath})
        try:
            parent = '/'.join(subpath.replace('\\', '/').split('/')[:-1])
            _emit_file_list(parent)
        except Exception as e:
            logging.error(f"Failed to broadcast after folder unlock: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 400

@main_bp.route('/api/folder/remove_lock', methods=['POST'])
def remove_folder_lock():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    data = request.get_json()
    if not data or 'path' not in data:
        return jsonify(success=False, error="Folder path is required."), 400
    subpath = data['path']
    success, message = file_manager.remove_folder_lock(subpath)
    if success:
        action_logger.log(request.remote_addr, 'FOLDER_LOCK_REMOVED', {'path': subpath})
        try:
            parent = '/'.join(subpath.replace('\\', '/').split('/')[:-1])
            _emit_file_list(parent)
        except Exception as e:
            logging.error(f"Failed to broadcast after folder lock removal: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 400

@main_bp.route('/api/folder/create', methods=['POST'])
def create_folder():
    data = request.get_json()
    if not data or 'name' not in data:
        return jsonify(success=False, error="Folder name is required."), 400
    subpath = file_manager.normalize_rel(data.get('path', ''))
    folder_name = str(data.get('name', '')).strip()
    if subpath is None:
        return jsonify(success=False, error="Invalid path."), 400
    if not folder_name:
        return jsonify(success=False, error="Folder name cannot be empty."), 400
    if not session.get('admin_logged_in') and file_manager.is_any_parent_locked(subpath):
        return jsonify(success=False, error="This folder is locked."), 403
    success, message = file_manager.create_folder(subpath, folder_name, request.remote_addr)
    if success:
        action_logger.log(request.remote_addr, 'FOLDER_CREATE', {'name': folder_name, 'path': subpath})
        try:
            _emit_file_list(subpath)
        except Exception as e:
            logging.error(f"Failed to broadcast after folder creation: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 400

@main_bp.route('/api/folder/delete', methods=['DELETE'])
def delete_folder():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    data = request.get_json()
    if not data or 'name' not in data:
        return jsonify(success=False, error="Folder name is required."), 400
    subpath = data.get('path', '')
    folder_name = data.get('name', '').strip()
    success, message = file_manager.delete_folder(subpath, folder_name, request.remote_addr)
    if success:
        action_logger.log(request.remote_addr, 'FOLDER_DELETE', {'name': folder_name, 'path': subpath})
        try:
            _emit_file_list(subpath)
        except Exception as e:
            logging.error(f"Failed to broadcast after folder deletion: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 400

@main_bp.route('/api/file/rename', methods=['POST'])
def rename_file():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    data = request.get_json()
    if not data or 'old_name' not in data or 'new_name' not in data:
        return jsonify(success=False, error="Missing required fields."), 400
    subpath = data.get('path', '')
    old_name = data['old_name']
    new_name = data['new_name'].strip()
    if not new_name:
        return jsonify(success=False, error="New name cannot be empty."), 400
    success, message = file_manager.rename_file(subpath, old_name, new_name, request.remote_addr)
    if success:
        action_logger.log(request.remote_addr, 'FILE_RENAME', {'old': old_name, 'new': new_name, 'path': subpath})
        try:
            _emit_file_list(subpath)
        except Exception as e:
            logging.error(f"Failed to broadcast after file rename: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 400

@main_bp.route('/api/folder/rename', methods=['POST'])
def rename_folder():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    data = request.get_json()
    if not data or 'old_name' not in data or 'new_name' not in data:
        return jsonify(success=False, error="Missing required fields."), 400
    subpath = data.get('path', '')
    old_name = data['old_name']
    new_name = data['new_name'].strip()
    if not new_name:
        return jsonify(success=False, error="New name cannot be empty."), 400
    success, message = file_manager.rename_folder(subpath, old_name, new_name, request.remote_addr)
    if success:
        action_logger.log(request.remote_addr, 'FOLDER_RENAME', {'old': old_name, 'new': new_name, 'path': subpath})
        try:
            _emit_file_list(subpath)
        except Exception as e:
            logging.error(f"Failed to broadcast after folder rename: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 400

@main_bp.route('/api/folder/download', methods=['POST'])
def download_folder_zip():
    data = _json_body()
    if 'folder_name' not in data:
        return jsonify(success=False, error="Missing folder name."), 400
    subpath = file_manager.normalize_rel(data.get('path', ''))
    folder_name = data['folder_name']
    if subpath is None:
        return jsonify(success=False, error="Invalid path."), 400
    unlocked_files, unlocked_folders = _unlocked()
    # Locked folders (and locked items inside) are excluded unless unlocked via password
    memory_file, error = file_manager.zip_folder(subpath, folder_name, request.remote_addr,
                                                 unlocked_files=unlocked_files, unlocked_folders=unlocked_folders)
    if error:
        return jsonify(success=False, error=error), 403 if 'locked' in error else 400
    action_logger.log(request.remote_addr, 'FOLDER_DOWNLOAD', {'folder': folder_name, 'path': subpath})
    return send_file(memory_file, mimetype='application/zip', as_attachment=True, download_name=f"{folder_name}.zip")

@main_bp.route('/api/file/share', methods=['POST'])
def create_share_link():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    data = request.get_json()
    if not data or 'filepath' not in data:
        return jsonify(success=False, error="Missing filepath."), 400
    filepath = data['filepath']
    expiry_hours = data.get('expiry_hours', None)
    if expiry_hours is not None:
        try:
            expiry_hours = float(expiry_hours)
        except (ValueError, TypeError):
            return jsonify(success=False, error="Invalid expiry value."), 400
    token, error = file_manager.create_share_link(filepath, expiry_hours)
    if error:
        return jsonify(success=False, error=error), 400
    action_logger.log(request.remote_addr, 'FILE_SHARE_LINK', {'file': filepath, 'expiry_hours': expiry_hours})
    
    # Construct full URL with IP address
    from .utils import get_local_ip
    local_ip = get_local_ip()
    port = os.environ.get('SNAILSYNK_PORT', 9000)
    share_url = f"https://{local_ip}:{port}/share/{token}"
    
    return jsonify(success=True, token=token, url=share_url)

@main_bp.route('/share/<token>', methods=['GET'])
def resolve_share_link(token):
    filepath = file_manager.resolve_share_link(token)
    if not filepath:
        flash("This share link is invalid or has expired.", "error")
        return redirect(url_for('.index'))
    link_type = file_manager.share_links.get(token, {}).get('type', 'file')
    # Anyone holding a link is anonymous: locked items (or items inside locked folders) are never served.
    if not file_manager.can_access(filepath, (), (), is_folder=(link_type == 'folder')):
        flash("This shared item is locked and cannot be accessed.", "error")
        return redirect(url_for('.index'))
    if link_type == 'folder':
        try:
            subpath, _, folder_name = filepath.rpartition('/')
            memory_file, zip_error = file_manager.zip_folder(subpath, folder_name, request.remote_addr)
            if zip_error:
                flash(f"Error: {zip_error}", "error")
                return redirect(url_for('.index'))
            memory_file.seek(0)
            return send_file(memory_file, mimetype='application/zip', as_attachment=True, download_name=f'{folder_name}.zip')
        except Exception as e:
            logging.error(f"Error serving shared folder: {e}")
            flash("An error occurred while preparing the shared folder.", "error")
            return redirect(url_for('.index'))
    return send_from_directory(file_manager.files_folder, filepath, as_attachment=True)

@main_bp.route('/api/file/favorite', methods=['POST'])
def toggle_favorite():
    if not session.get('admin_logged_in'):
        return jsonify(success=False, error="Authentication required."), 403
    data = request.get_json()
    if not data or 'filepath' not in data:
        return jsonify(success=False, error="Missing filepath."), 400
    filepath = data['filepath']
    subpath = data.get('path', '')
    new_state = file_manager.toggle_favorite(filepath)
    action_logger.log(request.remote_addr, 'FILE_FAVORITE', {'file': filepath, 'favorited': new_state})
    try:
        _emit_file_list(subpath)
    except Exception as e:
        logging.error(f"Failed to broadcast after favorite toggle: {e}")
    return jsonify(success=True, favorited=new_state)

# --- API and WebSocket Routes ---
def _wifi_escape(value):
    """Escape the characters that are special in the WIFI: QR payload format."""
    return re.sub(r'([\\;,:"])', r'\\\1', str(value))

@main_bp.route('/api/qr_code', methods=['POST'])
def generate_qr_code():
    data = _json_body()
    if 'type' not in data:
        return jsonify(success=False, error="Invalid request."), 400
    qr_type = data.get('type')
    logo_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'static', 'icon', 'favicon.png')
    qr_data_string = ""
    qr_color = data.get('color', '#dc2626')
    # The colour is written into SVG markup that the browser inserts as HTML - only allow a plain hex colour.
    if not isinstance(qr_color, str) or not HEX_COLOR_RE.match(qr_color):
        qr_color = '#dc2626'
    qr_bg = data.get('bg', '#ffffff')
    if not isinstance(qr_bg, str) or not HEX_COLOR_RE.match(qr_bg):
        qr_bg = '#ffffff'
    qr_shape = data.get('shape')
    if qr_shape not in QR_SHAPES:
        qr_shape = QR_SHAPES[0]

    if qr_type == 'ip':
        host_port = request.host.split(':')
        port = host_port[1] if len(host_port) > 1 and host_port[1].isdigit() else os.environ.get('SNAILSYNK_PORT', '9000')
        qr_data_string = f"https://{get_local_ip()}:{port}"
    elif qr_type == 'wifi':
        ssid, password = data.get('ssid'), data.get('password') or ''
        if not ssid or not isinstance(ssid, str) or not isinstance(password, str):
            return jsonify(success=False, error="SSID is required."), 400
        if len(ssid) > 64 or len(password) > 128:
            return jsonify(success=False, error="SSID or password too long."), 400
        auth = f"T:WPA;S:{_wifi_escape(ssid)};P:{_wifi_escape(password)};;" if password else f"T:nopass;S:{_wifi_escape(ssid)};;"
        qr_data_string = f"WIFI:{auth}"
    elif qr_type == 'upi': qr_data_string = "upi://pay?pa=kumarsaksham@yesg&pn=Saksham&cu=INR"
    elif qr_type == 'instagram': qr_data_string = "https://www.instagram.com/Sometimes.Saksham/"
    else: return jsonify(success=False, error="Invalid QR code type."), 400
    try:
        svg_code = generate_custom_qr_svg(qr_data_string, color=qr_color, bg=qr_bg, shape=qr_shape,
                                          logo_path=logo_path if os.path.exists(logo_path) else None)
        return jsonify(success=True, svg=svg_code)
    except Exception as e:
        logging.error(f"Failed to generate QR code for type '{qr_type}': {e}")
        return jsonify(success=False, error="Server failed to generate QR code."), 500

@main_bp.route('/preview/text')
def text_preview_page():
    """The shared text rendered as markdown in its own tab. The page itself decides what to show (a snapshot of
    the editor handed over by the button, or the live shared buffer), so the server only serves the shell."""
    return render_template('text_preview.html')

# Types that may be shown inline in a browser tab. Everything else is only ever offered as a download.
IMAGE_VIEW_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.svg': 'image/svg+xml',
}

@main_bp.route('/view/<path:filename>')
def view_image(filename):
    """Open an image in the browser (inline) instead of downloading it. Same lock rules as downloading."""
    rel = file_manager.normalize_rel(filename)
    mimetype = IMAGE_VIEW_TYPES.get(os.path.splitext(rel or '')[1].lower())
    if not rel or not mimetype:
        abort(404)
    if not _can_read(rel):
        abort(403)
    response = send_from_directory(file_manager.files_folder, rel, mimetype=mimetype,
                                   as_attachment=False, download_name=os.path.basename(rel))
    # An SVG opened directly is a live document, so it must not be able to run scripts on this site's origin
    # (this would otherwise let an uploaded SVG act as the logged-in admin). `sandbox` + no sources blocks that.
    response.headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"
    response.headers['Cache-Control'] = 'private, no-cache'
    action_logger.log(request.remote_addr, 'FILE_VIEW', {'file': rel})
    return response

@main_bp.route('/api/preview/<path:filename>')
def get_image_preview(filename):
    rel = file_manager.normalize_rel(filename)
    if not rel or not _can_read(rel):
        return jsonify(success=False, error="File is locked. Preview is unavailable."), 403
    b64_data = file_manager.get_image_preview_b64(rel)
    if b64_data: 
        return jsonify(success=True, data=b64_data)
    return jsonify(success=False, error="File is not a supported image or could not be found."), 404

@main_bp.route('/api/shared-text', methods=['GET', 'POST'])
def shared_text_api():
    if request.method == 'GET':
        return jsonify(success=True, text=content_manager.get_shared_text())
    data = _json_body()
    text = data.get('text')
    if not isinstance(text, str): return jsonify(success=False, error="Invalid request."), 400
    if len(text) > MAX_SHARED_TEXT: return jsonify(success=False, error="Text is too large."), 413
    updated_text = content_manager.update_shared_text(text, request.remote_addr)
    socketio.emit('text_updated', {'text': updated_text})
    action_logger.log(request.remote_addr, 'BUFFER_UPDATE', {'length': len(updated_text)})
    return jsonify(success=True, message="Shared text updated.")

@main_bp.route('/api/copy-text', methods=['POST'])
def copy_text_to_clipboard():
    success, message = content_manager.copy_buffer_to_clipboard()
    return jsonify(success=success, error=None if success else message), 200 if success else 500

@main_bp.route('/api/pins', methods=['POST'])
def add_pin():
    text_to_pin = _json_body().get('text', '')
    if not isinstance(text_to_pin, str): return jsonify(success=False, error="Invalid request."), 400
    if len(text_to_pin) > MAX_PIN_TEXT: return jsonify(success=False, error="Pinned text is too large."), 413
    updated_pins, error = content_manager.add_pin(text_to_pin, request.remote_addr)
    if error: return jsonify(success=False, error=error), 400
    socketio.emit('pins_updated', {'pins': updated_pins})
    return jsonify(success=True, pins=updated_pins)

@main_bp.route('/api/pins/<pin_id>', methods=['DELETE'])
def delete_pin(pin_id):
    updated_pins, error = content_manager.delete_pin(pin_id, request.remote_addr)
    if error: return jsonify(success=False, error=error), 404
    socketio.emit('pins_updated', {'pins': updated_pins})
    return jsonify(success=True, pins=updated_pins)

@main_bp.route('/api/pins/clear', methods=['DELETE'])
def clear_all_pins():
    updated_pins, error = content_manager.clear_all_pins(request.remote_addr)
    socketio.emit('pins_updated', {'pins': updated_pins})
    return jsonify(success=True, pins=updated_pins)

@main_bp.route('/api/file/status/<path:filename>')
def get_file_status(filename):
    return jsonify(locked=file_manager.is_locked(filename))

@main_bp.route('/api/file/lock/<path:filename>', methods=['POST'])
def lock_file(filename):
    if not session.get('admin_logged_in'): return jsonify(success=False, error="Authentication required."), 403
    password = _json_body().get('password')
    if not password or not isinstance(password, str): return jsonify(success=False, error="Password is required."), 400
    rel = file_manager.normalize_rel(filename)
    success, message = file_manager.lock_file(rel, password)
    if success:
        action_logger.log(request.remote_addr, 'FILE_LOCK', {'file': rel})
        try:
            _emit_file_list(rel.rpartition('/')[0])
        except Exception as e:
            logging.error(f"Failed to get updated file list after lock: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 400

@main_bp.route('/api/file/unlock/<path:filename>', methods=['POST'])
def unlock_file(filename):
    if not session.get('admin_logged_in'): return jsonify(success=False, error="Authentication required."), 403
    rel = file_manager.normalize_rel(filename)
    success, message = file_manager.unlock_file(rel)
    if success:
        action_logger.log(request.remote_addr, 'FILE_UNLOCK', {'file': rel})
        try:
            _emit_file_list(rel.rpartition('/')[0])
        except Exception as e:
            logging.error(f"Failed to get updated file list after unlock: {e}")
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 404

@main_bp.route('/api/file/download_locked/<path:filename>', methods=['POST'])
def download_locked_file(filename):
    blocked = _throttled()
    if blocked: return blocked
    password = _json_body().get('password')
    if not password or not isinstance(password, str): return jsonify(error="Password is required."), 400
    rel = file_manager.normalize_rel(filename)
    if not rel: return jsonify(error="Invalid path."), 400
    if not file_manager.is_locked(rel): return jsonify(error="File is no longer locked."), 409
    # A locked file inside a locked folder still needs the folder unlocked first
    if not file_manager.can_access(rel, [rel], session.get('unlocked_folders', [])):
        return jsonify(error="This file is inside a locked folder."), 403
    if file_manager.verify_file_password(rel, password):
        unlock_limiter.reset(request.remote_addr)
        action_logger.log(request.remote_addr, 'FILE_DOWNLOAD_UNLOCKED', {'file': rel})
        return send_from_directory(file_manager.files_folder, rel, as_attachment=True)
    unlock_limiter.record_failure(request.remote_addr)
    action_logger.log(request.remote_addr, 'FILE_DOWNLOAD_FAIL', {'file': rel})
    return jsonify(error="Incorrect password."), 403

def register_socketio_events(sio):
    @sio.on('connect')
    def handle_connect():
        remote_ip = request.remote_addr
        sio.active_clients[request.sid] = {
            'ip': remote_ip, 'connected_since': datetime.now(timezone.utc).isoformat()
        }
        emit('pins_updated', {'pins': content_manager.get_pins()})
        sio.emit('update_client_list', list(sio.active_clients.values()), room='admin_room')

    @sio.on('disconnect')
    def handle_disconnect():
        if request.sid in sio.active_clients:
            del sio.active_clients[request.sid]
            sio.emit('update_client_list', list(sio.active_clients.values()), room='admin_room')

    @sio.on('join_admin')
    def handle_join_admin_room():
        if session.get('admin_logged_in'):
            join_room('admin_room')
            emit('update_client_list', list(sio.active_clients.values()))