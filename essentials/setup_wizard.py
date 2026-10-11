#!/usr/bin/env python3
"""
setup_wizard.py - the friendly half of the SnailSynk installers.

Snail.sh (Linux/macOS) and Snail.bat (Windows) take care of the things only a shell can do
(finding Python, installing packages, shortcuts). Everything you see and answer lives here,
so both platforms behave the same:

    setup_wizard.py banner [--sub TEXT]   print the snail
    setup_wizard.py ask                   admin account, port, AI key -> saves instance/user.json and .env
    setup_wizard.py reset-admin           pick a new admin username/password
    setup_wizard.py done --cmd NAME       the "all done" summary (NAME = how to start it next time)
    setup_wizard.py port                  print the configured port
    setup_wizard.py open-browser          wait for the server, then open it in the browser
    setup_wizard.py bye [--rc N]          the goodbye line after the server stops

Uses only the standard library, apart from the project's own backbone package (installed by the
scripts before the questions start) to store the admin password as an argon2 hash.
"""

import argparse
import getpass
import os
import random
import re
import secrets
import socket
import sys
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
USER_PATH = ROOT / "instance" / "user.json"
DEFAULT_PORT = 9000

# --------------------------------------------------------------------------------------------
# Look and feel
# --------------------------------------------------------------------------------------------
if os.name == "nt":
    os.system("")  # switches the Windows console to understand colour codes

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
try:
    "✔".encode(sys.stdout.encoding or "ascii")
    _UNICODE = True
except (UnicodeEncodeError, LookupError):
    _UNICODE = False


def _c(code):
    return f"\033[{code}m" if _COLOR else ""


RESET, BOLD, DIM = _c(0), _c(1), _c(2)
RED, GREEN, YELLOW, CYAN = _c("1;31"), _c("1;32"), _c("1;33"), _c("1;36")
SYM_OK, SYM_BAD, SYM_WARN, SYM_ASK = ("✔", "✘", "!", "?") if _UNICODE else ("+", "x", "!", "?")

SNAIL = r"""     .----.   @   @
    / .-"-.`.  \v/
    | | '\ \ \_/ )
  ,-\ `-.' /.'  /
 '---`----'----'"""


def say(text=""):
    print(text)


def ok(text):
    print(f"  {GREEN}{SYM_OK}{RESET} {text}")


def warn(text):
    print(f"  {YELLOW}{SYM_WARN}{RESET} {text}")


def bad(text):
    print(f"  {RED}{SYM_BAD}{RESET} {text}")


def note(text):
    print(f"    {DIM}{text}{RESET}")


def heading(text):
    print(f"\n  {BOLD}{text}{RESET}")


def ask(prompt, default=None, secret=False):
    """Prompt on one line. `default` is shown in dim brackets and returned on Enter."""
    hint = f" {DIM}[{default}]{RESET}" if default else ""
    text = f"  {CYAN}{SYM_ASK}{RESET} {prompt}{hint}: "
    try:
        if secret and sys.stdin.isatty():
            answer = getpass.getpass(text)
        else:
            answer = input(text)
    except EOFError:
        print()
        bad("The input ended before the questions did. Run it again from a normal terminal.")
        sys.exit(1)
    except KeyboardInterrupt:
        print()
        say("  Cancelled. Nothing was changed. Run it again whenever you like.")
        sys.exit(130)
    return answer if answer else (default or "")


def banner(sub=""):
    sub = sub or random.choice([
        "waking up the snail...",
        "polishing the slime trail...",
        "warming up the shell...",
        "packing lettuce for the journey...",
    ])
    print(f"{GREEN}{SNAIL}{RESET}")
    print(f"  {BOLD}SnailSynk{RESET}  {DIM}{sub}{RESET}\n")


# --------------------------------------------------------------------------------------------
# Settings files
# --------------------------------------------------------------------------------------------
def read_env():
    values = {}
    try:
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip("'\"")
    except OSError:
        pass
    return values


def configured_port():
    value = read_env().get("SNAILSYNK_PORT", "")
    return int(value) if value.isdigit() and 0 < int(value) < 65536 else DEFAULT_PORT


def existing_admin():
    try:
        import json
        return json.loads(USER_PATH.read_text(encoding="utf-8")).get("username") or None
    except (OSError, ValueError, AttributeError):
        return None


