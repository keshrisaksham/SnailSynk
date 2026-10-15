#!/usr/bin/env python3
"""
cleanup.py - the "uninstall" and "clean install" halves of the SnailSynk scripts.

Snail.sh (Linux/macOS), Snail.bat (Windows) and snail_termux.sh (Termux) call this, so all three behave the same:

    cleanup.py uninstall [--yes] [--ask-only]
        Removes the program: everything in the SnailSynk folder EXCEPT your notes (instance/notes) and the files people
        uploaded (Downloads/SnailSynk/files). The admin account, settings, certificate, logs and file locks go too.

    cleanup.py clean [--yes] [--ask-only]
        Wipes everything SnailSynk ever stored, notes and uploaded files included, but leaves the program itself, so the
        script can then run a complete fresh install. Nothing of the old setup survives.

    --ask-only   show what would happen and ask for confirmation, but change nothing (exit 0 = confirmed, 1 = not).
                 The shell scripts use this first, remove their shortcuts, and only then call it again with --yes.
    --yes        skip the question (for scripts).

Standard library only. Python packages installed with pip are shared with other programs, so they are left alone.
"""

import argparse
import os
import shutil
import stat
import sys
from pathlib import Path

import setup_wizard as w          # the same look and feel (colours, ask, banner) as the installer

ROOT = w.ROOT                                         # the SnailSynk folder
INSTANCE = ROOT / "instance"
NOTES = INSTANCE / "notes"                            # where the notes editor keeps its .md files
UPLOADS_PARENT = Path.home() / "Downloads" / "SnailSynk"
UPLOADS = UPLOADS_PARENT / "files"                    # where uploads live (see SnailSynk.py: APP_DIR_NAME / FILES_SUBDIR_NAME)


# --------------------------------------------------------------------------------------------
# Safety: this deletes things, so be very sure where we are standing
# --------------------------------------------------------------------------------------------
def inside(path, parent):
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except (ValueError, OSError):
        return False


def sanity_check():
    """Refuse to run anywhere that doesn't look like a SnailSynk folder, or where deleting would hit the wrong thing."""
    if not (ROOT / "SnailSynk.py").is_file() or not (ROOT / "essentials" / "setup_wizard.py").is_file():
        return "This doesn't look like a SnailSynk folder, so I'm not deleting anything."
    home = Path.home().resolve()
    if ROOT.resolve() in (home, Path(ROOT.anchor)) or len(ROOT.resolve().parts) < 3:
        return f"{ROOT} is far too important to clean. I'm leaving it alone."
    if inside(ROOT, UPLOADS) or inside(ROOT, home / "Downloads" / "SnailSynk" / "files"):
        return "The SnailSynk folder is inside the uploads folder. Move it somewhere else first."
    return None


# --------------------------------------------------------------------------------------------
# Counting, so the question says what is actually at stake
# --------------------------------------------------------------------------------------------
def count_tree(folder):
    """(files, bytes) under a folder, not following links."""
    files = size = 0
    if not folder.is_dir():
        return 0, 0
    for dirpath, _dirs, names in os.walk(folder):
        for name in names:
            files += 1
            try:
                size += os.lstat(os.path.join(dirpath, name)).st_size
            except OSError:
                pass
    return files, size


def human(size):
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024


def describe(label, folder):
    files, size = count_tree(folder)
    if not folder.exists():
        return f"{label}: nothing there yet"
    return f"{label}: {files} file{'s' if files != 1 else ''}, {human(size)}  ({folder})"


# --------------------------------------------------------------------------------------------
# Deleting
# --------------------------------------------------------------------------------------------
def _force(func, path, _exc):
    """Windows refuses to delete read-only files; make it writable and try once more."""
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except OSError:
        raise


def remove(path, failures):
    """Delete a file, a link or a folder. Links are removed, never followed."""
    try:
        if path.is_symlink() or path.is_file():
            try:
                path.unlink()
            except PermissionError:
                os.chmod(path, stat.S_IWRITE)
                path.unlink()
        elif path.is_dir():
            shutil.rmtree(path, onerror=_force)
    except OSError as exc:
        failures.append((path, exc))


def remove_except(folder, keep, failures):
    """Delete everything in `folder` except the paths in `keep` (and the folders leading to them)."""
    keep = {k.resolve() for k in keep}
    for child in sorted(folder.iterdir()):
        resolved = child.resolve() if not child.is_symlink() else child.absolute()
        if resolved in keep:
            continue
        if not child.is_symlink() and child.is_dir() and any(k != resolved and inside(k, child) for k in keep):
            remove_except(child, keep, failures)
            continue
        remove(child, failures)


