import gevent.monkey
gevent.monkey.patch_all()

import os
import sys
import time
import secrets
import logging
from pathlib import Path
from datetime import timedelta
from porter import Porter

# --- Third-Party Imports ---
from dotenv import load_dotenv
from flask import Flask, request, session, render_template, jsonify, make_response
from werkzeug.exceptions import HTTPException, ClientDisconnected
from werkzeug.http import parse_options_header
from flask_socketio import SocketIO
from werkzeug.middleware.proxy_fix import ProxyFix
from rich.console import Console
from rich.panel import Panel
from rich.text import Text
from rich.logging import RichHandler
from rich.rule import Rule  
from rich.markup import escape

# --- Application Imports ---
from backbone import (FileManager, ContentManager, UserManager, BlocklistManager, 
                      ActionLogger, log_history, format_size, PYCLIP_AVAILABLE, NotesManager)

from routes import admin_bp, main_bp, ai_chat_bp
from routes.routes_admin import init_admin_routes
from routes.routes_index import init_index_routes, register_socketio_events
from routes.routes_ai_chat import init_ai_chat_routes
from routes.utils import get_local_ip
from routes.ssl_utils import ensure_ssl_cert

# --- Initial Setup ---
load_dotenv()
console = Console()
# Route normal logging through Rich too, so warnings/errors match the rest of the console output.
logging.basicConfig(
    level=logging.INFO, format="%(message)s",
    handlers=[RichHandler(console=console, show_path=False, show_level=True, show_time=True, markup=False)],
    force=True,
)
logging.getLogger('werkzeug').setLevel(logging.WARNING)
# gevent logs every single HTTP request (each CSS/JS file, every Socket.IO poll) at INFO, which buries
# the useful "Application Log". Pages and actions are already reported by log_history(); set
# SNAILSYNK_ACCESS_LOG=1 to bring the raw per-request log back for debugging.
if os.environ.get('SNAILSYNK_ACCESS_LOG') != '1':
    logging.getLogger('geventwebsocket.handler').setLevel(logging.WARNING)

# --- Suppress SSL Handshake Noise ---
# A self-signed certificate makes browsers abort TLS handshakes, and gevent would print a traceback
# for each one. Tell gevent's hub that SSL errors are not worth reporting. This is narrower and
# safer than rewriting sys.stderr: every other exception still prints normally.
import ssl as _ssl
import gevent as _gevent
_hub = _gevent.get_hub()
_hub.NOT_ERROR = tuple(_hub.NOT_ERROR) + (_ssl.SSLError,)
history_logger = logging.getLogger('history')
history_logger.setLevel(logging.INFO)
history_logger.addHandler(RichHandler(console=console, show_path=False, show_level=False, show_time=True, markup=True))
history_logger.propagate = False

# --- Directory and Path Setup ---
APP_DIR_NAME = "SnailSynk"
FILES_SUBDIR_NAME = "files"
try:
    downloads_dir = Path.home() / "Downloads"
    files_folder_path = downloads_dir / APP_DIR_NAME / FILES_SUBDIR_NAME
    files_folder_path.mkdir(parents=True, exist_ok=True)
except Exception as e:
    console.log(f"[bold red]FATAL: Could not create app directory: {e}[/bold red]")
    sys.exit(1)

# --- App Configuration & Initialization ---
app = Flask(__name__, instance_relative_config=True)

def load_secret_key(instance_path):
    """Session signing key: FLASK_SECRET_KEY if set, otherwise one generated once and kept in
    instance/secret_key (owner-only), so admin sessions survive restarts."""
    env_key = os.environ.get('FLASK_SECRET_KEY')
    if env_key:
        return env_key
    key_path = Path(instance_path) / 'secret_key'
    try:
        if key_path.exists():
            key = key_path.read_text().strip()
            if key:
                return key
        key_path.parent.mkdir(parents=True, exist_ok=True)
        key = secrets.token_hex(32)
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(key)
        return key
    except OSError as e:
        console.log(f"[yellow]Could not persist session key ({e}); sessions will reset on restart.[/yellow]")
        return secrets.token_hex(32)

app.secret_key = load_secret_key(app.instance_path)
app.config['FILES_FOLDER'] = str(files_folder_path)
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=1)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=True,   # the server always speaks HTTPS
)
# Only trust X-Forwarded-* headers when explicitly running behind a reverse proxy. Trusting them
# by default lets any client spoof its IP (e.g. as 127.0.0.1) and walk around the IP blocklist.
if os.environ.get('SNAILSYNK_BEHIND_PROXY') == '1':
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
# No wildcard CORS: Socket.IO accepts same-origin pages only, so other websites cannot drive it.
socketio = SocketIO(app)
socketio.active_clients = {}

# --- Initialize Managers ---
file_manager = FileManager(app.config['FILES_FOLDER'], app.instance_path)
content_manager = ContentManager(app.instance_path)
user_manager = UserManager(os.path.join(app.instance_path, 'user.json'))
blocklist_manager = BlocklistManager(os.path.join(app.instance_path, 'blocklist.json'))
action_logger = ActionLogger(os.path.join(app.instance_path, 'actions.jsonl'), socketio=socketio)
notes_manager = NotesManager(os.path.join(app.instance_path, 'notes'))