def write_admin_account(username, password):
    """Store the admin account exactly like the app does (argon2 hash in instance/user.json)."""
    os.environ["SNAILSYNK_ADMIN_USER"] = username
    os.environ["SNAILSYNK_ADMIN_PASS"] = password
    sys.path.insert(0, str(ROOT))
    try:
        from backbone.user_manager import UserManager
        manager = UserManager(str(USER_PATH))
        return bool(manager.user_data)
    except Exception:
        return False
    finally:
        os.environ.pop("SNAILSYNK_ADMIN_USER", None)
        os.environ.pop("SNAILSYNK_ADMIN_PASS", None)


def write_env(port, gemini_key, admin=None):
    lines = ["# SnailSynk settings. Edit and restart to apply.", f"SNAILSYNK_PORT={port}"]
    lines.append(f"GEMINI_API_KEY='{gemini_key}'" if gemini_key else "# GEMINI_API_KEY='paste-your-key-here'")
    if admin:  # only if the account couldn't be created now: the app creates it on its first start
        lines += [f"SNAILSYNK_ADMIN_USER='{admin[0]}'", f"SNAILSYNK_ADMIN_PASS='{admin[1]}'"]
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.chmod(ENV_PATH, 0o600)
    except OSError:
        pass


def lan_ip():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        return probe.getsockname()[0]
    except OSError:
        return "localhost"
    finally:
        probe.close()


def port_busy(port):
    probe = socket.socket()
    try:
        probe.bind(("0.0.0.0", port))
        return False
    except OSError:
        return True
    finally:
        probe.close()


# --------------------------------------------------------------------------------------------
# The questions
# --------------------------------------------------------------------------------------------
def ask_admin():
    """Returns (username, password)."""
    heading("Your admin account")
    note("The admin panel lives at /admin. It shows who connected, what they grabbed,")
    note("and every note you scribble. With great power comes great responsibility,")
    note("so no 'password123'. The snail will judge you.")
    print()
    while True:
        username = ask("Admin username", "admin").strip()
        if not username or len(username) > 64:
            warn("That is a username, not a novel. 1 to 64 characters, please.")
            continue
        break
    while True:
        password = ask("Admin password (Enter = make me a random one)", secret=True)
        if not password:
            password = secrets.token_urlsafe(12)
            print()
            say(f"  {BOLD}Your admin password is:{RESET} {GREEN}{password}{RESET}")
            note("Shown once. Write it down; the snail has a terrible memory.")
            note("(It is stored scrambled, so even the snail can't read it back.)")
            break
        if len(password) < 8:
            warn("A snail without a shell is harder to break into. At least 8 characters, please.")
            continue
        if ask("Type it again to be sure", secret=True) != password:
            warn("Those two don't match. Even snails can type the same thing twice. Try again.")
            continue
        break
    return username, password


def ask_port(current):
    heading("Network port")
    while True:
        answer = ask("Which port should SnailSynk use?", str(current))
        if not answer.isdigit():
            warn("Ports are numbers. Something like 9000 will do.")
            continue
        port = int(answer)
        if not 1024 <= port <= 65535:
            warn("Pick something between 1024 and 65535 (below 1024 is reserved for the grown-ups).")
            continue
        if port != configured_port() and port_busy(port):
            warn(f"Something is already using port {port}. Another snail, perhaps?")
            if ask("Use it anyway? (y/N)").lower() not in ("y", "yes"):
                continue
        return port


def ask_gemini(current):
    heading("AI chat (optional)")
    note("The AI chat needs a free Gemini API key (https://aistudio.google.com/apikey).")
    note("Skip it and the AI stays asleep. Everything else works fine.")
    while True:
        if current:
            answer = ask("Gemini API key (Enter = keep the current one, '-' = remove it)").strip()
            if not answer:
                return current
            if answer == "-":
                return ""
        else:
            answer = ask("Gemini API key (Enter to skip)").strip()
        answer = re.sub(r"\s", "", answer)
        if re.search(r"[\"'\\]", answer):
            warn("That key has quotes or slashes in it. Copy just the key itself.")
            continue
        return answer


