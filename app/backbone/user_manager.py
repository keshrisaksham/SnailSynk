# backbone/user_manager.py
import os
import sys
import hmac
import json
import logging
from pathlib import Path
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from .storage import atomic_write_json, load_json

class UserManager:
    """Handles admin user authentication and credential management."""
    def __init__(self, config_path):
        self.config_path = Path(config_path)
        self.config_path.parent.mkdir(exist_ok=True)
        self.ph = PasswordHasher()
        self.user_data = self._load_or_initialize_user()

    def _load_or_initialize_user(self):
        existing = load_json(self.config_path, None, dict, 'admin credentials')
        if existing and 'username' in existing and 'password_hash' in existing:
            return existing

        username = os.environ.get('SNAILSYNK_ADMIN_USER')
        password = os.environ.get('SNAILSYNK_ADMIN_PASS')

        if not username or not password:
            logging.warning("Admin user not configured. Run with SNAILSYNK_ADMIN_USER and SNAILSYNK_ADMIN_PASS to create one.")
            return None

        hashed_password = self.ph.hash(password)
        user_data = {'username': username, 'password_hash': hashed_password}

        try:
            atomic_write_json(self.config_path, user_data, mode=0o600)
            logging.info(f"Admin user '{username}' created and saved to {self.config_path}")
            del password
            return user_data
        except Exception as e:
            logging.error(f"FATAL: Could not write admin config file to {self.config_path}: {e}")
            sys.exit(1)

    def verify_password(self, username, password):
        if not self.user_data or not isinstance(username, str) or not isinstance(password, str):
            return False
        # Always run the (slow) hash check so response time does not reveal whether the username exists
        try:
            self.ph.verify(self.user_data['password_hash'], password)
            return hmac.compare_digest(self.user_data.get('username', '').encode(), username.encode())
        except VerifyMismatchError:
            return False
        except Exception as e:
            logging.error(f"An unexpected error occurred during password verification: {e}")
            return False