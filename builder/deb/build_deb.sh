#!/bin/bash
# ================================================================================
# Builds the SnailSynk Debian package (architecture "all": it is plain Python).
#
#   builder/deb/build_deb.sh                builds dist/snailsynk_<version>_all.deb
#   builder/deb/build_deb.sh 2.1.0          same, with another version number
#   MAINTAINER="Name <mail>" builder/deb/build_deb.sh
#
# Needs only dpkg-deb (and fakeroot, if present, so the files are owned by root in the package).
# Install the result with:  sudo apt install ./dist/snailsynk_<version>_all.deb
# ================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

PKG=snailsynk
VERSION="${1:-$(tr -d '[:space:]' < VERSION)}"
MAINTAINER="${MAINTAINER:-Kumar <keshrisaksham9@gmail.com>}"
STAGE="$ROOT/build/deb/${PKG}_${VERSION}_all"
OUT="$ROOT/dist/${PKG}_${VERSION}_all.deb"
APP="$STAGE/usr/share/$PKG"

command -v dpkg-deb > /dev/null || { echo "dpkg-deb not found: build this on Debian, Ubuntu, Kali or similar." >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9][A-Za-z0-9.+~]*$ ]] || { echo "'$VERSION' is not a valid Debian version." >&2; exit 1; }

echo ">> Staging $PKG $VERSION"
rm -rf "$STAGE"
mkdir -p "$APP" "$STAGE/DEBIAN" "$STAGE/usr/bin" "$STAGE/usr/share/applications" \
         "$STAGE/usr/share/icons/hicolor/512x512/apps" "$STAGE/usr/share/man/man1" "$STAGE/usr/share/doc/$PKG"

# --- The application: only what runs. Never .env, instance/, the installers or the self-updater. ---
EXCLUDES=(--exclude '__pycache__' --exclude '*.pyc' --exclude '*_backup.html')
cp app/SnailSynk.py app/launcher.py app/setup_wizard.py app/porter.py app/qr_gen.py "$APP/"
rsync -a "${EXCLUDES[@]}" app/backbone app/routes app/templates app/static "$APP/"
echo "$VERSION" > "$APP/VERSION"

LEAKED="$(find "$STAGE" \( -name '.env' -o -name 'instance' -o -name 'user.json' -o -name '*.pem' -o -name 'secret_key' \) -print)"
[ -z "$LEAKED" ] || { echo "Refusing to build: private files ended up in the package:" >&2; echo "$LEAKED" >&2; exit 1; }

# --- Launcher, menu entry, icon, docs ---
printf '#!/bin/sh\nexec python3 /usr/share/%s/launcher.py "$@"\n' "$PKG" > "$STAGE/usr/bin/$PKG"
install -m 644 "$HERE/snailsynk.desktop" "$STAGE/usr/share/applications/$PKG.desktop"
install -m 644 app/static/icon/favicon.png "$STAGE/usr/share/icons/hicolor/512x512/apps/$PKG.png"
gzip -9n -c "$HERE/snailsynk.1" > "$STAGE/usr/share/man/man1/$PKG.1.gz"
install -m 644 "$HERE/copyright" "$HERE/README.Debian" "$STAGE/usr/share/doc/$PKG/"
install -m 644 ReadME.md "$STAGE/usr/share/doc/$PKG/README.md"
printf '%s (%s) unstable; urgency=medium\n\n  * Release %s.\n\n -- %s  %s\n' \
    "$PKG" "$VERSION" "$VERSION" "$MAINTAINER" "$(date -R)" | gzip -9n > "$STAGE/usr/share/doc/$PKG/changelog.gz"
gzip -9n "$STAGE/usr/share/doc/$PKG/README.md"

# --- Permissions: directories 755, files 644, only the launcher and maintainer scripts executable ---
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
chmod 755 "$STAGE/usr/bin/$PKG"
install -m 755 "$HERE/postinst" "$HERE/prerm" "$STAGE/DEBIAN/"

# --- Control file, checksums ---
SIZE_KB="$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)"
cat > "$STAGE/DEBIAN/control" << EOF
Package: $PKG
Version: $VERSION
Architecture: all
Section: net
Priority: optional
Maintainer: $MAINTAINER
Installed-Size: $SIZE_KB
Depends: python3 (>= 3.8), python3-flask, python3-flask-socketio, python3-gevent, python3-gevent-websocket, python3-argon2, python3-dotenv, python3-qrcode, python3-rich, python3-cryptography
Recommends: python3-pyperclip
Suggests: python3-pip
Homepage: https://github.com/keshrisaksham/SnailSynk
Description: share files, text and notes on your own network
 SnailSynk is a small HTTPS web server for moving files, a shared text buffer
 and notes between the devices on a trusted network, with an admin dashboard,
 QR codes for phones and live updates over WebSockets.
 .
 The optional AI chat needs the Google Gemini client (google-genai), which is
 not packaged in Debian; see /usr/share/doc/snailsynk/README.Debian.
EOF
( cd "$STAGE" && find usr -type f -print0 | sort -z | xargs -0 md5sum > DEBIAN/md5sums )

# --- Build ---
mkdir -p "$ROOT/dist"
if command -v fakeroot > /dev/null; then
    fakeroot dpkg-deb --build --root-owner-group -Zxz "$STAGE" "$OUT"
else
    dpkg-deb --build --root-owner-group -Zxz "$STAGE" "$OUT"
fi

echo
echo ">> Built $OUT ($(du -h "$OUT" | cut -f1))"
if command -v lintian > /dev/null; then
    echo ">> lintian:"; lintian "$OUT" || true
else
    echo ">> (lintian is not installed; 'sudo apt install lintian' to check the package for policy problems.)"
fi
echo ">> Install:  sudo apt install $OUT"
