# backbone/action_logger.py
import os
import json
import logging
import threading
from collections import deque
from itertools import islice
from pathlib import Path
from datetime import datetime, timedelta, timezone

RECENT_WINDOW = timedelta(hours=1)


def _parse_ts(value):
    """Parse a log timestamp into an aware UTC datetime, or None if malformed."""
    try:
        ts = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def _iter_lines_reverse(path, block_size=64 * 1024):
    """Yield the non-empty lines of a file newest-first without loading the whole file."""
    with open(path, 'rb') as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        buf = b''
        while pos > 0:
            read = min(block_size, pos)
            pos -= read
            f.seek(pos)
            buf = f.read(read) + buf
            lines = buf.split(b'\n')
            buf = lines[0]            # possibly a partial line; finish it with the next block
            for line in reversed(lines[1:]):
                if line.strip():
                    yield line
        if buf.strip():
            yield buf


class ActionLogger:
    """Writes and reads structured action logs (JSON lines) with real-time emission.

    The log is size-rotated (actions.jsonl -> .1 -> .2 ...) so it cannot grow without bound,
    pages are read from the end of the file, and dashboard statistics are kept in memory
    instead of re-parsing the file on every request. Paging and statistics cover the current
    file plus its retained backups.
    """
    def __init__(self, log_file_path, socketio=None, max_bytes=5 * 1024 * 1024, backups=3):
        self.path = Path(log_file_path)
        self.socketio = socketio
        self.max_bytes = max_bytes
        self.backups = backups
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.touch()
        self._reset_stats()
        self._rebuild_stats()

    def _files_newest_first(self):
        """The current log followed by its rotated backups that exist, newest to oldest."""
        paths = [self.path] + [Path(f"{self.path}.{i}") for i in range(1, self.backups + 1)]
        return [p for p in paths if p.exists()]

    # --- statistics -------------------------------------------------------
    def _reset_stats(self):
        self._total = 0
        self._ips = set()
        self._recent = deque()   # timestamps within the last hour, oldest first

    def _count(self, entry):
        self._total += 1
        ip = entry.get('ip_address') or entry.get('ip')
        if ip:
            self._ips.add(ip)
        ts = _parse_ts(entry.get('timestamp'))
        if ts and ts > datetime.now(timezone.utc) - RECENT_WINDOW:
            self._recent.append(ts)

    def _rebuild_stats(self):
        """Recount from every retained log file, oldest first (keeps `_recent` in time order)."""
        self._reset_stats()
        for path in reversed(self._files_newest_first()):
            try:
                with open(path, 'r', encoding='utf-8', errors='replace') as f:
                    for line in f:
                        if not line.strip():
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(entry, dict):
                            self._count(entry)
            except OSError as e:
                logging.error(f"Failed to read action log from {path}: {e}")

    def get_stats(self):
        cutoff = datetime.now(timezone.utc) - RECENT_WINDOW
        while self._recent and self._recent[0] <= cutoff:
            self._recent.popleft()
        return {'total_logs': self._total, 'unique_ips': len(self._ips), 'recent_activity': len(self._recent)}

    # --- writing ----------------------------------------------------------
    def _emit_log(self, log_entry):
        if self.socketio:
            self.socketio.emit('new_log_entry', log_entry, room='admin_room')

    def _rotate_if_needed(self):
        try:
            if self.path.stat().st_size < self.max_bytes:
                return
        except OSError:
            return
        try:
            for i in range(self.backups, 0, -1):
                src = self.path if i == 1 else Path(f"{self.path}.{i - 1}")
                if src.exists():
                    os.replace(src, f"{self.path}.{i}")
            self.path.touch()
            self._rebuild_stats()   # the oldest backup may have just been dropped
        except OSError as e:
            logging.error(f"Failed to rotate action log {self.path}: {e}")

    def log(self, ip, action, details=None):
        log_entry = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'ip_address': ip, 'action': action, 'details': details or {}
        }
        try:
            line = json.dumps(log_entry, ensure_ascii=False) + '\n'
            with self._lock:
                self._rotate_if_needed()
                with open(self.path, 'a', encoding='utf-8') as f:
                    f.write(line)
                self._count(log_entry)
            self._emit_log(log_entry)
        except (OSError, TypeError, ValueError) as e:
            # Same failure on every request would flood the console - report it once per distinct error
            msg = f"Failed to write to action log at {self.path}: {e}"
            if msg != getattr(self, '_last_write_error', None):
                self._last_write_error = msg
                logging.error(msg)

    # --- reading ----------------------------------------------------------
    def get_logs(self, page=1, limit=10):
        """Newest-first page of entries. Malformed lines are skipped, not fatal."""
        page, limit = max(int(page), 1), max(int(limit), 1)

        def entries():
            for path in self._files_newest_first():
                for raw in _iter_lines_reverse(path):
                    try:
                        entry = json.loads(raw.decode('utf-8', errors='replace'))
                    except json.JSONDecodeError:
                        continue
                    if isinstance(entry, dict):
                        yield entry

        try:
            window = list(islice(entries(), (page - 1) * limit, page * limit + 1))
        except OSError as e:
            logging.error(f"Failed to read action log from {self.path}: {e}")
            return [], False
        return window[:limit], len(window) > limit

    def get_all_logs(self):
        """Every retained entry (oldest first). Prefer get_logs()/get_stats()."""
        logs = []
        for path in reversed(self._files_newest_first()):
            try:
                with open(path, 'r', encoding='utf-8', errors='replace') as f:
                    for line in f:
                        if line.strip():
                            try:
                                logs.append(json.loads(line))
                            except json.JSONDecodeError:
                                continue
            except OSError as e:
                logging.error(f"Failed to read action log from {path}: {e}")
        return logs

    def clear_logs(self):
        """Clear all action logs, including rotated backups."""
        try:
            with self._lock:
                with open(self.path, 'w', encoding='utf-8'):
                    pass
                for i in range(1, self.backups + 1):
                    try:
                        os.remove(f"{self.path}.{i}")
                    except FileNotFoundError:
                        pass
                self._reset_stats()
            logging.info(f"Cleared all logs from {self.path}")
        except OSError as e:
            logging.error(f"Failed to clear logs from {self.path}: {e}")

    def migrate_old_logs(self):
        """Migrate old logs from 'ip' field to 'ip_address' field. Returns the number migrated."""
        try:
            with self._lock:
                migrated, out = 0, []
                with open(self.path, 'r', encoding='utf-8', errors='replace') as f:
                    for line in f:
                        if not line.strip():
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            out.append(line if line.endswith('\n') else line + '\n')  # keep unparseable lines as-is
                            continue
                        if isinstance(entry, dict) and 'ip' in entry and 'ip_address' not in entry:
                            entry['ip_address'] = entry.pop('ip')
                            migrated += 1
                        out.append(json.dumps(entry, ensure_ascii=False) + '\n')
                if migrated:
                    from .storage import atomic_write_text
                    atomic_write_text(self.path, ''.join(out))
                    logging.info(f"Migrated {migrated} log entries from 'ip' to 'ip_address' field")
                return migrated
        except OSError as e:
            logging.error(f"Failed to migrate logs from {self.path}: {e}")
            return 0
