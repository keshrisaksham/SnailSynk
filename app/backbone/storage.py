# backbone/storage.py
"""Crash-safe JSON persistence shared by all the managers."""
import os
import json
import time
import logging
import tempfile


def atomic_write_text(path, text, mode=None):
    """Write `text` to `path` so readers see either the old or the new content, never a
    half-written file: write to a temp file in the same directory, fsync, then rename over."""
    path = os.fspath(path)
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix='.' + os.path.basename(path) + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp_path, mode)
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def atomic_write_json(path, data, mode=None, **dump_kwargs):
    dump_kwargs.setdefault('indent', 2)
    dump_kwargs.setdefault('ensure_ascii', False)
    atomic_write_text(path, json.dumps(data, **dump_kwargs), mode=mode)


def load_json(path, default, expected_type=None, label='data file'):
    """Load JSON from `path`. A missing file gives `default`. A corrupt or wrong-shaped file is
    moved aside to '<name>.corrupt-<timestamp>' (so it can be recovered by hand and is never
    silently overwritten by the next save) and `default` is returned."""
    path = os.fspath(path)
    if not os.path.exists(path):
        return default
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if expected_type is not None and not isinstance(data, expected_type):
            raise ValueError(f"expected {expected_type.__name__}, found {type(data).__name__}")
        return data
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError, OSError) as e:
        backup = f"{path}.corrupt-{time.strftime('%Y%m%d-%H%M%S')}"
        try:
            os.replace(path, backup)
            logging.error(f"Could not read {label} {path} ({e}). Moved it to {backup} and starting empty.")
        except OSError:
            logging.error(f"Could not read {label} {path} ({e}) and could not move it aside.")
        return default