def cmd_ask(_args):
    env = read_env()
    admin_in_env = None

    keep = False
    current_user = existing_admin()
    if current_user:
        say(f"\n  An admin account ({BOLD}{current_user}{RESET}) already exists from an earlier setup.")
        keep = ask("Keep it? (Y/n)").lower() not in ("n", "no")
    if not keep:
        username, password = ask_admin()
    port = ask_port(configured_port())
    gemini = ask_gemini(env.get("GEMINI_API_KEY", ""))

    print()
    if keep:
        ok("Keeping your existing admin account.")
    else:
        backup = None
        if USER_PATH.exists():
            backup = USER_PATH.with_suffix(".json.old")
            USER_PATH.replace(backup)
        if write_admin_account(username, password):
            if backup:
                backup.unlink(missing_ok=True)
            ok("Admin account created (the password is stored scrambled, not as plain text).")
        else:
            if backup:
                backup.replace(USER_PATH)
            admin_in_env = (username, password)
            warn("Couldn't create the admin account right now; SnailSynk will create it on its first start.")
    write_env(port, gemini, admin_in_env)
    ok("Settings saved to .env")
    return 0


def cmd_reset_admin(_args):
    banner("admin password reset")
    say(f"  {BOLD}Locked out of your own admin panel? It happens to the best snails.{RESET}\n")
    username, password = ask_admin()
    backup = None
    if USER_PATH.exists():
        backup = USER_PATH.with_suffix(".json.old")
        USER_PATH.replace(backup)
    print()
    if write_admin_account(username, password):
        if backup:
            backup.unlink(missing_ok=True)
        ok("New admin account saved. Restart SnailSynk if it is running.")
        return 0
    if backup:
        backup.replace(USER_PATH)
    bad("Couldn't save the admin account. Your old one is untouched.")
    note("Make sure the packages are installed (run the Snail script with --setup).")
    return 1


# --------------------------------------------------------------------------------------------
# After setup / around launch
# --------------------------------------------------------------------------------------------
def cmd_done(args):
    port = configured_port()
    user = existing_admin() or "(set on first start)"
    print()
    print(f"{GREEN}  ======================================================")
    print("    All done. Your snail is ready.")
    print(f"  ======================================================{RESET}\n")
    say(f"  Open it on this computer:   {CYAN}https://localhost:{port}{RESET}")
    say(f"  Open it from your phone:    {CYAN}https://{lan_ip()}:{port}{RESET}")
    say(f"  Admin panel:                {CYAN}https://localhost:{port}/admin{RESET}   (username: {user})")
    note("The admin panel is where the snail keeps its secrets. Knock politely.")
    print()
    note("Your browser will say 'Not secure'. That's because the snail made its own certificate,")
    note("at home, from scratch. Click Advanced, then Proceed. It renews itself before it expires.")
    print()
    note(f"Next time: {args.cmd}")
    note(f"Forgot the admin password?  {args.reset}")
    print()
    return 0


def cmd_port(_args):
    print(configured_port())
    return 0


def cmd_open_browser(_args):
    port = configured_port()
    for _ in range(60):  # up to ~30 s for the server to start listening
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            break
        except OSError:
            time.sleep(0.5)
    else:
        return 0
    webbrowser.open(f"https://localhost:{port}")
    return 0


def cmd_bye(args):
    print()
    if args.rc in (0, 130, -2, 3221225786):  # clean exit or Ctrl+C
        say("  " + random.choice([
            "The snail has retreated into its shell. See you soon.",
            "Server stopped. Slowly, as is tradition.",
            "Shell closed. Your files are safe and the lettuce is stocked.",
        ]))
        return 0
    bad(f"SnailSynk stopped unexpectedly (exit code {args.rc}). The message above says why.")
    note("Stuck? Run the Snail script with --setup, or check that the port isn't used by another program.")
    return args.rc


def cmd_banner(args):
    banner(args.sub)
    return 0


def main():
    parser = argparse.ArgumentParser(description="SnailSynk setup wizard")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("banner"); p.add_argument("--sub", default=""); p.set_defaults(func=cmd_banner)
    sub.add_parser("ask").set_defaults(func=cmd_ask)
    sub.add_parser("reset-admin").set_defaults(func=cmd_reset_admin)
    p = sub.add_parser("done")
    p.add_argument("--cmd", default="run the Snail script again")
    p.add_argument("--reset", default="run the Snail script with --reset-admin")
    p.set_defaults(func=cmd_done)
    sub.add_parser("port").set_defaults(func=cmd_port)
    sub.add_parser("open-browser").set_defaults(func=cmd_open_browser)
    p = sub.add_parser("bye"); p.add_argument("--rc", type=int, default=0); p.set_defaults(func=cmd_bye)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
