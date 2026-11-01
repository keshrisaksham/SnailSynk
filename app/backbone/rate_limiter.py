# backbone/rate_limiter.py
import time

class RateLimiter:
    """Small in-memory limiter: after `max_attempts` failures within `window` seconds,
    a key is blocked for `lockout` seconds. Safe under gevent (no blocking calls)."""
    def __init__(self, max_attempts=5, window=600, lockout=300):
        self.max_attempts = max_attempts
        self.window = window
        self.lockout = lockout
        self._failures = {}   # key -> [timestamps]
        self._locked_until = {}

    def retry_after(self, key):
        """Seconds until `key` may try again (0 if allowed now)."""
        until = self._locked_until.get(key)
        if not until:
            return 0
        remaining = until - time.monotonic()
        if remaining <= 0:
            self._locked_until.pop(key, None)
            self._failures.pop(key, None)
            return 0
        return int(remaining) + 1

    def record_failure(self, key):
        now = time.monotonic()
        recent = [t for t in self._failures.get(key, []) if now - t < self.window]
        recent.append(now)
        self._failures[key] = recent
        if len(recent) >= self.max_attempts:
            self._locked_until[key] = now + self.lockout
        if len(self._failures) > 5000:  # keep memory bounded
            self._prune(now)

    def reset(self, key):
        self._failures.pop(key, None)
        self._locked_until.pop(key, None)

    def hit(self, key):
        """Count an attempt regardless of outcome (for plain request-rate limiting).
        Returns seconds to wait, or 0 if the request is allowed."""
        wait = self.retry_after(key)
        if wait:
            return wait
        self.record_failure(key)
        return self.retry_after(key)

    def _prune(self, now):
        for k in [k for k, v in self._failures.items() if not v or now - v[-1] >= self.window]:
            self._failures.pop(k, None)
        for k in [k for k, t in self._locked_until.items() if t <= now]:
            self._locked_until.pop(k, None)
