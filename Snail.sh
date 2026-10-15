#!/bin/bash

# ================================================================================
# SnailSynk installer + launcher for Linux & macOS
#
#   ./Snail.sh                 first run: friendly setup, then starts the app.
#                              Every later run just starts the app.
#   ./Snail.sh --reset-admin   forgot the admin password? Set a new one.
#   ./Snail.sh --setup         run the setup questions again.
#   ./Snail.sh --uninstall     remove SnailSynk, but keep your notes and the uploaded files.
#   ./Snail.sh --clean-install erase EVERYTHING (notes and uploads too), then install from scratch.
#   ./Snail.sh --help          this list.
#   (add --yes to --uninstall / --clean-install to skip the "are you sure?" question)
#
# This script does what only a shell can (Python, packages, shortcuts). The questions,
# the admin account and the summary live in essentials/setup_wizard.py.
# ================================================================================

# Stop the script if any command fails
set -e

# All file operations (requirements.txt, .env, instance/) happen next to this script,
# no matter where it is called from.
cd "$(dirname "$0")"
WIZARD="essentials/setup_wizard.py"

# --------------------------------------------------------------------------------
# Look and feel
# --------------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'; C_CYAN=$'\033[1;36m'
else
    C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8*|*utf8*|*UTF8*) SYM_OK="✔"; SYM_BAD="✘"; SYM_WARN="!" ;;
    *)                     SYM_OK="+"; SYM_BAD="x"; SYM_WARN="!" ;;
esac

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s%s%s %s\n' "$C_GREEN" "$SYM_OK" "$C_RESET" "$*"; }
warn() { printf '  %s%s%s %s\n' "$C_YELLOW" "$SYM_WARN" "$C_RESET" "$*"; }
bad()  { printf '  %s%s%s %s\n' "$C_RED" "$SYM_BAD" "$C_RESET" "$*"; }
note() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
step() { printf '\n%s[%s/%s]%s %s%s%s\n' "$C_CYAN" "$1" "$2" "$C_RESET" "$C_BOLD" "$3" "$C_RESET"; }

