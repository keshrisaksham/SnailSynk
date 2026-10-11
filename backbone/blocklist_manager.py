# backbone/blocklist_manager.py
import json
import logging
from pathlib import Path
from ipaddress import ip_address
from .utils import log_history
from .storage import atomic_write_json, load_json

class BlocklistManager:
    """Manages the IP blocklist for the application."""
    def __init__(self, blocklist_path):
        self.path = Path(blocklist_path)
        self.blocked_ips = self._load()

    def _load(self):
        return set(load_json(self.path, [], list, 'IP blocklist'))

    def _save(self):
        try:
            atomic_write_json(self.path, sorted(self.blocked_ips))
        except OSError as e:
            logging.error(f"Could not save blocklist file to {self.path}: {e}")

    def is_valid_ip(self, ip_string):
        try:
            ip_address(ip_string)
            return True
        except ValueError: return False

    def block_ip(self, ip_to_block):
        if not self.is_valid_ip(ip_to_block): return False, "Invalid IP address format."
        if ip_to_block in self.blocked_ips: return True, "IP is already blocked."
        self.blocked_ips.add(ip_to_block)
        self._save()
        log_history("IP Blocked", f"'{ip_to_block}' was added to the blocklist.")
        return True, f"IP {ip_to_block} blocked successfully."

    def unblock_ip(self, ip_to_unblock):
        if ip_to_unblock not in self.blocked_ips: return False, "IP was not found in the blocklist."
        self.blocked_ips.remove(ip_to_unblock)
        self._save()
        log_history("IP Unblocked", f"'{ip_to_unblock}' was removed from the blocklist.")
        return True, f"IP {ip_to_unblock} unblocked successfully."

    def is_blocked(self, ip_to_check):
        return ip_to_check in self.blocked_ips

    def get_blocklist(self):
        return sorted(list(self.blocked_ips))