# Migrate old log entries from 'ip' to 'ip_address' field
migrated_count = action_logger.migrate_old_logs()
if migrated_count > 0:
    console.log(f"[bold green]Migrated {migrated_count} log entries to new format[/bold green]")

# --- Initialize and Register Blueprints ---
init_admin_routes(user_manager, socketio, blocklist_manager, action_logger, notes_manager, content_manager)
init_index_routes(file_manager, content_manager, action_logger, socketio)
init_ai_chat_routes(action_logger, app.instance_path)

app.register_blueprint(admin_bp)
app.register_blueprint(main_bp)
app.register_blueprint(ai_chat_bp)

# --- Register SocketIO Events ---
register_socketio_events(socketio)

# --- App-level Request Hooks ---
@app.before_request
def before_request_handler():
    # Blocklist Check
    if not request.path.startswith('/static') and request.remote_addr != '127.0.0.1':
        if blocklist_manager.is_blocked(request.remote_addr):
            return render_template('error.html', error_code=403, error_title="Forbidden", error_description="Your IP address has been banned by the administrator."), 403
    
    remote_ip = request.remote_addr
    ip_color = "yellow" if remote_ip != "127.0.0.1" else "cyan"

    # First half of the upload pair: announced as soon as the request arrives (the file data is still
    # streaming in), the second half is "File Uploaded" / "Upload Failed" once it has been saved.
    if request.method == 'POST' and request.path == '/upload':
        if request.headers.get('X-Snail-Folder-Upload'):
            return   # one batch of a folder upload: reported as a whole by /api/upload/folder/start|finish
        log_history("Upload Started", f"{format_size(request.content_length)} incoming from [{ip_color}]{remote_ip}[/]")
        return

    # Page Access Logging
    ignored_paths = ('/static/', '/api/', '/favicon.ico', '/socket.io/', '/admin/api/')
    if request.path.startswith(ignored_paths): return
    # File downloads announce themselves ("Download Started/Finished"), so skip the redundant page line
    if not (request.path.startswith('/files/') or request.path == '/download_selected'):
        log_history("Page Accessed", f"from [{ip_color}]{remote_ip}[/] -> {request.path}")
    action_logger.log(remote_ip, 'PAGE_VIEW', {'path': request.path})

class _TransferTracker:
    """Wraps a download's body so we can report how it ended. It counts the bytes actually handed to the
    client: reaching the end means "finished"; being closed before that (browser cancelled, connection
    lost) means "interrupted"."""
    def __init__(self, inner, name, total, ip):
        self._inner, self._it = inner, iter(inner)
        self.name, self.total, self.ip = name, total, ip
        self.sent, self._done, self._started = 0, False, time.monotonic()

    def __iter__(self):
        return self

    def __next__(self):
        try:
            chunk = next(self._it)
        except StopIteration:
            self._finish(True)
            raise
        self.sent += len(chunk)
        return chunk

    def close(self):
        self._finish(False)
        if hasattr(self._inner, 'close'):
            self._inner.close()

    def _finish(self, completed):
        if self._done:
            return
        self._done = True
        color = "yellow" if self.ip != "127.0.0.1" else "cyan"
        if completed:
            log_history("Download Finished", f"'{escape(self.name)}' ({format_size(self.sent)}) in {time.monotonic() - self._started:.1f}s to [{color}]{self.ip}[/]")
        else:
            of = f" of {format_size(self.total)}" if self.total else ""
            log_history("Download Interrupted", f"'{escape(self.name)}' after {format_size(self.sent)}{of} to [{color}]{self.ip}[/]")

@app.after_request
def track_downloads(response):
    """Second pair of terminal messages: "Download Started" when a file/zip begins streaming to a client
    and "Download Finished" / "Download Interrupted" when it ends. Anything sent as an attachment counts."""
    if response.status_code not in (200, 206):
        return response
    disposition, params = parse_options_header(response.headers.get('Content-Disposition', ''))
    if disposition != 'attachment' or request.method == 'HEAD':
        return response
    name = params.get('filename') or request.path
    total = response.content_length
    if total is None:
        # Zips are built in a temp file; Flask doesn't know its size, so the browser would get no progress bar.
        # The file is complete at this point, so read the size from it and send a real Content-Length.
        try:
            body_file = response.response.file
            total = os.fstat(body_file.fileno()).st_size - body_file.tell()
            response.content_length = total
        except (AttributeError, OSError, ValueError):
            total = None
    ip = request.remote_addr
    color = "yellow" if ip != "127.0.0.1" else "cyan"
    size_text = f" ({format_size(total)})" if total is not None else ""
    log_history("Download Started", f"'{escape(name)}'{size_text} to [{color}]{ip}[/]")
    response.response = _TransferTracker(response.response, name, total, ip)
    return response

