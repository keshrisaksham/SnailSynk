"""
launcher.py - the entry point of the packaged builds (the Debian package and the Windows portable .exe).

Snail.sh / Snail.bat are for running from a git checkout. A package is different: the code lives in a read-only
place, so everything SnailSynk writes (settings, admin account, certificate, notes) goes to a data folder instead:

    Debian package    ~/.local/share/snailsynk            (or $XDG_DATA_HOME/snailsynk)
    Windows .exe      SnailSynk-data\\ next to the .exe     (so the whole thing stays portable)
    anything else     set SNAILSYNK_HOME yourself

    snailsynk                 first run: ask a few questions, then start. After that: just start.
    snailsynk --setup         run the setup questions again.
    snailsynk --reset-admin   forgot the admin password? Pick a new one.
    snailsynk --no-browser    don't open the browser.
    snailsynk --version
"""

import gevent.monkey
gevent.monkey.patch_all()

import argparse
import os
import sys
from pathlib import Path
from types import SimpleNamespace

FROZEN = getattr(sys, "frozen", False)
APP_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def read_version():
    try:
        for folder in (APP_DIR, APP_DIR.parent):   # packaged builds keep VERSION beside the code; a checkout keeps it one level up
            if (folder / "VERSION").is_file():
                return (folder / "VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        pass
    return "unknown"


def default_home():
    if os.environ.get("SNAILSYNK_HOME"):
        return Path(os.environ["SNAILSYNK_HOME"]).expanduser().resolve()
    if FROZEN:
        return Path(sys.executable).resolve().parent / "SnailSynk-data"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA") or Path.home()) / "SnailSynk"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "snailsynk"


def has_display():
    return os.name == "nt" or sys.platform == "darwin" or bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def main():
    parser = argparse.ArgumentParser(prog="snailsynk", description="SnailSynk: share files, text and notes on your own network.")
    parser.add_argument("--setup", action="store_true", help="run the setup questions again")
    parser.add_argument("--reset-admin", action="store_true", help="pick a new admin username and password")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser")
    parser.add_argument("--version", action="store_true", help="show the version and exit")
    args = parser.parse_args()

    if args.version:
        print(f"SnailSynk {read_version()}")
        return 0

    home = default_home()
    home.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(home, 0o700)   # holds the admin hash, the session key and the HTTPS private key
    except OSError:
        pass
    os.environ["SNAILSYNK_HOME"] = str(home)

    sys.path.insert(0, str(APP_DIR))
    import setup_wizard as w

    if args.reset_admin:
        return w.cmd_reset_admin(None)

    first_run = not w.USER_PATH.exists()
    if args.setup or first_run:
        if sys.stdin.isatty():
            w.banner("one-time setup")
            w.cmd_ask(None)
            w.cmd_done(SimpleNamespace(cmd="type  snailsynk  in a terminal, or use the menu entry.",
                                       reset="snailsynk --reset-admin"))
            input("  Press [Enter] to launch it... ")
        else:
            print("SnailSynk has no admin account yet. Run  snailsynk --setup  in a terminal to create one.", file=sys.stderr)

    if not args.no_browser and has_display():
        gevent.spawn(w.cmd_open_browser, None)

    rc = 0
    try:
        import SnailSynk
        SnailSynk.main()
    except KeyboardInterrupt:
        pass
    except SystemExit as e:
        rc = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)

    w.cmd_bye(SimpleNamespace(rc=rc))
    if FROZEN and os.name == "nt" and rc != 0 and sys.stdin.isatty():
        input("Press [Enter] to close this window... ")   # a double-clicked console would vanish with the error
    return rc


if __name__ == "__main__":
    sys.exit(main())
