from flask import (Blueprint, Response, render_template, request, flash, redirect,
                   url_for, session, jsonify, current_app)
import logging
import os
from urllib.parse import urlparse, urljoin
from functools import wraps
from backbone.rate_limiter import RateLimiter
from backbone.storage import atomic_write_json, load_json
from .utils import get_local_ip, get_current_ssid

admin_bp = Blueprint('admin', __name__,
                     template_folder='../templates/admin',
                     url_prefix='/admin')

# 5 wrong logins from one IP within 10 minutes locks that IP out of the login for 5 minutes
login_limiter = RateLimiter(max_attempts=5, window=600, lockout=300)

# Managers will be initialized by the main app
user_manager, socketio, blocklist_manager, action_logger, notes_manager, content_manager = None, None, None, None, None, None

def init_admin_routes(um, sio, blm, al, nm, cm=None):
    """Initialize the blueprint with managers from the main app."""
    global user_manager, socketio, blocklist_manager, action_logger, notes_manager, content_manager
    user_manager, socketio, blocklist_manager, action_logger, notes_manager, content_manager = um, sio, blm, al, nm, cm

def is_safe_url(target):
    ref_url = urlparse(request.host_url)
    test_url = urlparse(urljoin(request.host_url, target))
    return test_url.scheme in ('http', 'https') and ref_url.netloc == test_url.netloc

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'admin_logged_in' not in session:
            return redirect(url_for('admin.login', next=request.path))
        return f(*args, **kwargs)
    return decorated_function

@admin_bp.after_request
def add_no_cache_headers(response):
    if request.endpoint and 'admin.' in request.endpoint and request.endpoint != 'admin.login':
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response

@admin_bp.route('/')
@admin_bp.route('/monitoring')
@login_required
def monitoring():
    return render_template('dashboard.html', server_ip=get_local_ip(), current_ssid=get_current_ssid())

@admin_bp.route('/notes')
@login_required
def notes():
    return render_template('admin/notes.html', server_ip=get_local_ip(), current_ssid=get_current_ssid())

@admin_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        wait = login_limiter.retry_after(request.remote_addr)
        if wait:
            flash(f'Too many failed attempts. Try again in {wait} seconds.', 'error')
            return render_template('login.html'), 429
        username, password = request.form.get('username'), request.form.get('password')
        if user_manager and user_manager.verify_password(username, password):
            login_limiter.reset(request.remote_addr)
            next_url = request.args.get('next')
            session.clear()  # fresh session on privilege change (prevents session fixation)
            session['admin_logged_in'] = True
            session.permanent = True
            flash('You were successfully logged in.', 'success')
            return redirect(next_url) if next_url and is_safe_url(next_url) else redirect(url_for('admin.monitoring'))
        else:
            login_limiter.record_failure(request.remote_addr)
            flash('Invalid username or password.', 'error')
            return redirect(url_for('admin.login'))
    return render_template('login.html')

@admin_bp.route('/logout')
@login_required
def logout():
    session.clear()
    flash('You have been logged out.', 'info')
    return redirect(url_for('main.index'))

@admin_bp.route('/api/block_ip', methods=['POST'])
@login_required
def block_ip():
    ip_to_block = (request.get_json(silent=True) or {}).get('ip')
    if not ip_to_block: return jsonify(success=False, error="IP address is required."), 400
    if ip_to_block == request.remote_addr: return jsonify(success=False, error="You cannot block your own IP address."), 400
    success, message = blocklist_manager.block_ip(ip_to_block)
    if success:
        action_logger.log(request.remote_addr, 'IP_BLOCK', {'target_ip': ip_to_block})
        socketio.emit('update_blocklist', {'blocklist': blocklist_manager.get_blocklist()}, room='admin_room')
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 400

@admin_bp.route('/api/unblock_ip', methods=['POST'])
@login_required
def unblock_ip():
    ip_to_unblock = (request.get_json(silent=True) or {}).get('ip')
    if not ip_to_unblock: return jsonify(success=False, error="IP address is required."), 400
    success, message = blocklist_manager.unblock_ip(ip_to_unblock)
    if success:
        action_logger.log(request.remote_addr, 'IP_UNBLOCK', {'target_ip': ip_to_unblock})
        socketio.emit('update_blocklist', {'blocklist': blocklist_manager.get_blocklist()}, room='admin_room')
        return jsonify(success=True, message=message)
    return jsonify(success=False, error=message), 404

