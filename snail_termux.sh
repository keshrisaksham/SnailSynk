#!/data/data/com.termux/files/usr/bin/bash

# ================================================================================
# SnailSynk Setup & Launch Script for Termux (Android)
# ================================================================================
# No root / sudo required. Uses Termux's pkg manager for system packages.
#
#   bash snail_termux.sh                 first run: setup, then start. After that: just start.
#   bash snail_termux.sh --uninstall     remove SnailSynk, but keep your notes and the uploaded files.
#   bash snail_termux.sh --clean-install erase EVERYTHING (notes and uploads too), then install from scratch.
#   bash snail_termux.sh --help          this list.
#   (add --yes to --uninstall / --clean-install to skip the "are you sure?" question)

set -e

# --- CRITICAL: Change to the script's directory ---
cd "$(dirname "$0")"

# --- Pretty printing ---
GREEN="\033[1;32m"
RED="\033[1;31m"
CYAN="\033[1;36m"
YELLOW="\033[1;33m"
RESET="\033[0m"

print_header() {
    echo ""
    echo -e "${CYAN}======================================================${RESET}"
    echo -e "${CYAN}  $1${RESET}"
    echo -e "${CYAN}======================================================${RESET}"
    echo ""
}

print_step() {
    echo -e "${GREEN}[+]${RESET} $1"
}

print_warn() {
    echo -e "${YELLOW}[!]${RESET} $1"
}

print_error() {
    echo -e "${RED}[✗]${RESET} $1"
}

