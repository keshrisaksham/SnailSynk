"""
porter.py — HTTP-to-HTTPS Connection Upgrade Handler

Provides transparent HTTP→HTTPS redirection on the SAME port. When a client
connects, the first byte is inspected:

  - 0x16 (TLS ClientHello) → wrapped in SSL, handled normally by Flask
  - Anything else (plain HTTP) → 301 redirect to the HTTPS equivalent

Works with both **gevent** and **eventlet** async modes.

Usage:
    from porter import Porter

    porter = Porter(certfile, keyfile, https_port)
    porter.activate()   # must be called BEFORE socketio.run()

    socketio.run(app, host='0.0.0.0', port=APP_PORT,
                 certfile=certfile, keyfile=keyfile)
"""

import ssl
import socket as _socket


class Porter:
    """Handles HTTP → HTTPS connection upgrades on the same port.

    Call ``activate()`` before starting the server. It monkey-patches the
    SSL-wrapping step so that every accepted connection is first inspected:
    plain HTTP gets a 301 redirect; TLS proceeds normally.
    """

    def __init__(self, certfile, keyfile, https_port):
        self._certfile = certfile
        self._keyfile = keyfile
        self._https_port = https_port

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def activate(self):
        """Monkey-patch the SSL wrapping so that plain HTTP connections on
        the HTTPS port are automatically redirected.

        Supports both gevent and eventlet async modes.
        Must be called **before** ``socketio.run()``.
        """
        # Try gevent first (since it's in requirements.txt)
        try:
            import gevent
            self._patch_gevent()
            return
        except ImportError:
            pass

        # Fall back to eventlet
        try:
            import eventlet
            self._patch_eventlet(eventlet)
            return
        except ImportError:
            pass

        # Fallback: stdlib ssl (werkzeug threading mode)
        self._patch_stdlib_ssl()

    # ------------------------------------------------------------------
    # Gevent path
    # ------------------------------------------------------------------
    def _patch_gevent(self):
        """Patch gevent's StreamServer to use a dual-protocol accept."""
        from gevent import pywsgi
        from gevent import ssl as gevent_ssl

        porter = self

        _original_init = pywsgi.WSGIServer.__init__

        def patched_init(server_self, *args, **kwargs):
            _original_init(server_self, *args, **kwargs)
            # Wrap the server's socket handler after init
            if hasattr(server_self, 'wrap_socket_and_handle'):
                original_wrap = server_self.wrap_socket_and_handle

                def dual_protocol_handler(client_socket, address):
                    try:
                        client_socket.settimeout(5)
                        first_byte = client_socket.recv(1, _socket.MSG_PEEK)

                        if not first_byte:
                            client_socket.close()
                            return

                        if first_byte[0] == 0x16:
                            # TLS ClientHello → proceed normally with SSL
                            client_socket.settimeout(None)
                            return original_wrap(client_socket, address)
                        else:
                            # Plain HTTP → redirect to HTTPS
                            porter._redirect_to_https(client_socket)
                            return

                    except Exception:
                        try:
                            client_socket.close()
                        except Exception:
                            pass

                server_self.wrap_socket_and_handle = dual_protocol_handler

        pywsgi.WSGIServer.__init__ = patched_init

    # ------------------------------------------------------------------
    # Eventlet path
    # ------------------------------------------------------------------
    def _patch_eventlet(self, eventlet):
        """Replace ``eventlet.wrap_ssl`` with a version that returns a
        dual-protocol server socket."""
        original_wrap_ssl = eventlet.wrap_ssl
        porter = self  # capture for closure

        def patched_wrap_ssl(sock, *args, **kwargs):
            # Only intercept server-side listening sockets
            if kwargs.get("server_side", False):
                return _DualProtocolServerSocket(
                    sock,
                    porter._certfile,
                    porter._keyfile,
                    porter._https_port,
                    original_wrap_ssl=original_wrap_ssl,
                )
            # Client-side or non-server wraps → fall through
            return original_wrap_ssl(sock, *args, **kwargs)

        eventlet.wrap_ssl = patched_wrap_ssl

    # ------------------------------------------------------------------
    # Stdlib / werkzeug path (fallback if neither gevent nor eventlet)
    # ------------------------------------------------------------------
    def _patch_stdlib_ssl(self):
        """For the werkzeug threading mode."""
        pass  # Placeholder

    # ------------------------------------------------------------------
    # Shared HTTP → HTTPS redirect logic
    # ------------------------------------------------------------------
    def _redirect_to_https(self, sock):
        """Read the HTTP request and send a 301 redirect to HTTPS."""
        try:
            data = sock.recv(4096).decode("utf-8", errors="ignore")
            host, path = self._parse_http_request(data)

            location = f"https://{host}:{self._https_port}{path}"
            response = (
                "HTTP/1.1 301 Moved Permanently\r\n"
                f"Location: {location}\r\n"
                "Connection: close\r\n"
                "Content-Length: 0\r\n"
                "\r\n"
            )
            sock.sendall(response.encode())
        except Exception:
            pass
        finally:
            try:
                sock.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    @staticmethod
    def _parse_http_request(raw_data):
        """Return (host, path) from a raw HTTP request."""
        host = "localhost"
        path = "/"

        lines = raw_data.split("\r\n")

        # Request line: "GET /path HTTP/1.1"
        if lines:
            parts = lines[0].split(" ")
            if len(parts) >= 2:
                path = parts[1]

        # Host header
        for line in lines[1:]:
            if line.lower().startswith("host:"):
                host_value = line.split(":", 1)[1].strip()
                if host_value.startswith("["):
                    # IPv6 literal [::1]:9000
                    bracket_end = host_value.find("]")
                    if bracket_end != -1:
                        host = host_value[: bracket_end + 1]
                elif ":" in host_value:
                    host = host_value.rsplit(":", 1)[0]
                else:
                    host = host_value
                break

        return host, path


