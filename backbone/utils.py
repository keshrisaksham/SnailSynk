# backbone/utils.py
import logging

try:
    import pyperclip
    PYCLIP_AVAILABLE = True
except ImportError:
    PYCLIP_AVAILABLE = False

history_logger = logging.getLogger('history')
last_log_action = None

def format_size(num_bytes):
    """12345678 -> '11.8 MB' (None/unknown -> 'unknown size')."""
    if num_bytes is None:
        return "unknown size"
    n = float(num_bytes)
    if n < 1024:
        return f"{int(n)} B"
    for unit in ("KB", "MB", "GB", "TB"):
        n /= 1024
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if n < 100 else f"{n:.0f} {unit}"

# Actions that belong together: no divider line is printed between the start and the end of one transfer.
ACTION_GROUPS = {
    "Upload Started": "upload", "File Uploaded": "upload", "Upload Failed": "upload", "Upload Interrupted": "upload",
    "Folder Upload Started": "upload", "Folder Uploaded": "upload", "Folder Upload Failed": "upload", "Folder Upload Interrupted": "upload",
    "Download Started": "download", "Download Finished": "download", "Download Interrupted": "download",
}

def log_history(action, details):
    """
    Logs an action to the terminal history, adding a divider
    only when the action type changes.
    """
    global last_log_action
    
    action_colors = {
        "Upload Started": "yellow",
        "File Uploaded": "green",
        "Upload Failed": "red",
        "Folder Upload Started": "yellow",
        "Folder Uploaded": "green",
        "Folder Upload Failed": "red",
        "Folder Upload Interrupted": "red",
        "Upload Interrupted": "red",
        "Download Started": "yellow",
        "Download Finished": "green",
        "Download Interrupted": "red",
        "File Downloaded": "cyan",
        "Files Downloaded": "cyan",
        "File Deleted": "red",
        "Page Accessed": "magenta",
        "Client Connected": "bright_blue",
        "Buffer Cleared": "yellow",
        "Buffer Updated": "yellow",
        "Message Pinned": "blue",
        "Message Unpinned": "red",
        "IP Blocked": "red",
        "IP Unblocked": "green",
    }
    action_color = action_colors.get(action, "white")

    group = ACTION_GROUPS.get(action, action)
    if group != last_log_action:
        if last_log_action is not None:
            history_logger.info("[dim]----------------------------------------------------[/dim]")
        last_log_action = group
        
    action_str = f"[{action_color}]{action}:[/]".ljust(32)
    log_message = f"{action_str} {details}"
    history_logger.info(log_message)