@app.after_request
def add_security_headers(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    response.headers.setdefault('Referrer-Policy', 'same-origin')
    return response

# --- Centralized Error Handling ---
ERROR_DETAILS = {
    400: ("Bad Request", "The request could not be understood by the server."),
    403: ("Forbidden", "You do not have permission to access this page. Please check your credentials."),
    404: ("Page Not Found", "The page you are looking for does not exist. It might have been moved or deleted."),
    405: ("Method Not Allowed", "This page does not support that action."),
    413: ("Too Large", "The request was too large for the server to accept."),
    429: ("Too Many Requests", "You are doing that too often. Please wait a moment and try again."),
    500: ("Internal Server Error", "Something went wrong on our end. We are working to fix the issue."),
}

def _wants_json():
    """API callers (the page's fetch() calls) parse JSON; give them JSON errors, not an HTML page."""
    return request.path.startswith(('/api/', '/admin/api/')) or request.is_json

def _render_error(code):
    title, description = ERROR_DETAILS.get(code, ERROR_DETAILS[500])
    if _wants_json():
        return jsonify(success=False, error=description), code
    return render_template('error.html', error_code=code, error_title=title, error_description=description), code

def _error_response(code, close_connection=False):
    """Build the error response. `close_connection` adds 'Connection: close' (gevent honours it): after an
    error the request body may be only half-read, and on a kept-alive connection the server would parse the
    leftover upload bytes as the next request ("Invalid http version: <garbage>")."""
    response = make_response(*_render_error(code))
    if close_connection:
        response.headers['Connection'] = 'close'
    return response

def _is_client_disconnect(e):
    """True when the browser simply went away mid-request (cancelled/closed an upload, lost Wi-Fi...)."""
    if isinstance(e, (ClientDisconnected, ConnectionError, TimeoutError, _ssl.SSLError)):   # ConnectionError: BrokenPipe, Reset, Aborted
        return True
    return isinstance(e, OSError) and 'unexpected end of file while reading request' in str(e)

def _log_client_disconnect():
    if request.method == 'POST' and request.path == '/upload':
        color = "yellow" if request.remote_addr != "127.0.0.1" else "cyan"
        log_history("Upload Interrupted", f"from [{color}]{request.remote_addr}[/] - the connection closed part-way through")
        return
    logging.warning("%s %s from %s was interrupted: the client closed the connection part-way through.",
                    request.method, request.path, request.remote_addr)

@app.errorhandler(HTTPException)
def handle_http_error(e):
    if isinstance(e, ClientDisconnected):   # werkzeug's own "client went away while we read the body"
        _log_client_disconnect()
        return _error_response(400, close_connection=True)
    return _error_response(e.code or 500)

@app.errorhandler(Exception)
def handle_unexpected_error(e):
    if _is_client_disconnect(e):
        # Not a server bug, so no scary traceback - one line is enough. The client is gone; just close up.
        _log_client_disconnect()
        return _error_response(400, close_connection=True)
    logging.exception("Unhandled exception while serving %s %s", request.method, request.path)
    return _error_response(500, close_connection=True)

# --- Main Execution ---
if __name__ == '__main__':
    APP_PORT = int(os.environ.get('SNAILSYNK_PORT', 9000))
    local_ip = get_local_ip()
    
    # Generate or load SSL certificate
    certfile, keyfile = ensure_ssl_cert(app.instance_path)
    
    clipboard_status = (
        Text("Enabled", style="bold green") if PYCLIP_AVAILABLE 
        else Text("Disabled (pyperclip not installed)", style="bold yellow")
    )
    
    info_text = Text(justify="center")
    info_text.append("© 2026 YawnByte. All rights reserved.\n", style="bright_black")
    info_text.append("Clipboard Support: ", style="default")
    info_text.append(clipboard_status)
    info_text.append("\n")
    info_text.append("HTTPS: ", style="default")
    info_text.append("Enabled (Self-Signed)", style="bold green")

    panel_content = f"""
[bold]Access from this computer:[/] [cyan]https://localhost:{APP_PORT}[/]
[bold]Access from other devices:[/] [cyan]https://{local_ip}:{APP_PORT}[/]
    """

    console.print(Panel(info_text, title="[bold #946eeA]SnailSynk[/]", subtitle="[#9e82b4]v2.0[/]", border_style="magenta"))
    
    access_text = f"""
[bold]SECURE ACCESS (HTTPS):[/]
    Local:   [cyan]https://localhost:{APP_PORT}[/]
    Network: [cyan]https://{local_ip}:{APP_PORT}[/]

[bold]AUTO-REDIRECT (HTTP → HTTPS):[/]
    Local:   [yellow]http://localhost:{APP_PORT}[/] → https://localhost:{APP_PORT}
    Network: [yellow]http://{local_ip}:{APP_PORT}[/] → https://{local_ip}:{APP_PORT}
    """
    console.print(Panel(access_text.strip(), title="[bold #62A0EA]Access Points[/]", border_style="blue"))
    console.print(Rule("[bold white]Application Log[/]", style="white"))


    # --- Start Server with HTTP→HTTPS auto-redirect on same port ---
    porter = Porter(certfile, keyfile, APP_PORT)
    porter.activate()
    socketio.run(app, host='0.0.0.0', port=APP_PORT, certfile=certfile, keyfile=keyfile)