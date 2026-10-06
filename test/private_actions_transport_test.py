import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/private_actions_transport.py"
spec = importlib.util.spec_from_file_location("private_actions_transport", SCRIPT)
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


def archive(entries):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:") as tar:
        for name, content, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "file":
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = content.decode("utf-8")
                tar.addfile(info)
            elif kind == "dir":
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
    return base64.b64encode(gzip.compress(buf.getvalue())).decode("ascii")


class DecodeTests(unittest.TestCase):
    def test_unicode_names_and_private_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            encoded = " \n" + archive([("源(1).cpp", b"private source", "file"), ("a.md", b"private notes", "file"), ("b.txt", b"private constraints", "file")]) + "\n"
            out = transport.decode_secret(encoded, Path(tmp))
            self.assertEqual((out / "源(1).cpp").read_bytes(), b"private source")
            self.assertEqual((out / "a.md").read_bytes(), b"private notes")
            self.assertEqual(out.stat().st_mode & 0o777, 0o700)
            self.assertEqual((out / "源(1).cpp").stat().st_mode & 0o777, 0o600)

    def test_rejects_traversal_absolute_link_directory_duplicate_and_file_ancestor(self):
        variants = [
            [("../escape", b"x", "file")],
            [("/escape", b"x", "file")],
            [("a\\b", b"x", "file")],
            [("link", b"elsewhere", "symlink")],
            [("folder", b"", "dir")],
            [("x", b"a", "file"), ("x", b"b", "file")],
            [("x", b"a", "file"), ("x/y", b"b", "file")],
            [("x", b"a", "file"), ("y", b"b", "file")],
            [("x", b"a", "file"), ("y", b"b", "file"), ("z", b"c", "file"), ("extra", b"d", "file")],
            [("x", b"a", "file"), ("y", b"b", "file"), ("nested/z", b"c", "file")],
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for variant in variants:
                with self.subTest(variant=variant):
                    with self.assertRaises(transport.TransportError):
                        transport.decode_secret(archive(variant), Path(tmp))
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_rejects_bad_base64_size_bomb_and_trailing_gzip(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(transport.TransportError):
                transport.decode_secret("not+valid!", Path(tmp))
            encoded = archive([("a", b"x", "file")])
            with self.assertRaises(transport.TransportError):
                transport.decode_secret(encoded[:4] + "\n" + encoded[4:], Path(tmp))
            with patch.object(transport, "MAX_ENCODED", 3):
                with self.assertRaises(transport.TransportError):
                    transport.decode_secret(archive([("a", b"x", "file")]), Path(tmp))
            with patch.object(transport, "MAX_TAR", 100):
                with self.assertRaises(transport.TransportError):
                    transport.decode_secret(archive([("a", b"x" * 200, "file")]), Path(tmp))
            payload = gzip.compress(b"tar one") + gzip.compress(b"tar two")
            with self.assertRaises(transport.TransportError):
                transport.decode_secret(base64.b64encode(payload).decode(), Path(tmp))
            raw = gzip.decompress(base64.b64decode(archive([
                ("a", b"a", "file"), ("b", b"b", "file"), ("c", b"c", "file")
            ])))
            hidden = base64.b64encode(gzip.compress(raw + b"hidden data")).decode()
            with self.assertRaises(transport.TransportError):
                transport.decode_secret(hidden, Path(tmp))

    def test_cli_never_prints_payload_on_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = os.environ.copy()
            env["MULPIS_LAB_INPUT_B64"] = "SECRET-SENTINEL-INVALID"
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), "decode", "--parent", tmp, "--github-output", str(Path(tmp) / "out")],
                env=env, text=True, capture_output=True, check=False,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertNotIn("SECRET-SENTINEL", proc.stdout + proc.stderr)


