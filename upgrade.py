"""
upgrade.py — SnailSynk Upgrade Script

Downloads the latest version of SnailSynk from GitHub and replaces all
application files in an existing installation while preserving user data
(.env, instance/, install.loc, etc.).

Can be run standalone — no dependencies beyond the Python standard library.

Usage:
    python upgrade.py
    python upgrade.py --target "C:\\path\\to\\SnailSynk"
"""

import os
import sys
import shutil
import zipfile
import tempfile
import argparse
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError

# ──────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────

GITHUB_REPO = "keshrisaksham/SnailSynk"
GITHUB_ZIP_URL = f"https://github.com/{GITHUB_REPO}/archive/refs/heads/main.zip"

# Files and directories that must NEVER be overwritten during an upgrade.
# These contain user-specific data, secrets, or generated content.
PRESERVE = {
    ".env",
    "instance",
    "install.loc",
    "Current",
    "__pycache__",
    ".git",
    ".install_lock",
}

# File patterns (extensions) that should also be preserved
PRESERVE_EXTENSIONS = {".log", ".pyc"}


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────

def print_header():
    print("=" * 60)
    print("       SnailSynk Upgrade Utility")
    print("=" * 60)
    print()


def print_step(msg):
    print(f"  [+] {msg}")


def print_warn(msg):
    print(f"  [!] {msg}")


def print_error(msg):
    print(f"  [✘] {msg}")


def should_preserve(rel_path: str) -> bool:
    """Return True if this relative path should NOT be replaced."""
    parts = Path(rel_path).parts

    # Check if any path component matches a preserved name
    for part in parts:
        if part in PRESERVE:
            return True

    # Check extension-based preservation
    ext = Path(rel_path).suffix
    if ext in PRESERVE_EXTENSIONS:
        return True

    return False


def ask_target_folder() -> Path:
    """Prompt the user to enter the path to their SnailSynk installation."""
    print("Please enter the full path to your existing SnailSynk folder.")
    print("  Example (Windows): C:\\Users\\you\\SnailSynk")
    print("  Example (Linux):   /home/you/SnailSynk")
    print()

    while True:
        raw = input("  -> SnailSynk folder path: ").strip().strip('"').strip("'")
        if not raw:
            print_warn("Path cannot be empty. Try again.\n")
            continue

        target = Path(raw)
        if not target.is_dir():
            print_warn(f'"{target}" is not a valid directory. Try again.\n')
            continue

        # Sanity check: look for SnailSynk.py inside
        if not (target / "SnailSynk.py").exists():
            print_warn(
                f'"SnailSynk.py" not found inside "{target}".\n'
                "  Are you sure this is the right folder?"
            )
            confirm = input("  -> Continue anyway? (y/N): ").strip().lower()
            if confirm not in ("y", "yes"):
                continue

        return target


def download_zip(dest: Path) -> Path:
    """Download the latest repo ZIP from GitHub into *dest* and return
    the path to the downloaded file."""
    zip_path = dest / "snailsynk-latest.zip"
    print_step(f"Downloading from {GITHUB_ZIP_URL} ...")

    try:
        req = Request(GITHUB_ZIP_URL, headers={"User-Agent": "SnailSynk-Upgrader/1.0"})
        with urlopen(req, timeout=60) as resp, open(zip_path, "wb") as f:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 1024 * 64  # 64 KB chunks

            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    pct = downloaded * 100 // total
                    bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
                    print(f"\r  [+] Downloading: [{bar}] {pct}%", end="", flush=True)

            print()  # newline after progress bar

    except URLError as e:
        print_error(f"Download failed: {e}")
        print_error("Check your internet connection and try again.")
        sys.exit(1)

    print_step(f"Downloaded {downloaded:,} bytes.")
    return zip_path


def extract_zip(zip_path: Path, dest: Path) -> Path:
    """Extract the ZIP and return the path to the repo root inside it.
    GitHub ZIPs contain a single top-level folder like 'SnailSynk-main/'."""
    print_step("Extracting archive ...")

    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(dest)

    # Find the single top-level directory GitHub creates
    children = [d for d in dest.iterdir() if d.is_dir() and d.name != "__MACOSX"]
    if len(children) == 1:
        return children[0]

    # Fallback: look for one that contains SnailSynk.py
    for child in children:
        if (child / "SnailSynk.py").exists():
            return child

    print_error("Could not locate the project root inside the downloaded archive.")
    sys.exit(1)


def sync_files(source: Path, target: Path):
    """Walk *source* and copy every file into *target*, skipping preserved
    paths.  Directories are created as needed.  Existing files are overwritten."""
    replaced = 0
    added = 0
    skipped = 0

    for src_file in source.rglob("*"):
        if src_file.is_dir():
            continue

        rel = src_file.relative_to(source)

        if should_preserve(str(rel)):
            skipped += 1
            continue

        dst_file = target / rel
        dst_file.parent.mkdir(parents=True, exist_ok=True)

        already_exists = dst_file.exists()
        shutil.copy2(src_file, dst_file)

        if already_exists:
            replaced += 1
        else:
            added += 1

    return replaced, added, skipped


# ──────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Upgrade SnailSynk to the latest version.")
    parser.add_argument(
        "--target", "-t",
        type=str,
        default=None,
        help="Path to the existing SnailSynk installation folder.",
    )
    args = parser.parse_args()

    print_header()

    # 1. Determine target folder
    if args.target:
        target = Path(args.target)
        if not target.is_dir():
            print_error(f'"{target}" is not a valid directory.')
            sys.exit(1)
    else:
        target = ask_target_folder()

    print_step(f"Upgrade target: {target}")
    print()

    # 2. Confirm
    print("  The following items will NOT be touched (preserved):")
    for item in sorted(PRESERVE):
        print(f"    • {item}")
    print(f"    • Files with extensions: {', '.join(sorted(PRESERVE_EXTENSIONS))}")
    print()
    print("  Everything else will be replaced with the latest version from GitHub.")
    confirm = input("  -> Proceed with upgrade? (y/N): ").strip().lower()
    if confirm not in ("y", "yes"):
        print("\n  Upgrade cancelled.")
        sys.exit(0)
    print()

    # 3. Download and extract
    with tempfile.TemporaryDirectory(prefix="snailsynk_upgrade_") as tmp:
        tmp_path = Path(tmp)
        zip_path = download_zip(tmp_path)
        source = extract_zip(zip_path, tmp_path)

        print_step(f"Source: {source.name}")
        print()

        # 4. Sync files
        print_step("Upgrading files ...")
        replaced, added, skipped = sync_files(source, target)

    # 5. Summary
    print()
    print("=" * 60)
    print("       Upgrade Complete!")
    print("=" * 60)
    print(f"    Files replaced : {replaced}")
    print(f"    Files added    : {added}")
    print(f"    Files skipped  : {skipped}  (preserved)")
    print()
    print("  Your .env, instance data, and other user files are untouched.")
    print("  Restart SnailSynk to use the new version.")
    print()


if __name__ == "__main__":
    main()
