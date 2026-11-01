# routes/ssl_utils.py
import os
import logging
import ipaddress
import datetime
import socket
from pathlib import Path

from backbone.storage import atomic_write_text

CERT_VALID_DAYS = 365
RENEW_BEFORE_DAYS = 30   # renew once fewer than this many days of validity remain


def _local_ip():
    try:
        from routes.utils import get_local_ip
        ip = get_local_ip()
        return ip if ip and ip != "127.0.0.1" else None
    except Exception:
        return None


def _expected_names():
    """The (dns names, ip addresses) the certificate must cover for the machine as it is now."""
    dns = {"localhost"}
    try:
        hostname = socket.gethostname()
        if hostname and hostname.isascii():
            dns.add(hostname)
    except OSError:
        pass
    ips = {ipaddress.ip_address("127.0.0.1")}
    local_ip = _local_ip()
    if local_ip:
        ips.add(ipaddress.ip_address(local_ip))
    return dns, ips


def _renewal_reason(certfile, keyfile, dns_names, ip_addrs):
    """Why the existing certificate should be replaced, or None if it is still good.
    Returns (reason, expired) where `expired` says the current cert is unusable."""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization

    try:
        cert = x509.load_pem_x509_certificate(Path(certfile).read_bytes())
        key = serialization.load_pem_private_key(Path(keyfile).read_bytes(), password=None)
    except Exception as e:
        return f"certificate or key could not be read ({e})", True

    spki = serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    if cert.public_key().public_bytes(*spki) != key.public_key().public_bytes(*spki):
        return "certificate does not match its private key", True

    not_after = getattr(cert, "not_valid_after_utc", None)
    if not_after is None:   # older cryptography releases return a naive UTC datetime
        not_after = cert.not_valid_after.replace(tzinfo=datetime.timezone.utc)
    remaining = not_after - datetime.datetime.now(datetime.timezone.utc)
    if remaining <= datetime.timedelta(0):
        return f"certificate expired on {not_after:%Y-%m-%d}", True
    if remaining < datetime.timedelta(days=RENEW_BEFORE_DAYS):
        return f"certificate expires in {remaining.days} days", False

    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        have_dns = set(san.get_values_for_type(x509.DNSName))
        have_ips = set(san.get_values_for_type(x509.IPAddress))
    except x509.ExtensionNotFound:
        have_dns, have_ips = set(), set()
    missing = sorted(str(i) for i in ip_addrs - have_ips) + sorted(dns_names - have_dns)
    if missing:
        return f"certificate does not cover {', '.join(missing)}", False
    return None, False


def _generate(certfile, keyfile, dns_names, ip_addrs):
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SnailSynk"),
        x509.NameAttribute(NameOID.COMMON_NAME, "SnailSynk Local Server"),
    ])
    san = [x509.DNSName(n) for n in sorted(dns_names)] + [x509.IPAddress(i) for i in sorted(ip_addrs)]
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))   # tolerate small clock differences
        .not_valid_after(now + datetime.timedelta(days=CERT_VALID_DAYS))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode("ascii")
    # Each file is replaced atomically, so a crash never leaves a truncated certificate behind
    atomic_write_text(keyfile, key_pem, mode=0o600)
    atomic_write_text(certfile, cert_pem, mode=0o644)


def ensure_ssl_cert(instance_path: str) -> tuple:
    """
    Ensures a valid self-signed SSL certificate exists in the instance directory, creating it on
    first run and renewing it automatically when it is about to expire (or already has), no longer
    covers this machine's IP address / host name, is unreadable, or doesn't match its key.
    Returns (certfile_path, keyfile_path).
    """
    cert_dir = Path(instance_path)
    cert_dir.mkdir(parents=True, exist_ok=True)
    certfile = cert_dir / "cert.pem"
    keyfile = cert_dir / "key.pem"

    try:
        dns_names, ip_addrs = _expected_names()
        exists = certfile.exists() and keyfile.exists()
        expired = False
        reason = "no SSL certificate found"
        if exists:
            reason, expired = _renewal_reason(certfile, keyfile, dns_names, ip_addrs)
            if reason is None:
                logging.debug("SSL certificate is valid. Using existing certificate.")
                return str(certfile), str(keyfile)

        logging.info(f"Generating a new self-signed SSL certificate: {reason}.")
        try:
            _generate(certfile, keyfile, dns_names, ip_addrs)
        except Exception as e:
            if exists and not expired:
                logging.warning(f"Could not renew the SSL certificate ({e}); continuing with the current one.")
                return str(certfile), str(keyfile)
            raise
        if exists:
            logging.warning(
                "The SSL certificate was replaced. Browsers will warn once more; if you had installed "
                "the old certificate as trusted, install the new instance/cert.pem the same way."
            )
        else:
            logging.info(f"SSL certificate generated successfully at {cert_dir}")
        return str(certfile), str(keyfile)

    except ImportError:
        logging.error(
            "The 'cryptography' package is required for HTTPS. "
            "Install it with: pip install cryptography"
        )
        raise SystemExit(1)
    except Exception as e:
        logging.error(f"Failed to generate SSL certificate: {e}")
        raise