# pick "a" "b" "c"  ->  prints one of them at random
pick() { local i=$(( RANDOM % $# + 1 )); printf '%s' "${!i}"; }

banner() {
    printf '%s' "$C_GREEN"
    cat << 'SNAIL'
     .----.   @   @
    / .-"-.`.  \v/
    | | '\ \ \_/ )
  ,-\ `-.' /.'  /
 '---`----'----'
SNAIL
    printf '%s' "$C_RESET"
    printf '  %sSnailSynk%s  %s%s%s\n\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$1" "$C_RESET"
}

# Run a command quietly with a little spinner. The output goes to a log file that is
# shown only if something goes wrong.   run_quiet "message" logfile command...
run_quiet() {
    local msg="$1" log="$2" rc=0 pid i=0 frames='|/-\'
    shift 2
    "$@" > "$log" 2>&1 &
    pid=$!
    if [ -t 1 ]; then
        while kill -0 "$pid" 2> /dev/null; do
            printf '\r  %s%s%s %s' "$C_CYAN" "${frames:$((i++ % 4)):1}" "$C_RESET" "$msg"
            sleep 0.15
        done
        wait "$pid" || rc=$?
        printf '\r\033[K'
    else
        printf '  ... %s\n' "$msg"
        wait "$pid" || rc=$?
    fi
    return $rc
}

usage() {
    banner "installer & launcher"
    say "  ./Snail.sh                 first run: setup, then start. After that: just start."
    say "  ./Snail.sh --reset-admin   forgot the admin password? pick a new one."
    say "  ./Snail.sh --setup         run the setup questions again."
    say "  ./Snail.sh --uninstall     remove SnailSynk, keeping your notes and uploaded files."
    say "  ./Snail.sh --clean-install erase everything (notes and uploads too) and install from scratch."
    say "  ./Snail.sh --help          show this."
    note "Add --yes to --uninstall or --clean-install to skip the question."
    echo
}

# --------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------
get_pkg_manager() {
    if command -v apt-get &> /dev/null; then echo "apt"
    elif command -v dnf &> /dev/null; then echo "dnf"
    elif command -v pacman &> /dev/null; then echo "pacman"
    elif command -v brew &> /dev/null; then echo "brew"
    else echo "unknown"
    fi
}

# Run a command as the person who started the script (not as root, when we were elevated for setup)
as_user() {
    if [ "$EUID" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
        sudo -u "$SUDO_USER" -H "$@"
    else
        "$@"
    fi
}

# --------------------------------------------------------------------------------
# Desktop shortcut (Linux only, needs root)
# --------------------------------------------------------------------------------
create_desktop_icon() {
    if [ "$(uname -s)" != "Linux" ]; then
        return 0
    fi
    local REAL_USER USER_HOME DESKTOP_DIR APPS_DIR ICON_DIR DESKTOP_TMP
    if [ -n "${SUDO_USER:-}" ]; then
        REAL_USER="$SUDO_USER"
        USER_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
    else
        REAL_USER="$(whoami)"
        USER_HOME="$HOME"
    fi

    DESKTOP_DIR="$USER_HOME/Desktop"
    APPS_DIR="$USER_HOME/.local/share/applications"
    ICON_DIR="$USER_HOME/.local/share/icons"

    # Install the icon globally so desktop environments reliably find it
    mkdir -p /usr/share/pixmaps
    cp "$(pwd)/static/icon/favicon.png" /usr/share/pixmaps/snailsynk.png
    chmod 644 /usr/share/pixmaps/snailsynk.png

    mkdir -p "$ICON_DIR"
    chown "$REAL_USER" "$ICON_DIR"
    cp "$(pwd)/static/icon/favicon.png" "$ICON_DIR/snailsynk.png"
    chown "$REAL_USER" "$ICON_DIR/snailsynk.png"
    chmod 644 "$ICON_DIR/snailsynk.png"

    DESKTOP_TMP="$(mktemp)"
    cat << DESKTOP_EOF > "$DESKTOP_TMP"
[Desktop Entry]
Version=1.0
Type=Application
Name=SnailSynk
Comment=SnailSynk File Synchronization
Exec=/usr/local/bin/snailsynk
Icon=snailsynk
Terminal=true
Categories=Utility;
DESKTOP_EOF

    mkdir -p /usr/share/applications
    cp "$DESKTOP_TMP" /usr/share/applications/SnailSynk.desktop
    chmod 644 /usr/share/applications/SnailSynk.desktop

    if [ -d "$DESKTOP_DIR" ]; then
        cp "$DESKTOP_TMP" "$DESKTOP_DIR/SnailSynk.desktop"
        chown "$REAL_USER" "$DESKTOP_DIR/SnailSynk.desktop"
        chmod a+rx "$DESKTOP_DIR/SnailSynk.desktop"
        rm -f "$DESKTOP_DIR/mimeinfo.cache"
        # Mark the shortcut as trusted for GNOME
        if command -v gio &> /dev/null; then
            sudo -u "$REAL_USER" bash -c "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/\$(id -u \"$REAL_USER\")/bus gio set '$DESKTOP_DIR/SnailSynk.desktop' metadata::trusted true" 2> /dev/null || true
        fi
    fi

    mkdir -p "$APPS_DIR"
    chown "$REAL_USER" "$APPS_DIR"
    cp "$DESKTOP_TMP" "$APPS_DIR/SnailSynk.desktop"
    chown "$REAL_USER" "$APPS_DIR/SnailSynk.desktop"
    chmod a+rx "$APPS_DIR/SnailSynk.desktop"

    if command -v update-desktop-database &> /dev/null; then
        update-desktop-database "$APPS_DIR" 2> /dev/null || true
        update-desktop-database /usr/share/applications 2> /dev/null || true
    fi
    rm -f "$DESKTOP_TMP"
}

# --------------------------------------------------------------------------------
# Setup (runs as root: it installs packages and creates the 'snailsynk' command;
# the questions are asked as the real user so nothing they own ends up owned by root)
# --------------------------------------------------------------------------------
setup_routine() {
    local TOTAL=4 PKG_MANAGER LOG PIP_FLAGS="" PYVER n_pkgs
    if [ -t 1 ]; then clear; fi
    banner "one-time setup"
    say "  ${C_BOLD}Welcome! Let's get your snail moving.${C_RESET}"
    note "$(pick \
        "This takes about a minute. Snails are slow, but we're not." \
        "Grab a coffee. Or a lettuce leaf. We won't judge." \
        "Almost nothing here can go wrong. Famous last words.")"

    PKG_MANAGER=$(get_pkg_manager)
    LOG="$(mktemp -t snailsynk-setup.XXXXXX)"

    # ---- 1. Python ----------------------------------------------------------
    step 1 $TOTAL "Checking for Python"
    if ! command -v python3 &> /dev/null; then
        warn "python3 isn't installed. Let me fetch it..."
        case "$PKG_MANAGER" in
            apt) run_quiet "Installing python3..." "$LOG" bash -c "apt-get update && apt-get install -y python3" ;;
            dnf) run_quiet "Installing python3..." "$LOG" dnf install -y python3 ;;
            pacman) run_quiet "Installing python..." "$LOG" pacman -S --noconfirm python ;;
            *) bad "I can't install Python on this system by myself. Please install Python 3 and run this again."; exit 1 ;;
        esac || { bad "Installing Python failed. The details:"; tail -n 15 "$LOG"; exit 1; }
    fi
    if ! python3 -m pip --version &> /dev/null; then
        warn "pip is missing. Fetching that too..."
        case "$PKG_MANAGER" in
            apt) run_quiet "Installing pip..." "$LOG" bash -c "apt-get update && apt-get install -y python3-pip python3-venv" ;;
            dnf) run_quiet "Installing pip..." "$LOG" dnf install -y python3-pip ;;
            pacman) run_quiet "Installing pip..." "$LOG" pacman -S --noconfirm python-pip ;;
            *) bad "I can't install pip here. Please install pip for Python 3 and run this again."; exit 1 ;;
        esac || { bad "Installing pip failed. The details:"; tail -n 15 "$LOG"; exit 1; }
    fi
    ok "Python $(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])') is ready."

    # ---- 2. Dependencies ----------------------------------------------------
    step 2 $TOTAL "Installing the ingredients"
    if [ ! -f "requirements.txt" ]; then
        bad "requirements.txt is missing, so I don't know what to install."
        exit 1
    fi
    # Python 3.11+ on Debian/Ubuntu marks the system Python "externally managed"
    PYVER=$(python3 -c "import sys; print('%d.%d' % sys.version_info[:2])")
    if [ -f "/usr/lib/python${PYVER}/EXTERNALLY-MANAGED" ] || [ -f "/usr/lib/python3/EXTERNALLY-MANAGED" ]; then
        PIP_FLAGS="--break-system-packages"
    fi
    n_pkgs=$(grep -cvE '^[[:space:]]*(#|$)' requirements.txt || true)
    note "$n_pkgs packages. $(pick "Slow and steady wins the race." "Your internet connection is being tested. Politely." "No snails were harmed.")"
    if run_quiet "Installing packages (this is the slow part)..." "$LOG" python3 -m pip install -r requirements.txt $PIP_FLAGS; then
        ok "All packages installed."
    elif run_quiet "That bumped into an existing install. Trying again, firmly..." "$LOG" python3 -m pip install -r requirements.txt $PIP_FLAGS --ignore-installed; then
        ok "All packages installed."
    else
        bad "pip couldn't install everything. The last lines of its output:"
        echo
        tail -n 15 "$LOG" | sed 's/^/      /'
        echo
        note "Most often this is the internet connection. Fix it and run ./Snail.sh again."
        exit 1
    fi

    # ---- 3. About you (admin account, port, AI key) -------------------------
    step 3 $TOTAL "A few questions"
    # instance/ and the files in it must belong to the real user, not root
    mkdir -p instance
    if [ -n "${SUDO_USER:-}" ]; then chown "$SUDO_USER" instance; fi
    as_user python3 "$WIZARD" ask

    # ---- 4. Finishing touches -----------------------------------------------
    step 4 $TOTAL "Finishing touches"
    # The 'snailsynk' command, so you can start it from any terminal
    mkdir -p /usr/local/bin
    cat << EOF > /usr/local/bin/snailsynk
