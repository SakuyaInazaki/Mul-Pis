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
MAX_REVIEW_TEXT_FILE = 512_000
EXPECTED_INPUT_FILES = 3
MAX_ENVELOPE = 132 * 1024 * 1024
RESULT_ALLOWLIST = (
    "candidate.cpp", "verification.json", "lesson-delta.json", "experiment-plan.json", "workflow-archive.json", "m04-adopted-knowledge.json", "m04-transaction.json", "review-decision.json", "context-lineage.json",
    "followon-candidate.cpp", "followon-verification.json", "followon-lesson-delta.json", "followon-experiment-plan.json", "workflow-followon-archive.json",
    "followon-review-decision.json", "followon-m04-transaction.json",
    "initial-candidate.cpp", "initial-verification.json", "initial-lesson-delta.json", "initial-experiment-plan.json", "workflow-initial-archive.json",
    "initial-review-decision.json", "initial-m04-adopted-knowledge.json", "initial-m04-transaction.json",
    "branch-parent-candidate.cpp", "branch-parent-verification.json", "branch-parent-lesson-delta.json", "branch-parent-experiment-plan.json", "workflow-branch-parent-archive.json",
    "branch-parent-review-decision.json", "branch-parent-m04-transaction.json",
    "branch-child-candidate.cpp", "branch-child-verification.json", "branch-child-lesson-delta.json", "branch-child-experiment-plan.json", "workflow-branch-child-archive.json",
    "branch-child-review-decision.json", "branch-child-m04-transaction.json",
    "campaign-status.json", "original-objective.json", "objective-checkpoint.json", "objective-assessment-receipt.json", "objective-assessment-receipts.json", "mission-ledger-out.json", "incremental-control-prefix.json", "execution-capabilities.json", "research-history.json", "restored-candidate-verification.json",
    "independent-restart-quarantine.json", "independent-restart-goal-binding.json",
    "host-effect-receipt.json", "m04-transaction-quarantine.json", "repair-state.json",
    "provider-availability-observation.json",
)
RESULT_DYNAMIC_RE = re.compile(
    r"^(?:(?:provenance-import|iteration-[1-9][0-9]*|fallback-[0-9a-f]{12}-T[0-9]{3,})-(?:candidate\.cpp|verification\.json|lesson-delta\.json|experiment-plan\.json|review-decision\.json|m04-adopted-knowledge\.json|m04-transaction\.json)|"
    r"workflow-(?:provenance-import|iteration-[1-9][0-9]*|fallback-[0-9a-f]{12}-T[0-9]{3,})-archive\.json|"
    r"(?:initial-|followon-|branch-parent-|branch-child-|provenance-import-|iteration-[1-9][0-9]*-|fallback-[0-9a-f]{12}-T[0-9]{3,}-)?round-[1-9][0-9]*-(?:candidate\.cpp|verification\.json|reviewer-feedback\.txt|reviewer-report\.md))$"
)
METADATA_RE = re.compile(r"^[A-Za-z0-9_./:@-]{1,160}$")
RESULT_SIDECAR_RE = re.compile(r"^ledger-continuation\.part-[0-9]{8}\.enc$")
RESULT_ASSESSOR_DIAGNOSTIC_RE = re.compile(
    r"^assessor-(?:diagnostic-[0-9]{6,}\.json|transcript-[0-9]{6,}\.bin)$"
)
OBJECTIVE_PART_RE = re.compile(r"^objective-checkpoint\.part-([0-9a-f]{32})-([0-9]{6})\.txt$")
OBJECTIVE_PART_BYTES = 1024 * 1024
OBJECTIVE_TOTAL_BYTES = 64 * 1024 * 1024


def _allowed_result_name(name: str) -> bool:
    return bool(name in RESULT_ALLOWLIST or RESULT_DYNAMIC_RE.fullmatch(name) or
                RESULT_SIDECAR_RE.fullmatch(name) or
                RESULT_ASSESSOR_DIAGNOSTIC_RE.fullmatch(name) or
                OBJECTIVE_PART_RE.fullmatch(name))