# ================================================================================
# SETUP ROUTINE (skipped after first run)
# ================================================================================
setup_routine() {
    print_header "SNAILSYNK ONE-TIME SETUP (Termux)"

    # --- 1. Install system packages via pkg (no root needed) ---
    print_step "Updating Termux packages..."
    pkg update -y && pkg upgrade -y

    print_step "Installing required system packages..."
    pkg install -y python openssl libffi rust binutils

    # Ensure pip is available
    if ! command -v pip &> /dev/null; then
        print_step "Installing pip..."
        python -m ensurepip --upgrade 2>/dev/null || pkg install -y python-pip
    fi
    echo ""

    # --- 2. Install Python dependencies ---
    print_step "Installing Python dependencies from requirements.txt..."
    if [ -f "requirements.txt" ]; then
        while IFS= read -r package || [ -n "$package" ]; do
            # Skip empty lines and comments
            package=$(echo "$package" | xargs)
            if [ -n "$package" ] && [[ ! "$package" =~ ^# ]]; then
                echo ""
                echo -e "   ${CYAN}Installing: ${package}${RESET}"
                pip install "$package" || {
                    print_warn "Failed to install $package, trying with --no-build-isolation..."
                    pip install "$package" --no-build-isolation || {
                        print_warn "Skipping $package (may need manual install)"
                    }
                }
            fi
        done < "requirements.txt"
        echo ""
        print_step "Dependencies installation complete."
    else
        print_error "requirements.txt not found!"
        exit 1
    fi
    echo ""

    # --- 3. Create .env configuration ---
    print_step "Creating .env configuration file..."
    echo ""
    read -p "   -> Enter your admin username: " ADMIN_USER
    read -sp "   -> Enter a secure password: " ADMIN_PASS
    echo ""
    read -p "   -> Enter a random string for the Flask secret key: " FLASK_SECRET
    read -p "   -> Enter your Gemini API key (or press Enter to skip): " GEMINI_KEY
    read -p "   -> Enter the port number (default: 9000, press Enter to skip): " APP_PORT

    if [ -z "$APP_PORT" ]; then
        APP_PORT="9000"
    fi

    cat > .env << EOF
SNAILSYNK_ADMIN_USER="${ADMIN_USER}"
SNAILSYNK_ADMIN_PASS="${ADMIN_PASS}"
FLASK_SECRET_KEY="${FLASK_SECRET}"
GEMINI_API_KEY="${GEMINI_KEY}"
SNAILSYNK_PORT=${APP_PORT}
EOF

    print_step ".env file created successfully."
    echo ""

    # --- 4. Grant Termux storage access (for file transfers) ---
    print_step "Requesting storage access..."
    termux-setup-storage 2>/dev/null || print_warn "Storage access prompt may appear separately."
    echo ""

    # --- 5. Create install marker ---
    echo "Installation completed on $(date)" > install.loc
    print_step "Installation marker created."
    echo ""

    # --- 6. Create a helper alias ---
    ALIAS_LINE="alias snailsynk='cd \"$(pwd)\" && python SnailSynk.py'"
    if ! grep -q "alias snailsynk" "$HOME/.bashrc" 2>/dev/null; then
        echo "" >> "$HOME/.bashrc"
        echo "# SnailSynk launcher" >> "$HOME/.bashrc"
        echo "$ALIAS_LINE" >> "$HOME/.bashrc"
        print_step "Added 'snailsynk' alias to .bashrc"
        print_step "After restart, you can launch with: snailsynk"
    else
        print_warn "'snailsynk' alias already exists in .bashrc"
    fi
    echo ""

    print_header "SETUP COMPLETE! The application will now start."
    read -p "Press [Enter] to continue..."
}

# ================================================================================
# APPLICATION LAUNCH ROUTINE
# ================================================================================
launch_routine() {
    clear
    print_header "Starting SnailSynk (Termux)"

    # Read port from .env
    LAUNCH_PORT="9000"
    if [ -f ".env" ]; then
        PORT_LINE=$(grep "^SNAILSYNK_PORT" .env 2>/dev/null)
        if [ -n "$PORT_LINE" ]; then
            LAUNCH_PORT=$(echo "$PORT_LINE" | cut -d'=' -f2)
        fi
    fi

    echo -e "   ${GREEN}Server will start on port ${LAUNCH_PORT}${RESET}"
    echo -e "   ${CYAN}Open in browser: https://localhost:${LAUNCH_PORT}${RESET}"
    echo ""

    # Try to open browser via Termux API (optional, won't fail if not installed)
    (sleep 3 && termux-open-url "https://localhost:${LAUNCH_PORT}" 2>/dev/null) &

    # Start the application
    python SnailSynk.py
}

# ================================================================================
# UNINSTALL / CLEAN INSTALL (the deleting itself is done by essentials/cleanup.py)
# ================================================================================
usage() {
    echo ""
    echo "  bash snail_termux.sh                 first run: setup, then start. After that: just start."
    echo "  bash snail_termux.sh --uninstall     remove SnailSynk, keeping your notes and uploaded files."
    echo "  bash snail_termux.sh --clean-install erase everything (notes and uploads too), install from scratch."
    echo "  bash snail_termux.sh --help          show this."
    echo "    (add --yes to --uninstall or --clean-install to skip the question)"
    echo ""
}

# Asks "are you sure?" (cleanup.py shows exactly what goes and what stays). Returns non-zero if you said no.
confirm_cleanup() {
    if ! command -v python &> /dev/null; then
        print_error "python wasn't found, and I need it to do this safely."
        exit 1
    fi
    if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
    python -B essentials/cleanup.py "$1" --ask-only
}

uninstall_routine() {
    print_header "SNAILSYNK UNINSTALL (Termux)"
    confirm_cleanup uninstall || return 1
    # the 'snailsynk' alias that setup added
    if [ -f "$HOME/.bashrc" ]; then
        sed -i '/# SnailSynk launcher/d;/alias snailsynk=/d' "$HOME/.bashrc" 2>/dev/null || true
        print_step "Removed the 'snailsynk' alias from .bashrc"
    fi
    python -B essentials/cleanup.py uninstall --yes
}

clean_routine() {
    print_header "SNAILSYNK CLEAN INSTALL (Termux)"
    confirm_cleanup clean || return 1
    python -B essentials/cleanup.py clean --yes
}

# ================================================================================
#                                 MAIN LOGIC
# ================================================================================
ASSUME_YES=0
if [ "${2:-}" = "--yes" ] || [ "${2:-}" = "-y" ]; then ASSUME_YES=1; fi

# (the whole case is read before it runs, so it is safe that this script deletes itself on the way out)
case "${1:-}" in
    --help|-h)
        usage
        exit 0 ;;
    --uninstall)
        rc=0; uninstall_routine || rc=$?
        exit "$rc" ;;
    --clean-install)
        if ! clean_routine; then exit 1; fi
        setup_routine
        launch_routine
        exit 0 ;;
    "") ;;
    *)
        print_error "I don't know what '$1' means."
        usage
        exit 1 ;;
esac

if [ -f "install.loc" ]; then
    launch_routine
else
    setup_routine
    launch_routine
fi