#!/bin/bash
exec bash "$(pwd)/Snail.sh" "\$@"
EOF
    chmod +x /usr/local/bin/snailsynk
    ok "Created the 'snailsynk' command. Type it in any terminal to start."

    if ! create_desktop_icon; then
        warn "Couldn't create the desktop shortcut. Not a big deal."
    elif [ "$(uname -s)" = "Linux" ]; then
        ok "Desktop shortcut created."
        note "(GNOME shows an X on it? Right-click it and choose 'Allow Launching'.)"
    fi

    echo "Installation completed on $(date)" > install.loc
    if [ -n "${SUDO_USER:-}" ]; then
        chown "$SUDO_USER" install.loc
        if [ -f .env ]; then chown "$SUDO_USER" .env; fi
        chown -R "$SUDO_USER" instance
    fi
    rm -f "$LOG"

    as_user python3 "$WIZARD" done --cmd "type  snailsynk  in any terminal, or use the desktop shortcut." --reset "./Snail.sh --reset-admin"
    if [ -t 0 ]; then read -rp "  Press [Enter] to launch it... " _ || true; fi
}

# --------------------------------------------------------------------------------
# Uninstall / clean install (the deleting itself is done by essentials/cleanup.py)
# --------------------------------------------------------------------------------
# Removes the 'snailsynk' command and the shortcuts that setup created.
remove_integration() {
    local u_home="$HOME" f left=() failed=0
    if [ -n "${SUDO_USER:-}" ]; then u_home=$(getent passwd "$SUDO_USER" | cut -d: -f6); fi
    rm -f "$u_home/Desktop/SnailSynk.desktop" "$u_home/.local/share/applications/SnailSynk.desktop" \
          "$u_home/.local/share/icons/snailsynk.png"
    # setup created these as root: try without sudo first, and only ask for it if something is left
    for f in /usr/local/bin/snailsynk /usr/share/applications/SnailSynk.desktop /usr/share/pixmaps/snailsynk.png; do
        rm -f "$f" 2> /dev/null || true
        if [ -e "$f" ]; then left+=("$f"); fi
    done
    if [ "${#left[@]}" -gt 0 ]; then
        if [ "$EUID" -eq 0 ]; then
            rm -f "${left[@]}" || failed=1
        elif command -v sudo &> /dev/null; then
            note "Removing the 'snailsynk' command needs sudo."
            sudo rm -f "${left[@]}" || failed=1
        else
            failed=1
        fi
    fi
    if [ "$failed" -eq 1 ]; then
        warn "Couldn't remove everything. Delete these yourself: ${left[*]}"
    else
        ok "Removed the shortcuts and the 'snailsynk' command."
    fi
}