# ======================================================================
# Internal: dual-protocol server socket (for eventlet path)
# ======================================================================

class _DualProtocolServerSocket:
    """Wraps a listening socket.  On each ``accept()``, peeks at the
    first byte to decide TLS vs plain HTTP.

    - TLS connections  → wrapped in SSL, returned to the caller
    - HTTP connections → 301 redirected and closed (then loop)
    """

    _PEEK_TIMEOUT = 5  # seconds to wait for first byte

    def __init__(self, sock, certfile, keyfile, https_port,
                 original_wrap_ssl=None):
        self._sock = sock
        self._certfile = certfile
        self._keyfile = keyfile
        self._https_port = https_port
        # Store the ORIGINAL (un-patched) wrap_ssl to avoid recursion
        self._original_wrap_ssl = original_wrap_ssl
        self._porter = Porter(certfile, keyfile, https_port)

    # ------------------------------------------------------------------
    def accept(self):
        while True:
            client_sock, addr = self._sock.accept()
            try:
                client_sock.settimeout(self._PEEK_TIMEOUT)
                first_byte = client_sock.recv(1, _socket.MSG_PEEK)

                if not first_byte:
                    client_sock.close()
                    continue

                if first_byte[0] == 0x16:
                    # TLS ClientHello → wrap in SSL using the ORIGINAL
                    # (un-patched) wrap_ssl to avoid recursion
                    client_sock.settimeout(None)
                    if self._original_wrap_ssl is not None:
                        ssl_sock = self._original_wrap_ssl(
                            client_sock,
                            server_side=True,
                            certfile=self._certfile,
                            keyfile=self._keyfile,
                        )
                    else:
                        # Fallback: stdlib SSL
                        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                        ctx.load_cert_chain(self._certfile, self._keyfile)
                        ssl_sock = ctx.wrap_socket(
                            client_sock, server_side=True
                        )
                    return ssl_sock, addr
                else:
                    # Plain HTTP → redirect
                    self._porter._redirect_to_https(client_sock)

            except Exception:
                try:
                    client_sock.close()
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # Proxy everything else to the real underlying socket
    # ------------------------------------------------------------------
    def __getattr__(self, name):
        return getattr(self._sock, name)
