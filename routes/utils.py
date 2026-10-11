# routes/utils.py
import socket
import platform
import subprocess
import logging

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 1))
        ip_address = s.getsockname()[0]
    except Exception:
        ip_address = '127.0.0.1'
    finally:
        s.close()
    return ip_address

def _run_cmd(cmd, shell=False, timeout=3):
    """Run a command with a timeout, return output or None on failure."""
    try:
        output = subprocess.check_output(
            cmd, shell=shell, stderr=subprocess.DEVNULL, text=True, timeout=timeout
        )
        return output.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return None

def get_current_ssid():
    try:
        system = platform.system()
        if system == 'Windows':
            output = _run_cmd("netsh wlan show interfaces", shell=True)
            if output:
                for line in output.split('\n'):
                    if "SSID" in line and ":" in line and "BSSID" not in line:
                        return line.split(":")[1].strip()
        elif system == 'Darwin':
            output = _run_cmd(
                "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I",
                shell=True
            )
            if output:
                for line in output.split('\n'):
                    if " SSID" in line and ":" in line:
                        return line.split(":")[1].strip()
        elif system == 'Linux':
            # Try multiple methods for Linux compatibility (Debian, Ubuntu, Arch, etc.)
            
            # Method 1: nmcli (NetworkManager — most common on Debian/Ubuntu desktops)
            output = _run_cmd(["nmcli", "-t", "-f", "active,ssid", "dev", "wifi"])
            if output:
                for line in output.split('\n'):
                    if line.startswith('yes:'):
                        ssid = line.split(':', 1)[1].strip()
                        if ssid:
                            return ssid
            
            # Method 2: iwgetid (wireless-tools — not always installed on Debian)
            output = _run_cmd(["iwgetid", "-r"])
            if output:
                return output
            
            # Method 3: iw (low-level, usually available)
            output = _run_cmd(["iw", "dev"])
            if output:
                for line in output.split('\n'):
                    if 'ssid' in line.lower():
                        parts = line.strip().split()
                        if len(parts) >= 2:
                            return parts[-1]
            
            logging.debug("No Wi-Fi SSID found via any method (device may be using Ethernet).")
            return None
    except Exception:
        logging.debug("Could not determine Wi-Fi SSID.")
        return None
    return None