# Asks "are you sure?" (cleanup.py shows exactly what goes and what stays). Returns non-zero if you said no.
confirm_cleanup() {
    if ! command -v python3 &> /dev/null; then
        bad "python3 wasn't found, and I need it to do this safely."
        exit 1
    fi
    if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
    as_user python3 -B essentials/cleanup.py "$1" --ask-only
}

uninstall_routine() {
    banner "uninstall"
    if confirm_cleanup uninstall; then
        remove_integration
        as_user python3 -B essentials/cleanup.py uninstall --yes
    else
        return 1
    fi
}

clean_routine() {
    banner "clean install"
    if confirm_cleanup clean; then
        as_user python3 -B essentials/cleanup.py clean --yes
    else
        return 1
    fi
}

# --------------------------------------------------------------------------------
# Launch
# --------------------------------------------------------------------------------
launch_routine() {
    local rc=0
    if [ -t 1 ]; then clear; fi
    banner "$(pick \
        "waking up the snail..." \
        "polishing the slime trail..." \
        "warming up the shell..." \
        "packing lettuce for the journey...")"

    if ! command -v python3 &> /dev/null; then
        bad "python3 wasn't found. Run  ./Snail.sh --setup  to fix that."
        exit 1
    fi

    # Open the browser as soon as the server is actually listening (not after a blind delay).
    # Done as the real user, so it opens in their browser and not root's.
    as_user python3 "$WIZARD" open-browser &> /dev/null &

    # Don't let Ctrl+C kill this script: we want to say goodbye after the server stops.
    trap : INT
    as_user python3 SnailSynk.py || rc=$?
    trap - INT

    as_user python3 "$WIZARD" bye --rc "$rc" || true
    exit "$rc"
}

# First run: do the setup with administrator rights, then carry on as the normal user
elevate_and_setup() {
    if [ "$EUID" -eq 0 ]; then
        setup_routine
        return
    fi
    banner "one-time setup"
    say "  ${C_BOLD}One thing first: I'm going to ask for your password (sudo).${C_RESET}"
    note "It's only to install packages and create the 'snailsynk' command."
    note "The web server itself never runs as root. The snail is not that reckless."
    echo
    if ! command -v sudo &> /dev/null; then
        bad "sudo isn't available. Run this script as root once:  su -c './Snail.sh'"
        exit 1
    fi
    sudo bash "$0" --run-setup
}

# ================================================================================
#                                 MAIN LOGIC
# ================================================================================
ASSUME_YES=0
if [ "${2:-}" = "--yes" ] || [ "${2:-}" = "-y" ]; then ASSUME_YES=1; fi

case "${1:-}" in
    --help|-h)
        usage
        exit 0 ;;
    --reset-admin)
        if ! command -v python3 &> /dev/null; then
            bad "python3 wasn't found. Run ./Snail.sh once first so it can set things up."
            exit 1
        fi
        python3 "$WIZARD" reset-admin
        exit $? ;;
    --set-icon)
        create_desktop_icon
        exit ;;
    --uninstall)
        # the whole case is read before it runs, so it is safe that this script deletes itself on the way out
        rc=0; uninstall_routine || rc=$?
        exit "$rc" ;;
    --clean-install)
        # wipe all data, then fall through to a first-run setup and launch
        if ! clean_routine; then exit 1; fi
        elevate_and_setup
        launch_routine ;;
    --run-setup)
        # internal: the elevated half of the first run
        if [ "$EUID" -ne 0 ]; then
            bad "Setup needs administrator rights, and I didn't get them."
            exit 1
        fi
        setup_routine
        exit 0 ;;
    --setup)
        rm -f install.loc
        elevate_and_setup
        launch_routine ;;
    "") ;;
    *)
        bad "I don't know what '$1' means."
        usage
        exit 1 ;;
esac

# Standard run: set up on the first run, then launch
if [ ! -f "install.loc" ]; then
    elevate_and_setup
fi
launch_routine