def _objective_checkpoint_files(files: dict[str, bytes], names: set[str] | None = None) -> set[str]:
    """Select only the published generation; incomplete writes may leave orphan parts."""
    raw = files.get("objective-checkpoint.json")
    if raw is None:
        return set()
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError) as exc:
        raise TransportError() from exc
    if not isinstance(manifest, dict):
        raise TransportError()
    if manifest.get("kind") != "objective-checkpoint-multipart":
        if {"generation", "totalBytes", "sha256", "parts"} & set(manifest):
            raise TransportError()
        return set()
    if (set(manifest) != {"version", "kind", "encoding", "generation", "totalBytes", "sha256", "parts"} or
            type(manifest["version"]) is not int or manifest["version"] != 1 or
            manifest["encoding"] != "utf8-concatenate-in-order" or
            not isinstance(manifest["generation"], str) or
            not re.fullmatch(r"[0-9a-f]{32}", manifest["generation"]) or
            type(manifest["totalBytes"]) is not int or
            not 4 * 1024 * 1024 < manifest["totalBytes"] <= OBJECTIVE_TOTAL_BYTES or
            not isinstance(manifest["sha256"], str) or
            not re.fullmatch(r"[0-9a-f]{64}", manifest["sha256"]) or
            not isinstance(manifest["parts"], list) or
            not 5 <= len(manifest["parts"]) <= 64 or
            len(raw) > OBJECTIVE_PART_BYTES):
        raise TransportError()
    active: set[str] = set()
    chunks: list[bytes] = []
    for index, row in enumerate(manifest["parts"], 1):
        name = f"objective-checkpoint.part-{manifest['generation']}-{index:06d}.txt"
        if (not isinstance(row, dict) or set(row) != {"name", "bytes", "sha256"} or
                row["name"] != name or type(row["bytes"]) is not int or
                not 0 < row["bytes"] <= OBJECTIVE_PART_BYTES or
                (index < len(manifest["parts"]) and row["bytes"] != OBJECTIVE_PART_BYTES) or
                not isinstance(row["sha256"], str) or
                not re.fullmatch(r"[0-9a-f]{64}", row["sha256"])):
            raise TransportError()
        chunk = files.get(name)
        if (chunk is None or len(chunk) != row["bytes"] or
                hashlib.sha256(chunk).hexdigest() != row["sha256"]):
            raise TransportError()
        active.add(name)
        chunks.append(chunk)
    active_prefix = f"objective-checkpoint.part-{manifest['generation']}-"
    if any(name.startswith(active_prefix) and name not in active
           for name in (names if names is not None else files)):
        raise TransportError()
    joined = b"".join(chunks)
    if (len(raw) + len(joined) > OBJECTIVE_TOTAL_BYTES or
            len(joined) != manifest["totalBytes"] or
            hashlib.sha256(joined).hexdigest() != manifest["sha256"]):
        raise TransportError()
    try:
        checkpoint = json.loads(joined.decode("utf-8"))
    except (UnicodeError, ValueError) as exc:
        raise TransportError() from exc
    if (not isinstance(checkpoint, dict) or type(checkpoint.get("version")) is not int or
            checkpoint["version"] != 1 or
            checkpoint.get("kind") != "original-objective-progress"):
        raise TransportError()
    return active


def _review_text_file(name: str) -> bool:
    return name.endswith(("reviewer-feedback.txt", "reviewer-report.md", "review-decision.json"))


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
    directory_names = {entry.name for entry in os.scandir(result_dir)}
    names = {name for name in directory_names if _allowed_result_name(name)}
    files: dict[str, bytes] = {}
    total_read_bytes = 0
    def read_result_file(name: str) -> None:
        nonlocal total_read_bytes
        path = result_dir / name
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            raise TransportError()
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE or
                    (_review_text_file(name) and info.st_size > MAX_REVIEW_TEXT_FILE) or
                    (OBJECTIVE_PART_RE.fullmatch(name) and info.st_size > OBJECTIVE_PART_BYTES)):
                raise TransportError()
            data = source.read(MAX_FILE + 1)
            if len(data) != info.st_size:
                raise TransportError()
        total_read_bytes += len(data)
        if total_read_bytes > MAX_TAR:
            raise TransportError()
        files[name] = data
    for name in sorted(names):
        if not OBJECTIVE_PART_RE.fullmatch(name):
            read_result_file(name)
    raw = files.get("objective-checkpoint.json")
    if raw is not None:
        try:
            candidate = json.loads(raw.decode("utf-8"))
        except (UnicodeError, ValueError):
            candidate = None
        if isinstance(candidate, dict) and candidate.get("kind") == "objective-checkpoint-multipart":
            rows = candidate.get("parts")
            if not isinstance(rows, list):
                raise TransportError()
            for row in rows:
                name = row.get("name") if isinstance(row, dict) else None
                if not isinstance(name, str) or not OBJECTIVE_PART_RE.fullmatch(name) or name not in names:
                    raise TransportError()
                if name not in files:
                    read_result_file(name)
    active_parts = _objective_checkpoint_files(files, directory_names)
    buf = io.BytesIO()
    count = 0
    with tarfile.open(fileobj=buf, mode="w:") as tar:
        for name, data in sorted(files.items()):
            if OBJECTIVE_PART_RE.fullmatch(name) and name not in active_parts:
                continue
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