@admin_bp.route('/api/logs')
@login_required
def get_logs():
    limit = min(max(request.args.get('limit', 50, type=int), 1), 500)   # bound the work one request can ask for
    offset = request.args.get('offset', type=int)
    if offset is not None:
        page = (max(offset, 0) // limit) + 1
    else:
        page = max(request.args.get('page', 1, type=int), 1)
    logs, has_more = action_logger.get_logs(page=page, limit=limit)
    return jsonify(success=True, logs=logs, has_more=has_more)

@admin_bp.route('/api/clients')
@login_required
def get_clients():
    """Get list of currently connected clients."""
    clients = []
    if socketio and hasattr(socketio, 'active_clients'):
        for sid, client_data in socketio.active_clients.items():
            clients.append({
                'ip': client_data.get('ip', 'Unknown'),
                'connected_since': client_data.get('connected_since', '')
            })
    return jsonify(success=True, clients=clients)

@admin_bp.route('/api/blocklist')
@login_required
def get_blocklist():
    """Get list of blocked IP addresses."""
    blocked_ips = blocklist_manager.get_blocklist() if blocklist_manager else []
    return jsonify(success=True, blocked_ips=blocked_ips)

@admin_bp.route('/api/stats')
@login_required
def get_stats():
    """Get dashboard statistics (kept in memory by the logger - no file scan per request)."""
    stats = action_logger.get_stats() if action_logger else {'total_logs': 0, 'unique_ips': 0, 'recent_activity': 0}
    return jsonify(success=True, stats=stats)

@admin_bp.route('/api/clear_logs', methods=['POST'])
@login_required
def clear_logs():
    """Clear all action logs."""
    if action_logger and hasattr(action_logger, 'clear_logs'):
        action_logger.clear_logs()
        return jsonify(success=True, message='Logs cleared successfully')
    return jsonify(success=False, error='Unable to clear logs'), 500

@admin_bp.route('/api/buffer_history')
@login_required
def get_buffer_history():
    """Get buffer chat history."""
    if content_manager:
        history = content_manager.get_buffer_history()
        return jsonify(success=True, history=history)
    return jsonify(success=True, history=[])

@admin_bp.route('/api/buffer_history/clear', methods=['POST'])
@login_required
def clear_buffer_history():
    """Clear all buffer chat history."""
    if content_manager:
        content_manager.clear_buffer_history()
        return jsonify(success=True, message='Buffer history cleared successfully')
    return jsonify(success=False, error='Unable to clear history'), 500

def _notes_ui_path():
    return os.path.join(current_app.instance_path, 'notes_ui.json')

@admin_bp.route('/api/notes/tree', methods=['GET'])
@login_required
def get_notes_tree():
    tree = notes_manager.get_tree()
    # which folders the admin has closed, so the tree looks the same after a reload or a restart
    state = load_json(_notes_ui_path(), {}, dict, 'notes tree state')
    collapsed = [p for p in state.get('collapsed', []) if isinstance(p, str)] if isinstance(state.get('collapsed'), list) else []
    return jsonify(success=True, tree=tree, collapsed=collapsed)

@admin_bp.route('/api/notes/ui', methods=['POST'])
@login_required
def save_notes_ui_state():
    data = request.get_json(silent=True) or {}
    collapsed = data.get('collapsed')
    if not isinstance(collapsed, list):
        return jsonify(success=False, error="A list of folders is required."), 400
    clean = sorted({p for p in collapsed if isinstance(p, str) and 0 < len(p) <= 500})[:2000]
    try:
        atomic_write_json(_notes_ui_path(), {'collapsed': clean})
    except OSError as e:
        logging.error(f"Could not save the notes tree state: {e}")
        return jsonify(success=False, error="Could not save."), 500
    return jsonify(success=True)

@admin_bp.route('/api/notes/note', methods=['GET', 'POST'])
@login_required
def handle_note():
    if request.method == 'GET':
        note_path = request.args.get('path')
        if not note_path:
            return jsonify(success=False, error="Note path is required."), 400
        content, error = notes_manager.get_note_content(note_path)
        if error:
            return jsonify(success=False, error=error), 404
        return jsonify(success=True, content=content)
    
    if request.method == 'POST':
        data = request.get_json(silent=True) or {}
        note_path = data.get('path')
        content = data.get('content')
        if not note_path or content is None:
            return jsonify(success=False, error="Path and content are required."), 400
        success, message = notes_manager.save_note_content(note_path, content)
        if not success:
            return jsonify(success=False, error=message), 500
        action_logger.log(request.remote_addr, 'NOTE_SAVE', {'path': note_path})
        return jsonify(success=True, message=message)

@admin_bp.route('/api/notes/item', methods=['POST', 'DELETE', 'PUT'])
@login_required
def handle_item():
    data = request.get_json(silent=True) or {}
    
    if request.method == 'PUT':
        old_path = data.get('old_path')
        new_name = data.get('new_name')
        if not old_path or not new_name:
            return jsonify(success=False, error="Old path and new name are required."), 400
        success, message = notes_manager.rename_item(old_path, new_name)
        if not success:
            return jsonify(success=False, error=message), 500
        action_logger.log(request.remote_addr, 'NOTE_RENAME', {'from': old_path, 'to': new_name})
        return jsonify(success=True, message=message)

    item_path = data.get('path')
    if not item_path:
        return jsonify(success=False, error="Item path is required."), 400
        
    if request.method == 'POST':
        item_type = data.get('type', 'file')
        success, message = notes_manager.create_item(item_path, item_type)
        if not success:
            return jsonify(success=False, error=message), 409
        action_logger.log(request.remote_addr, 'NOTE_CREATE', {'path': item_path, 'type': item_type})
        return jsonify(success=True, message=message)

    if request.method == 'DELETE':
        success, message = notes_manager.delete_item(item_path)
        if not success:
            return jsonify(success=False, error=message), 500
        action_logger.log(request.remote_addr, 'NOTE_DELETE', {'path': item_path})
        return jsonify(success=True, message=message)
        
    return jsonify(success=False, error="Method not implemented."), 501

@admin_bp.route('/api/notes/move', methods=['POST'])
@login_required
def move_note_item():
    data = request.get_json(silent=True) or {}
    source_path = data.get('source_path')
    dest_path = data.get('dest_path')
    if not source_path or dest_path is None:
        return jsonify(success=False, error="Source and destination paths are required."), 400
    success, message = notes_manager.move_item(source_path, dest_path)
    if not success:
        return jsonify(success=False, error=message), 500
    action_logger.log(request.remote_addr, 'NOTE_MOVE', {'from': source_path, 'to': dest_path})
    return jsonify(success=True, message=message)

@admin_bp.route('/api/notes/delete_batch', methods=['DELETE'])
@login_required
def delete_batch():
    data = request.get_json(silent=True) or {}
    paths = data.get('paths', [])
    if not paths:
        return jsonify(success=False, error="No paths provided."), 400
    
    results = []
    for path in paths:
        success, message = notes_manager.delete_item(path)
        results.append({'path': path, 'success': success, 'message': message})
        if success:
            action_logger.log(request.remote_addr, 'NOTE_DELETE_BATCH', {'path': path})
    
    return jsonify(success=True, results=results)

@admin_bp.route('/api/notes/download', methods=['GET'])
@login_required
def download_notes():
    paths = request.args.getlist('paths')
    if not paths:
        return jsonify(success=False, error="No paths provided."), 400
    
    try:
        zip_data = notes_manager.zip_items(paths)
    except Exception as e:
        logging.error(f"Error creating notes ZIP: {e}")
        return jsonify(success=False, error="Could not create ZIP."), 500
    if zip_data.getbuffer().nbytes <= 22:  # a ZIP with no entries is just the 22-byte end record
        return jsonify(success=False, error="Nothing to download."), 404
    
    action_logger.log(request.remote_addr, 'NOTE_DOWNLOAD', {'paths': paths})
    return Response(
        zip_data.getvalue(),
        mimetype='application/zip',
        headers={'Content-Disposition': 'attachment; filename=notes.zip'}
    )