class EncryptTests(unittest.TestCase):
    def setUp(self):
        self.private_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        self.metadata = {
            "repository": "Example/Repository", "run_id": "123", "run_attempt": "1",
            "commit": "a" * 40, "event": "workflow_dispatch",
        }
        spki = self.private_key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        self.fingerprint = hashlib.sha256(spki).hexdigest()

    def test_roundtrip_and_allowlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            (results / "candidate.cpp").write_bytes(b"secret candidate")
            (results / "lesson-delta.json").write_bytes(b'{"action":"none"}')
            (results / "workflow-archive.json").write_bytes(b'{"trustedAdoption":false}')
            (results / "round-1-reviewer-feedback.txt").write_bytes(b"Full explicit reviewer rationale, beyond a short index.")
            (results / "review-decision.json").write_bytes(b'{"status":"rejected","reason":"Observed failure"}')
            (results / "context-lineage.json").write_bytes(b'{"version":1,"branchCount":2}')
            (results / "initial-m04-adopted-knowledge.json").write_bytes(b'{"version":1,"state":"complete"}')
            (results / "branch-parent-round-1-reviewer-feedback.txt").write_bytes(b"Parent rationale")
            (results / "branch-child-round-1-reviewer-feedback.txt").write_bytes(b"Child rationale")
            (results / "campaign-status.json").write_bytes(b'{"status":"complete"}')
            (results / "original-objective.json").write_bytes(b'{"kind":"original-objective"}')
            (results / "objective-checkpoint.json").write_bytes(b'{"objectiveOutcome":"incomplete"}')
            (results / "objective-assessment-receipt.json").write_bytes(b'{"boundaryIntent":"independent-judgment"}')
            (results / "objective-assessment-receipts.json").write_bytes(b'{"receipts":[{"boundaryIntent":"independent-judgment"}]}')
            (results / "mission-ledger-out.json").write_bytes(b'{"carryForwardCny":21.25,"status":"pending-local-artifact-verification-and-new-signature"}')
            (results / "independent-restart-quarantine.json").write_bytes(b'{"synthetic":"quarantine","operationOutcome":"unknown"}')
            (results / "independent-restart-goal-binding.json").write_bytes(b'{"synthetic":"binding","goalRunId":"fresh-goal"}')
            (results / "ignored.txt").write_bytes(b"must be excluded")
            public = root / "public.pem"
            public.write_bytes(self.private_key.public_key().public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            ))
            encrypted = root / "out.enc.json"
            transport.encrypt_results(results, public, encrypted, self.metadata, self.fingerprint)
            envelope = json.loads(encrypted.read_text())
            self.assertNotIn("secret candidate", encrypted.read_text())
            self.assertNotIn("must be excluded", encrypted.read_text())
            self.assertEqual(envelope["recipient_spki_sha256"], self.fingerprint)
            key = self.private_key.decrypt(base64.b64decode(envelope["wrapped_key_b64"]),
                padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
            aad = json.dumps(self.metadata, sort_keys=True, separators=(",", ":")).encode()
            plain = AESGCM(key).decrypt(base64.b64decode(envelope["nonce_b64"]),
                base64.b64decode(envelope["ciphertext_b64"]), aad)
            with tarfile.open(fileobj=io.BytesIO(plain), mode="r:") as tar:
                self.assertEqual(sorted(tar.getnames()), ["branch-child-round-1-reviewer-feedback.txt", "branch-parent-round-1-reviewer-feedback.txt", "campaign-status.json", "candidate.cpp", "context-lineage.json", "independent-restart-goal-binding.json", "independent-restart-quarantine.json", "initial-m04-adopted-knowledge.json", "lesson-delta.json", "mission-ledger-out.json", "objective-assessment-receipt.json", "objective-assessment-receipts.json", "objective-checkpoint.json", "original-objective.json", "review-decision.json", "round-1-reviewer-feedback.txt", "workflow-archive.json"])
                self.assertEqual(tar.extractfile("candidate.cpp").read(), b"secret candidate")
            with self.assertRaises(Exception):
                AESGCM(key).decrypt(base64.b64decode(envelope["nonce_b64"]),
                    base64.b64decode(envelope["ciphertext_b64"]), b"modified")
            private_file = root / "private.key"
            private_file.write_bytes(self.private_key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption()))
            recovered = transport.decrypt_results(encrypted, private_file, root)
            self.assertEqual((recovered / "candidate.cpp").read_bytes(), b"secret candidate")
            self.assertEqual((recovered / "lesson-delta.json").read_bytes(), b'{"action":"none"}')
            self.assertEqual((recovered / "workflow-archive.json").read_bytes(), b'{"trustedAdoption":false}')
            self.assertEqual((recovered / "round-1-reviewer-feedback.txt").read_bytes(), b"Full explicit reviewer rationale, beyond a short index.")
            self.assertEqual((recovered / "review-decision.json").read_bytes(), b'{"status":"rejected","reason":"Observed failure"}')
            self.assertEqual((recovered / "context-lineage.json").read_bytes(), b'{"version":1,"branchCount":2}')
            self.assertEqual((recovered / "initial-m04-adopted-knowledge.json").read_bytes(), b'{"version":1,"state":"complete"}')
            self.assertEqual((recovered / "original-objective.json").read_bytes(), b'{"kind":"original-objective"}')
            self.assertEqual((recovered / "objective-checkpoint.json").read_bytes(), b'{"objectiveOutcome":"incomplete"}')
            self.assertEqual((recovered / "objective-assessment-receipt.json").read_bytes(), b'{"boundaryIntent":"independent-judgment"}')
            self.assertEqual((recovered / "objective-assessment-receipts.json").read_bytes(), b'{"receipts":[{"boundaryIntent":"independent-judgment"}]}')
            self.assertEqual((recovered / "mission-ledger-out.json").read_bytes(), b'{"carryForwardCny":21.25,"status":"pending-local-artifact-verification-and-new-signature"}')
            self.assertEqual((recovered / "branch-parent-round-1-reviewer-feedback.txt").read_bytes(), b"Parent rationale")
            self.assertEqual((recovered / "branch-child-round-1-reviewer-feedback.txt").read_bytes(), b"Child rationale")
            self.assertEqual((recovered / "independent-restart-quarantine.json").read_bytes(), b'{"synthetic":"quarantine","operationOutcome":"unknown"}')
            self.assertEqual((recovered / "independent-restart-goal-binding.json").read_bytes(), b'{"synthetic":"binding","goalRunId":"fresh-goal"}')
            self.assertFalse((recovered / "ignored.txt").exists())
            self.assertEqual(recovered.stat().st_mode & 0o777, 0o700)
            self.assertEqual((recovered / "candidate.cpp").stat().st_mode & 0o777, 0o600)

    def test_reviewer_text_cannot_exceed_archive_hard_limit_in_transport(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            (results / "round-1-reviewer-feedback.txt").write_bytes(b"A" * 512_001)
            public = root / "public.pem"
            public.write_bytes(self.private_key.public_key().public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo))
            with self.assertRaises(transport.TransportError):
                transport.encrypt_results(results, public, root / "out.enc.json", self.metadata, self.fingerprint)

    def test_rejects_symlink_result_and_small_rsa_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            (results / "secret.txt").write_text("private")
            (results / "candidate.cpp").symlink_to("secret.txt")
            public = root / "public.pem"
            public.write_bytes(self.private_key.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
            with self.assertRaises(transport.TransportError):
                transport.encrypt_results(results, public, root / "out", self.metadata, self.fingerprint)
            (results / "candidate.cpp").unlink()
            (results / "campaign-status.json").write_text("{}")
            small = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            public.write_bytes(small.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
            with self.assertRaises(transport.TransportError):
                transport.encrypt_results(results, public, root / "out", self.metadata, self.fingerprint)

    def test_rejects_wrong_recipient_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            (results / "campaign-status.json").write_text("{}")
            public = root / "public.pem"
            other = rsa.generate_private_key(public_exponent=65537, key_size=3072)
            public.write_bytes(other.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
            with self.assertRaises(transport.TransportError):
                transport.encrypt_results(results, public, root / "out", self.metadata, self.fingerprint)


if __name__ == "__main__":
    unittest.main()