def remove_pycache(failures):
    for dirpath, dirs, _files in os.walk(ROOT):
        if "node_modules" in dirs:
            dirs.remove("node_modules")
        for d in list(dirs):
            if d == "__pycache__":
                remove(Path(dirpath) / d, failures)
                dirs.remove(d)


# --------------------------------------------------------------------------------------------
# The two jobs
# --------------------------------------------------------------------------------------------
def plan_uninstall():
    w.heading("Uninstall SnailSynk")
    w.say()
    w.say(f"  {w.BOLD}This will REMOVE:{w.RESET}")
    w.say(f"    - the program files in {ROOT}")
    w.say("    - your settings (.env), the admin account, the HTTPS certificate, logs and chat history")
    w.say("    - file locks, favorites and share links (the files themselves stay, but they will be unlocked)")
    w.say("    - the shortcuts and the 'snailsynk' command")
    w.say()
    w.say(f"  {w.BOLD}This will KEEP:{w.RESET}")
    w.say("    - " + describe("your notes", NOTES))
    w.say("    - " + describe("your uploaded files", UPLOADS))
    w.say()
    w.note("Python packages are shared with other programs, so they are left installed.")


def plan_clean():
    w.heading("Clean install")
    w.say()
    w.say(f"  {w.BOLD}This will ERASE everything SnailSynk has stored, with no way back:{w.RESET}")
    w.say(f"    - {describe('your NOTES', NOTES)}")
    w.say(f"    - {describe('your UPLOADED FILES', UPLOADS)}")
    w.say("    - the admin account, settings (.env), HTTPS certificate, logs, chat history, locks and favorites")
    w.say()
    w.say(f"  {w.BOLD}Then it will set SnailSynk up again from scratch{w.RESET} (the program files stay).")
    w.say()
    w.note("Python packages are shared with other programs, so they are left installed.")


def confirm(word):
    port = w.configured_port()
    if w.port_busy(port):
        w.say()
        w.warn(f"Something is using port {port}. If that is SnailSynk, stop it first or some files can't be deleted.")
    w.say()
    answer = w.ask(f"Type {w.BOLD}{word}{w.RESET} to go ahead, or just press Enter to cancel")
    return answer.strip() == word


def report(failures, what):
    if failures:
        w.say()
        w.warn(f"{len(failures)} item(s) couldn't be removed (is SnailSynk still running?):")
        for path, exc in failures[:8]:
            w.note(f"{path}  ({exc.__class__.__name__})")
        return 1
    w.ok(what)
    return 0


def do_uninstall():
    failures = []
    keep = [NOTES]
    if inside(UPLOADS, ROOT):
        keep.append(UPLOADS)                   # uploads normally live in ~/Downloads, but never delete them by accident
    remove_except(ROOT, keep, failures)
    return report(failures, "SnailSynk is uninstalled. Your notes and uploaded files were left alone.")


def do_clean():
    failures = []
    remove(INSTANCE, failures)
    for name in (".env", "install.loc"):
        remove(ROOT / name, failures)
    remove_pycache(failures)
    if UPLOADS.exists():
        remove(UPLOADS, failures)
    try:
        UPLOADS_PARENT.rmdir()                 # only if it is empty now: never delete anything else in there
    except OSError:
        pass
    return report(failures, "Everything SnailSynk had stored is gone.")


def main():
    parser = argparse.ArgumentParser(description="SnailSynk uninstall / clean install")
    parser.add_argument("job", choices=["uninstall", "clean"])
    parser.add_argument("--yes", action="store_true", help="don't ask")
    parser.add_argument("--ask-only", action="store_true", help="ask for confirmation, change nothing")
    args = parser.parse_args()

    problem = sanity_check()
    if problem:
        w.bad(problem)
        return 2

    uninstall = args.job == "uninstall"
    if not args.yes:
        (plan_uninstall if uninstall else plan_clean)()
        if not confirm("yes" if uninstall else "DELETE"):
            w.say()
            w.say("  Cancelled. Nothing was changed. The snail breathes a sigh of relief.")
            return 1
    if args.ask_only:
        return 0
    return do_uninstall() if uninstall else do_clean()


if __name__ == "__main__":
    sys.exit(main())
