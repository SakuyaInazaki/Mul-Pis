#!/usr/bin/env python3
"""Private Actions input decoding and envelope encryption; never prints payload data."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
import tempfile
import zlib
from pathlib import Path, PurePosixPath

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


MAX_ENCODED = 64 * 1024
MAX_COMPRESSED = 48 * 1024
MAX_TAR = 96 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
EXPECTED_INPUT_FILES = 3
MAX_ENVELOPE = 132 * 1024 * 1024
RESULT_ALLOWLIST = ("candidate.cpp", "verification.json", "campaign-status.json")
METADATA_RE = re.compile(r"^[A-Za-z0-9_./:@-]{1,160}$")


class TransportError(Exception):
    pass


def _safe_relative(name: str) -> PurePosixPath:
    if not name or "\\" in name or "\x00" in name or name.startswith("/"):
        raise TransportError()
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise TransportError()
    if ":" in parts[0] or len(parts) > 12 or len(name.encode("utf-8")) > 1024:
        raise TransportError()
    return PurePosixPath(name)


def _decompress_limited(data: bytes) -> bytes:
    try:
        dec = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
        raw = dec.decompress(data, MAX_TAR + 1)
        if len(raw) > MAX_TAR or dec.unconsumed_tail:
            raise TransportError()
        raw += dec.flush(MAX_TAR + 1 - len(raw))
        if not dec.eof or dec.unused_data or len(raw) > MAX_TAR:
            raise TransportError()
        return raw
    except zlib.error as exc:
        raise TransportError() from exc


def decode_secret(encoded: str, parent: Path) -> Path:
    """Validate the complete archive before writing into a new 0700 directory."""
    try:
        encoded = encoded.strip(" \t\r\n")
        if not encoded or len(encoded) > MAX_ENCODED:
            raise TransportError()
        compressed = base64.b64decode(encoded, validate=True)
        if len(compressed) > MAX_COMPRESSED:
            raise TransportError()
        raw = _decompress_limited(compressed)
        records: list[tuple[PurePosixPath, bytes]] = []
        names: set[str] = set()
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
            for member in tar:
                if not member.isfile() or member.size < 0 or member.size > MAX_FILE:
                    raise TransportError()
                name = _safe_relative(member.name)
                if len(name.parts) != 1 or str(name) in names or len(records) >= EXPECTED_INPUT_FILES:
                    raise TransportError()
                names.add(str(name))
                source = tar.extractfile(member)
                if source is None:
                    raise TransportError()
                contents = source.read(MAX_FILE + 1)
                if len(contents) != member.size:
                    raise TransportError()
                records.append((name, contents))
            if any(raw[tar.offset:]):
                raise TransportError()
        if len(records) != EXPECTED_INPUT_FILES:
            raise TransportError()
        for name, _ in records:
            if any(str(PurePosixPath(*name.parts[:i])) in names for i in range(1, len(name.parts))):
                raise TransportError()
        parent = parent.resolve(strict=True)
        if not parent.is_dir():
            raise TransportError()
        dest = Path(tempfile.mkdtemp(prefix="private-campaign-", dir=parent))
        os.chmod(dest, 0o700)
        for name, contents in records:
            target = dest.joinpath(*name.parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write(contents)
        return dest
    except (OSError, ValueError, UnicodeError, binascii.Error, tarfile.TarError) as exc:
        raise TransportError() from exc


def _result_tar(result_dir: Path) -> bytes:
    result_dir = result_dir.resolve(strict=True)
    if not result_dir.is_dir():
        raise TransportError()
    buf = io.BytesIO()
    count = 0
    with tarfile.open(fileobj=buf, mode="w:") as tar:
        for name in RESULT_ALLOWLIST:
            path = result_dir / name
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            except FileNotFoundError:
                continue
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
                    raise TransportError()
                data = source.read(MAX_FILE + 1)
                if len(data) != info.st_size:
                    raise TransportError()
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o600
            entry.mtime = 0
            tar.addfile(entry, io.BytesIO(data))
            count += 1
            if buf.tell() > MAX_TAR:
                raise TransportError()
    if count == 0 or buf.tell() > MAX_TAR:
        raise TransportError()
    return buf.getvalue()


def encrypt_results(result_dir: Path, public_key_file: Path, output_file: Path, metadata: dict[str, str], expected_spki_sha256: str) -> None:
    if set(metadata) != {"repository", "run_id", "run_attempt", "commit", "event"}:
        raise TransportError()
    if not all(isinstance(v, str) and METADATA_RE.fullmatch(v) for v in metadata.values()):
        raise TransportError()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_spki_sha256):
        raise TransportError()
    try:
        public_key = serialization.load_pem_public_key(public_key_file.read_bytes())
        if not isinstance(public_key, rsa.RSAPublicKey) or public_key.key_size != 3072:
            raise TransportError()
        spki_der = public_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if hashlib.sha256(spki_der).hexdigest() != expected_spki_sha256:
            raise TransportError()
        archive = _result_tar(result_dir)
        aad = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode("utf-8")
        key = AESGCM.generate_key(bit_length=256)
        nonce = os.urandom(12)
        encrypted = AESGCM(key).encrypt(nonce, archive, aad)
        wrapped = public_key.encrypt(key, padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
        envelope = {
            "format": "mul-pis-private-campaign-v1",
            "key_wrap": "RSA-3072-OAEP-SHA256",
            "content_cipher": "AES-256-GCM",
            "recipient_spki_sha256": expected_spki_sha256,
            "metadata": metadata,
            "wrapped_key_b64": base64.b64encode(wrapped).decode("ascii"),
            "nonce_b64": base64.b64encode(nonce).decode("ascii"),
            "ciphertext_b64": base64.b64encode(encrypted).decode("ascii"),
        }
        output_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(output_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(envelope, out, separators=(",", ":"))
            out.write("\n")
    except (OSError, ValueError, TypeError, tarfile.TarError) as exc:
        raise TransportError() from exc


def decrypt_results(envelope_file: Path, private_key_file: Path, parent: Path) -> Path:
    """Local-only recovery into a new private directory, never the checkout."""
    try:
        parent = parent.resolve(strict=True)
        checkout = Path(__file__).resolve().parents[1]
        if not parent.is_dir() or parent == checkout or checkout in parent.parents:
            raise TransportError()
        if envelope_file.stat().st_size > MAX_ENVELOPE:
            raise TransportError()
        envelope = json.loads(envelope_file.read_bytes())
        expected_fields = {"format", "key_wrap", "content_cipher", "recipient_spki_sha256", "metadata",
                           "wrapped_key_b64", "nonce_b64", "ciphertext_b64"}
        if not isinstance(envelope, dict) or set(envelope) != expected_fields:
            raise TransportError()
        if (envelope["format"] != "mul-pis-private-campaign-v1" or
                envelope["key_wrap"] != "RSA-3072-OAEP-SHA256" or
                envelope["content_cipher"] != "AES-256-GCM"):
            raise TransportError()
        metadata = envelope["metadata"]
        if (not isinstance(metadata, dict) or
                set(metadata) != {"repository", "run_id", "run_attempt", "commit", "event"} or
                not all(isinstance(v, str) and METADATA_RE.fullmatch(v) for v in metadata.values())):
            raise TransportError()
        key = serialization.load_pem_private_key(private_key_file.read_bytes(), password=None)
        if not isinstance(key, rsa.RSAPrivateKey) or key.key_size != 3072:
            raise TransportError()
        spki = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if hashlib.sha256(spki).hexdigest() != envelope["recipient_spki_sha256"]:
            raise TransportError()
        wrapped = base64.b64decode(envelope["wrapped_key_b64"], validate=True)
        nonce = base64.b64decode(envelope["nonce_b64"], validate=True)
        ciphertext = base64.b64decode(envelope["ciphertext_b64"], validate=True)
        if len(wrapped) != 384 or len(nonce) != 12 or len(ciphertext) > MAX_TAR + 16:
            raise TransportError()
        aes_key = key.decrypt(wrapped, padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
        if len(aes_key) != 32:
            raise TransportError()
        aad = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode("utf-8")
        archive = AESGCM(aes_key).decrypt(nonce, ciphertext, aad)
        files: list[tuple[str, bytes]] = []
        names: set[str] = set()
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
            for member in tar:
                if not member.isfile() or member.name not in RESULT_ALLOWLIST or member.name in names or member.size > MAX_FILE:
                    raise TransportError()
                names.add(member.name)
                source = tar.extractfile(member)
                if source is None:
                    raise TransportError()
                data = source.read(MAX_FILE + 1)
                if len(data) != member.size:
                    raise TransportError()
                files.append((member.name, data))
            if any(archive[tar.offset:]):
                raise TransportError()
        if not files:
            raise TransportError()
        dest = Path(tempfile.mkdtemp(prefix="private-campaign-result-", dir=parent))
        os.chmod(dest, 0o700)
        for name, data in files:
            fd = os.open(dest / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write(data)
        return dest
    except (OSError, ValueError, TypeError, UnicodeError, binascii.Error, tarfile.TarError) as exc:
        raise TransportError() from exc


def main() -> int:
    parser = argparse.ArgumentParser(description="Confidential Actions transport")
    sub = parser.add_subparsers(dest="command", required=True)
    decode = sub.add_parser("decode")
    decode.add_argument("--parent", required=True, type=Path)
    decode.add_argument("--github-output", required=True, type=Path)
    encrypt = sub.add_parser("encrypt")
    encrypt.add_argument("--results", required=True, type=Path)
    encrypt.add_argument("--public-key", required=True, type=Path)
    encrypt.add_argument("--expected-spki-sha256", required=True)
    encrypt.add_argument("--output", required=True, type=Path)
    for field in ("repository", "run-id", "run-attempt", "commit", "event"):
        encrypt.add_argument("--" + field, required=True)
    decrypt = sub.add_parser("decrypt")
    decrypt.add_argument("--envelope", required=True, type=Path)
    decrypt.add_argument("--private-key", required=True, type=Path)
    decrypt.add_argument("--parent", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "decode":
            path = decode_secret(os.environ.get("MULPIS_LAB_INPUT_B64", ""), args.parent)
            with args.github_output.open("a", encoding="utf-8") as out:
                out.write(f"input_dir={path}\n")
        elif args.command == "encrypt":
            metadata = {"repository": args.repository, "run_id": args.run_id, "run_attempt": args.run_attempt, "commit": args.commit, "event": args.event}
            encrypt_results(args.results, args.public_key, args.output, metadata, args.expected_spki_sha256)
        else:
            path = decrypt_results(args.envelope, args.private_key, args.parent)
            print(path)
        return 0
    except Exception:
        # Archive members, private output, cryptography exceptions, and filesystem
        # details must never be echoed into a public Actions log.
        print("Private campaign transport failed.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
