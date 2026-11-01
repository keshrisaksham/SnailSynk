# backbone/content_manager.py
import os
import uuid
import logging
from datetime import datetime, timezone
from .utils import log_history, PYCLIP_AVAILABLE
from .storage import atomic_write_json, load_json

if PYCLIP_AVAILABLE:
    import pyperclip

MAX_HISTORY_ENTRIES = 500

class ContentManager:
    """Manages all text content: the shared buffer, pinned messages, and buffer history.

    Everything is persisted under `state_dir` (the app's instance folder) so a restart does not
    lose pins, the shared text, or the history.
    """
    def __init__(self, state_dir=None, pin_limit=10):
        if state_dir is None:  # legacy default: <project>/instance
            state_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'instance')
        self.history_path = os.path.join(state_dir, 'buffer_history.json')
        self.state_path = os.path.join(state_dir, 'content_state.json')
        self.limit = pin_limit
        self.buffer_history = load_json(self.history_path, [], list, 'buffer history')
        state = load_json(self.state_path, {}, dict, 'shared text / pins')
        self.shared_text = state.get('shared_text', '') if isinstance(state.get('shared_text', ''), str) else ''
        pins = state.get('pins', [])
        self.pins = [p for p in pins if isinstance(p, dict) and 'id' in p and isinstance(p.get('text'), str)] \
            if isinstance(pins, list) else []

    # --- persistence ------------------------------------------------------
    def _save_buffer_history(self):
        try:
            atomic_write_json(self.history_path, self.buffer_history)
        except OSError as e:
            logging.error(f"Failed to save buffer history: {e}")

    def _save_state(self):
        try:
            atomic_write_json(self.state_path, {'shared_text': self.shared_text, 'pins': self.pins})
        except OSError as e:
            logging.error(f"Failed to save shared text / pins: {e}")

    # --- shared buffer ----------------------------------------------------
    def get_shared_text(self): return self.shared_text

    def update_shared_text(self, new_text, remote_addr):
        self.shared_text = str(new_text)
        ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
        details = f"by [{ip_color}]{remote_addr}[/], length: {len(self.shared_text)}"
        log_history("Buffer Cleared" if not self.shared_text else "Buffer Updated", details)
        self._save_state()
        # Log to buffer history if there's actual content
        if self.shared_text.strip():
            entry = {
                'id': uuid.uuid4().hex,
                'text': self.shared_text,
                'ip': remote_addr,
                'timestamp': datetime.now(timezone.utc).isoformat()
            }
            self.buffer_history.insert(0, entry)
            del self.buffer_history[MAX_HISTORY_ENTRIES:]
            self._save_buffer_history()
        return self.shared_text

    def get_buffer_history(self):
        return self.buffer_history

    def clear_buffer_history(self):
        self.buffer_history = []
        self._save_buffer_history()
        return True

    def copy_buffer_to_clipboard(self):
        if not PYCLIP_AVAILABLE:
            msg = "Clipboard functionality unavailable on server (pyperclip not installed)."
            return False, msg
        try:
            pyperclip.copy(self.shared_text)
            return True, "Text copied to server clipboard."
        except Exception as e:
            logging.error(f"Failed to copy text to server clipboard: {e}")
            return False, str(e)

    # --- pins -------------------------------------------------------------
    def get_pins(self): return self.pins

    def add_pin(self, text, remote_addr):
        if len(self.pins) >= self.limit: return None, f"Pin limit of {self.limit} reached."
        if not text or not text.strip(): return None, "Cannot pin empty text."
        new_pin = {'id': uuid.uuid4().hex, 'text': text}
        self.pins.append(new_pin)
        self._save_state()
        ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
        log_history("Message Pinned", f"ID: {new_pin['id']} from [{ip_color}]{remote_addr}[/]")
        return self.pins, None

    def delete_pin(self, pin_id, remote_addr):
        original_count = len(self.pins)
        self.pins = [pin for pin in self.pins if pin.get('id') != pin_id]
        if len(self.pins) < original_count:
            self._save_state()
            ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
            log_history("Message Unpinned", f"ID: {pin_id} by [{ip_color}]{remote_addr}[/]")
            return self.pins, None
        else:
            return None, "Pin not found."

    def clear_all_pins(self, remote_addr):
        count = len(self.pins)
        self.pins = []
        self._save_state()
        ip_color = "yellow" if remote_addr != "127.0.0.1" else "cyan"
        log_history("All Pins Cleared", f"{count} pins cleared by [{ip_color}]{remote_addr}[/]")
        return self.pins, None