def encrypt_balance_verdict(availability: str, public_key_file: Path, output_file: Path,
                            metadata: dict[str, str], expected_spki_sha256: str) -> None:
    """Seal only a fixed availability verdict using the campaign's pinned RSA recipient."""
    if not isinstance(availability, str) or availability not in {"available", "unavailable", "unknown"}:
        raise TransportError()
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
        plaintext = json.dumps({"kind": "provider-balance-availability", "version": 1,
                                "availability": availability}, sort_keys=True,
                               separators=(",", ":")).encode("utf-8")
        aad = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode("utf-8")
        key = AESGCM.generate_key(bit_length=256)
        nonce = os.urandom(12)
        encrypted = AESGCM(key).encrypt(nonce, plaintext, aad)
        wrapped = public_key.encrypt(key, padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()),
                                                       algorithm=hashes.SHA256(), label=None))
        envelope = {
            "format": "mul-pis-provider-balance-v1",
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
    except (OSError, ValueError, TypeError) as exc:
        raise TransportError() from exc


def decrypt_balance_verdict(envelope_file: Path, private_key_file: Path,
                            expected_spki_sha256: str) -> tuple[str, dict[str, str]]:
    """Offline-only exact review of a standalone balance envelope, without writes."""
    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for name, value in pairs:
            if name in result:
                raise TransportError()
            result[name] = value
        return result

    try:
        if not re.fullmatch(r"[0-9a-f]{64}", expected_spki_sha256):
            raise TransportError()
        if envelope_file.stat().st_size > 16 * 1024:
            raise TransportError()
        envelope = json.loads(envelope_file.read_bytes(), object_pairs_hook=unique_object)
        if not isinstance(envelope, dict) or set(envelope) != {
                "format", "key_wrap", "content_cipher", "recipient_spki_sha256", "metadata",
                "wrapped_key_b64", "nonce_b64", "ciphertext_b64"}:
            raise TransportError()
        if (envelope["format"] != "mul-pis-provider-balance-v1" or
                envelope["key_wrap"] != "RSA-3072-OAEP-SHA256" or
                envelope["content_cipher"] != "AES-256-GCM" or
                envelope["recipient_spki_sha256"] != expected_spki_sha256):
            raise TransportError()
        metadata = envelope["metadata"]
        if (not isinstance(metadata, dict) or
                set(metadata) != {"repository", "run_id", "run_attempt", "commit", "event"} or
                not all(isinstance(v, str) and METADATA_RE.fullmatch(v) for v in metadata.values()) or
                metadata["repository"] != "SakuyaInazaki/Mul-Pis" or
                not re.fullmatch(r"[1-9][0-9]*", metadata["run_id"]) or
                metadata["run_attempt"] != "1" or
                not re.fullmatch(r"[0-9a-f]{40}", metadata["commit"]) or
                metadata["event"] != "push"):
            raise TransportError()
        key = serialization.load_pem_private_key(private_key_file.read_bytes(), password=None)
        if not isinstance(key, rsa.RSAPrivateKey) or key.key_size != 3072:
            raise TransportError()
        spki = key.public_key().public_bytes(serialization.Encoding.DER,
                                              serialization.PublicFormat.SubjectPublicKeyInfo)
        if hashlib.sha256(spki).hexdigest() != expected_spki_sha256:
            raise TransportError()
        wrapped = base64.b64decode(envelope["wrapped_key_b64"], validate=True)
        nonce = base64.b64decode(envelope["nonce_b64"], validate=True)
        ciphertext = base64.b64decode(envelope["ciphertext_b64"], validate=True)
        if len(wrapped) != 384 or len(nonce) != 12 or not 16 < len(ciphertext) <= 512:
            raise TransportError()
        aes_key = key.decrypt(wrapped, padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()),
                                                   algorithm=hashes.SHA256(), label=None))
        if len(aes_key) != 32:
            raise TransportError()
        aad = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode("utf-8")
        plaintext = AESGCM(aes_key).decrypt(nonce, ciphertext, aad)
        verdict = json.loads(plaintext.decode("utf-8"), object_pairs_hook=unique_object)
        if (not isinstance(verdict, dict) or
                set(verdict) != {"kind", "version", "availability"} or
                verdict["kind"] != "provider-balance-availability" or
                type(verdict["version"]) is not int or verdict["version"] != 1 or
                verdict["availability"] not in {"available", "unavailable", "unknown"}):
            raise TransportError()
        return verdict["availability"], metadata
    except Exception as exc:
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
                if (not member.isfile() or not _allowed_result_name(member.name) or member.name in names or
                        member.size > MAX_FILE or
                        (_review_text_file(member.name) and member.size > MAX_REVIEW_TEXT_FILE) or
                        (OBJECTIVE_PART_RE.fullmatch(member.name) and member.size > OBJECTIVE_PART_BYTES)):
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
        file_map = dict(files)
        active_parts = _objective_checkpoint_files(file_map)
        files = [(name, data) for name, data in files if
                 not OBJECTIVE_PART_RE.fullmatch(name) or name in active_parts]
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
