import base64
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
import re
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
sys.path.insert(0, str(SCRIPT.parent))
import provider_balance_probe as balance_probe
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


def multipart_checkpoint(generation="a" * 32):
    checkpoint = json.dumps({"version": 1, "kind": "original-objective-progress",
                             "payload": "SYNTHETIC-CHECKPOINT-" + "x" * (4 * 1024 * 1024)},
                            separators=(",", ":")).encode()
    chunks = [checkpoint[i:i + 1024 * 1024] for i in range(0, len(checkpoint), 1024 * 1024)]
    files = {}
    parts = []
    for index, chunk in enumerate(chunks, 1):
        name = f"objective-checkpoint.part-{generation}-{index:06d}.txt"
        files[name] = chunk
        parts.append({"name": name, "bytes": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()})
    manifest = {"version": 1, "kind": "objective-checkpoint-multipart",
                "encoding": "utf8-concatenate-in-order", "generation": generation,
                "totalBytes": len(checkpoint), "sha256": hashlib.sha256(checkpoint).hexdigest(),
                "parts": parts}
    files["objective-checkpoint.json"] = (json.dumps(manifest, separators=(",", ":")) + "\n").encode()
    return files


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

    def test_multipart_checkpoint_encrypts_only_published_generation_and_roundtrips(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            active = multipart_checkpoint()
            for name, data in active.items():
                (results / name).write_bytes(data)
            orphan = "objective-checkpoint.part-" + "b" * 32 + "-000001.txt"
            (results / orphan).symlink_to("missing-interrupted-part")
            (results / "campaign-status.json").write_bytes(b'{"status":"incomplete"}')
            public = root / "public.pem"
            public.write_bytes(self.private_key.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
            encrypted = root / "out.enc.json"
            transport.encrypt_results(results, public, encrypted, self.metadata, self.fingerprint)
            self.assertNotIn("SYNTHETIC-CHECKPOINT", encrypted.read_text())
            private = root / "private.pem"
            private.write_bytes(self.private_key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            recovered = transport.decrypt_results(encrypted, private, root)
            self.assertEqual({p.name for p in recovered.iterdir()}, set(active) | {"campaign-status.json"})
            for name, data in active.items():
                self.assertEqual((recovered / name).read_bytes(), data)
            self.assertFalse((recovered / orphan).exists())

    def test_multipart_checkpoint_rejects_missing_tampered_and_extra_active_parts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            files = multipart_checkpoint()
            for name, data in files.items():
                (results / name).write_bytes(data)
            parts = sorted(name for name in files if name.endswith(".txt"))
            last = results / parts[-1]
            saved = last.read_bytes()
            last.unlink()
            with self.assertRaises(transport.TransportError):
                transport._result_tar(results)
            last.write_bytes(saved)
            last.write_bytes(b"Z" + saved[1:])
            with self.assertRaises(transport.TransportError):
                transport._result_tar(results)
            last.write_bytes(saved)
            (results / ("objective-checkpoint.part-" + "a" * 32 + "-000006.txt")).write_bytes(b"extra")
            with self.assertRaises(transport.TransportError):
                transport._result_tar(results)
            (results / ("objective-checkpoint.part-" + "a" * 32 + "-000006.txt")).unlink()
            front = results / "objective-checkpoint.json"
            saved_manifest = front.read_bytes()
            manifest = json.loads(saved_manifest)
            manifest["sha256"] = "0" * 64
            front.write_bytes((json.dumps(manifest) + "\n").encode())
            with self.assertRaises(transport.TransportError):
                transport._result_tar(results)
            front.write_bytes(saved_manifest)
            manifest = json.loads(saved_manifest)
            manifest["kind"] = "objective-checkpoint-multipart-mutated"
            front.write_bytes((json.dumps(manifest) + "\n").encode())
            with self.assertRaises(transport.TransportError):
                transport._result_tar(results)

    def test_legacy_inline_checkpoint_and_orphan_part_stay_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "objective-checkpoint.json").write_bytes(b'{"objectiveOutcome":"incomplete"}')
            orphan = "objective-checkpoint.part-" + "b" * 32 + "-000001.txt"
            (root / orphan).write_bytes(b"incomplete-write")
            with tarfile.open(fileobj=io.BytesIO(transport._result_tar(root)), mode="r:") as tar:
                self.assertEqual(tar.getnames(), ["objective-checkpoint.json"])

    def test_assessor_diagnostics_roundtrip_only_under_exact_allowlisted_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            diagnostic = b'{"kind":"private-assessor-diagnostic","rawResponse":"secret invalid answer"}\n'
            transcript = b'{"session":"secret transcript"}\n'
            (results / "assessor-diagnostic-000001.json").write_bytes(diagnostic)
            (results / "assessor-transcript-000001.bin").write_bytes(transcript)
            source_diagnostic = b'{"kind":"private-task-source-handoff-diagnostic","errno":"ENOSPC"}\n'
            (results / "task-source-handoff-diagnostic-1.json").write_bytes(source_diagnostic)
            (results / "assessor-diagnostic-000001.json.bak").write_bytes(b"excluded")
            (results / "assessor-transcript-1.bin").write_bytes(b"excluded")
            (results / "assessor-diagnostic-evil.json").write_bytes(b"excluded")
            (results / "task-source-handoff-diagnostic-01.json").write_bytes(b"excluded")
            public = root / "public.pem"
            public.write_bytes(self.private_key.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
            encrypted = root / "out.enc.json"
            transport.encrypt_results(results, public, encrypted, self.metadata, self.fingerprint)
            self.assertNotIn("secret invalid answer", encrypted.read_text())
            self.assertNotIn("secret transcript", encrypted.read_text())
            private = root / "private.pem"
            private.write_bytes(self.private_key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            recovered = transport.decrypt_results(encrypted, private, root)
            self.assertEqual((recovered / "assessor-diagnostic-000001.json").read_bytes(), diagnostic)
            self.assertEqual((recovered / "assessor-transcript-000001.bin").read_bytes(), transcript)
            self.assertEqual((recovered / "task-source-handoff-diagnostic-1.json").read_bytes(), source_diagnostic)
            self.assertEqual((recovered / "assessor-diagnostic-000001.json").stat().st_mode & 0o777, 0o600)
            self.assertFalse((recovered / "assessor-diagnostic-000001.json.bak").exists())
            self.assertFalse((recovered / "assessor-transcript-1.bin").exists())
            self.assertFalse((recovered / "assessor-diagnostic-evil.json").exists())
            self.assertFalse((recovered / "task-source-handoff-diagnostic-01.json").exists())

    def test_roundtrip_and_allowlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            (results / "candidate.cpp").write_bytes(b"secret candidate")
            (results / "lesson-delta.json").write_bytes(b'{"action":"none"}')
            (results / "workflow-archive.json").write_bytes(b'{"trustedAdoption":false}')
            (results / "round-1-reviewer-feedback.txt").write_bytes(b"Full explicit reviewer rationale, beyond a short index.")
            (results / "iteration-65-round-10-reviewer-feedback.txt").write_bytes(b"Later bounded feedback")
            (results / "fallback-aaaaaaaaaaaa-T003-round-10-reviewer-feedback.txt").write_bytes(b"Later task feedback")
            (results / "review-decision.json").write_bytes(b'{"status":"rejected","reason":"Observed failure"}')
            (results / "context-lineage.json").write_bytes(b'{"version":1,"branchCount":2}')
            (results / "initial-m04-adopted-knowledge.json").write_bytes(b'{"version":1,"state":"complete"}')
            for name in ("m04-transaction.json", "initial-m04-transaction.json",
                         "followon-m04-transaction.json", "iteration-65-m04-transaction.json",
                         "fallback-aaaaaaaaaaaa-T003-m04-transaction.json"):
                (results / name).write_bytes(b'{"kind":"m04-knowledge-transaction","state":"rejected-draft","synthetic":true}')
            (results / "branch-parent-round-1-reviewer-feedback.txt").write_bytes(b"Parent rationale")
            (results / "branch-child-round-1-reviewer-feedback.txt").write_bytes(b"Child rationale")
            (results / "campaign-status.json").write_bytes(b'{"status":"complete"}')
            sidecars = {
                "ledger-continuation.part-00000000.enc": b"c2VnbWVudC0w",
                "ledger-continuation.part-00000001.enc": b"c2VnbWVudC0x",
            }
            for name, content in sidecars.items():
                (results / name).write_bytes(content)
            (results / "ledger-continuation.part-0000000.enc").write_bytes(b"excluded-short-index")
            (results / "ledger-continuation.part-00000000.enc.json").write_bytes(b"excluded-extra-suffix")
            (results / "original-objective.json").write_bytes(b'{"kind":"original-objective"}')
            (results / "objective-checkpoint.json").write_bytes(b'{"objectiveOutcome":"incomplete"}')
            (results / "objective-assessment-receipt.json").write_bytes(b'{"boundaryIntent":"independent-judgment"}')
            (results / "objective-assessment-receipts.json").write_bytes(b'{"receipts":[{"boundaryIntent":"independent-judgment"}]}')
            (results / "mission-ledger-out.json").write_bytes(b'{"carryForwardCny":21.25,"status":"pending-local-artifact-verification-and-new-signature"}')
            (results / "incremental-control-prefix.json").write_bytes(b'{"status":"incomplete","incrementalControlEnvelope":{"synthetic":true}}')
            (results / "independent-restart-quarantine.json").write_bytes(b'{"synthetic":"quarantine","operationOutcome":"unknown"}')
            (results / "independent-restart-goal-binding.json").write_bytes(b'{"synthetic":"binding","goalRunId":"fresh-goal"}')
            (results / "host-effect-receipt.json").write_bytes(b'{"kind":"m07-host-effect-census"}')
            (results / "m04-transaction-quarantine.json").write_bytes(b'{"kind":"unresolved-historical-m04-quarantine"}')
            (results / "repair-state.json").write_bytes(b'{"kind":"workflow-repair-state","strategy":"fresh-context"}')
            (results / "repair-state-copy.json").write_bytes(b"must remain excluded")
            (results / "ignored.txt").write_bytes(b"must be excluded")
            (results / "m04-transaction-copy.json").write_bytes(b"must also be excluded")
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
            self.assertNotIn("must also be excluded", encrypted.read_text())
            self.assertNotIn("must remain excluded", encrypted.read_text())
            self.assertEqual(envelope["recipient_spki_sha256"], self.fingerprint)
            key = self.private_key.decrypt(base64.b64decode(envelope["wrapped_key_b64"]),
                padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
            aad = json.dumps(self.metadata, sort_keys=True, separators=(",", ":")).encode()
            plain = AESGCM(key).decrypt(base64.b64decode(envelope["nonce_b64"]),
                base64.b64decode(envelope["ciphertext_b64"]), aad)
            with tarfile.open(fileobj=io.BytesIO(plain), mode="r:") as tar:
                self.assertEqual(sorted(tar.getnames()), sorted(["branch-child-round-1-reviewer-feedback.txt", "branch-parent-round-1-reviewer-feedback.txt", "campaign-status.json", "candidate.cpp", "context-lineage.json", "fallback-aaaaaaaaaaaa-T003-round-10-reviewer-feedback.txt", "host-effect-receipt.json", "incremental-control-prefix.json", "independent-restart-goal-binding.json", "independent-restart-quarantine.json", "initial-m04-adopted-knowledge.json", "iteration-65-round-10-reviewer-feedback.txt", "lesson-delta.json", "mission-ledger-out.json", "objective-assessment-receipt.json", "objective-assessment-receipts.json", "objective-checkpoint.json", "original-objective.json", "repair-state.json", "review-decision.json", "round-1-reviewer-feedback.txt", "workflow-archive.json", "m04-transaction.json", "initial-m04-transaction.json", "followon-m04-transaction.json", "iteration-65-m04-transaction.json", "fallback-aaaaaaaaaaaa-T003-m04-transaction.json", "m04-transaction-quarantine.json", *sidecars]))
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
            for name, content in sidecars.items():
                self.assertEqual((recovered / name).read_bytes(), content)
            self.assertFalse((recovered / "ledger-continuation.part-0000000.enc").exists())
            self.assertFalse((recovered / "ledger-continuation.part-00000000.enc.json").exists())
            self.assertEqual((recovered / "lesson-delta.json").read_bytes(), b'{"action":"none"}')
            self.assertEqual((recovered / "workflow-archive.json").read_bytes(), b'{"trustedAdoption":false}')
            self.assertEqual((recovered / "round-1-reviewer-feedback.txt").read_bytes(), b"Full explicit reviewer rationale, beyond a short index.")
            self.assertEqual((recovered / "iteration-65-round-10-reviewer-feedback.txt").read_bytes(), b"Later bounded feedback")
            self.assertEqual((recovered / "fallback-aaaaaaaaaaaa-T003-round-10-reviewer-feedback.txt").read_bytes(), b"Later task feedback")
            self.assertEqual((recovered / "review-decision.json").read_bytes(), b'{"status":"rejected","reason":"Observed failure"}')
            self.assertEqual((recovered / "context-lineage.json").read_bytes(), b'{"version":1,"branchCount":2}')
            self.assertEqual((recovered / "initial-m04-adopted-knowledge.json").read_bytes(), b'{"version":1,"state":"complete"}')
            for name in ("m04-transaction.json", "initial-m04-transaction.json",
                         "followon-m04-transaction.json", "iteration-65-m04-transaction.json",
                         "fallback-aaaaaaaaaaaa-T003-m04-transaction.json"):
                self.assertEqual((recovered / name).read_bytes(),
                                 b'{"kind":"m04-knowledge-transaction","state":"rejected-draft","synthetic":true}')
            self.assertEqual((recovered / "original-objective.json").read_bytes(), b'{"kind":"original-objective"}')
            self.assertEqual((recovered / "objective-checkpoint.json").read_bytes(), b'{"objectiveOutcome":"incomplete"}')
            self.assertEqual((recovered / "objective-assessment-receipt.json").read_bytes(), b'{"boundaryIntent":"independent-judgment"}')
            self.assertEqual((recovered / "objective-assessment-receipts.json").read_bytes(), b'{"receipts":[{"boundaryIntent":"independent-judgment"}]}')
            self.assertEqual((recovered / "mission-ledger-out.json").read_bytes(), b'{"carryForwardCny":21.25,"status":"pending-local-artifact-verification-and-new-signature"}')
            self.assertEqual((recovered / "incremental-control-prefix.json").read_bytes(), b'{"status":"incomplete","incrementalControlEnvelope":{"synthetic":true}}')
            self.assertEqual((recovered / "branch-parent-round-1-reviewer-feedback.txt").read_bytes(), b"Parent rationale")
            self.assertEqual((recovered / "branch-child-round-1-reviewer-feedback.txt").read_bytes(), b"Child rationale")
            self.assertEqual((recovered / "host-effect-receipt.json").read_bytes(), b'{"kind":"m07-host-effect-census"}')
            self.assertEqual((recovered / "m04-transaction-quarantine.json").read_bytes(), b'{"kind":"unresolved-historical-m04-quarantine"}')
            self.assertEqual((recovered / "repair-state.json").read_bytes(), b'{"kind":"workflow-repair-state","strategy":"fresh-context"}')
            self.assertEqual((recovered / "independent-restart-quarantine.json").read_bytes(), b'{"synthetic":"quarantine","operationOutcome":"unknown"}')
            self.assertEqual((recovered / "independent-restart-goal-binding.json").read_bytes(), b'{"synthetic":"binding","goalRunId":"fresh-goal"}')
            self.assertFalse((recovered / "ignored.txt").exists())
            self.assertFalse((recovered / "m04-transaction-copy.json").exists())
            self.assertFalse((recovered / "repair-state-copy.json").exists())
            self.assertEqual(recovered.stat().st_mode & 0o777, 0o700)
            self.assertEqual((recovered / "candidate.cpp").stat().st_mode & 0o777, 0o600)

    def test_provenance_import_evidence_roundtrips_without_canonical_promotion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            evidence = {
                "workflow-provenance-import-archive.json": b'{"kind":"synthetic-unselected-archive"}',
                "provenance-import-candidate.cpp": b"// synthetic imported source\n",
                "provenance-import-verification.json": b'{"status":"passed"}',
                "provenance-import-lesson-delta.json": b'{"action":"propose"}',
                "provenance-import-review-decision.json": b'{"status":"accepted"}',
                "provenance-import-m04-adopted-knowledge.json": b'{"state":"complete"}',
                "provenance-import-m04-transaction.json": b'{"kind":"m04-knowledge-transaction","state":"rejected-draft"}',
                "provenance-import-round-1-reviewer-feedback.txt": b"Synthetic bounded review\n",
            }
            for name, content in evidence.items():
                (results / name).write_bytes(content)
            (results / "provenance-import-unlisted-secret.json").write_bytes(b"EXCLUDED_SYNTHETIC_SECRET")
            public = root / "public.pem"
            public.write_bytes(self.private_key.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
            encrypted = root / "out.enc.json"
            transport.encrypt_results(results, public, encrypted, self.metadata, self.fingerprint)
            self.assertNotIn("EXCLUDED_SYNTHETIC_SECRET", encrypted.read_text())
            private_file = root / "private.key"
            private_file.write_bytes(self.private_key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption()))
            recovered = transport.decrypt_results(encrypted, private_file, root)
            self.assertEqual({file.name for file in recovered.iterdir()}, set(evidence))
            for name, content in evidence.items():
                self.assertEqual((recovered / name).read_bytes(), content)
            self.assertFalse((recovered / "candidate.cpp").exists())
            self.assertFalse((recovered / "verification.json").exists())
            self.assertFalse((recovered / "workflow-archive.json").exists())

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

    def test_small_provider_observation_is_sealed_in_campaign_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            observation = b'{"kind":"provider-availability-observation","status":"unknown"}'
            (results / "provider-availability-observation.json").write_bytes(observation)
            public = root / "public.pem"
            public.write_bytes(self.private_key.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
            output = root / "campaign.enc.json"
            transport.encrypt_results(results, public, output, self.metadata, self.fingerprint)
            self.assertNotIn(observation, output.read_bytes())
            private = root / "private.pem"
            private.write_bytes(self.private_key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            recovered = transport.decrypt_results(output, private, root)
            self.assertEqual((recovered / "provider-availability-observation.json").read_bytes(),
                             observation)
            (results / "provider-availability-observation.json").write_bytes(b"x" * 4097)
            transport.encrypt_results(results, public, root / "history.enc.json", self.metadata,
                                      self.fingerprint)


class BalanceProbeTests(unittest.TestCase):
    def test_initial_probe_branch_creation_and_existing_tip_binding(self):
        source, old_tip, wrong_tip = "a" * 40, "b" * 40, "c" * 40
        self.assertTrue(balance_probe.valid_probe_request_before([source], "0" * 40))
        self.assertTrue(balance_probe.valid_probe_request_before([source], source))
        self.assertTrue(balance_probe.valid_probe_request_before([source, old_tip], old_tip))
        self.assertFalse(balance_probe.valid_probe_request_before([source], wrong_tip))
        self.assertFalse(balance_probe.valid_probe_request_before([source, old_tip], "0" * 40))
        self.assertFalse(balance_probe.valid_probe_request_before([source, old_tip], source))
        self.assertFalse(balance_probe.valid_probe_request_before([source, source], source))
        self.assertFalse(balance_probe.valid_probe_request_before([], "0" * 40))

    def test_exact_source_ci_success_after_first_hundred_runs(self):
        source = "a" * 40
        rows = [{"id": index, "head_sha": source,
                 "head_branch": "improve/workflow-learning-reliability", "event": "push",
                 "run_attempt": 1, "conclusion": "failure"} for index in range(1, 202)]
        rows[-1]["conclusion"] = "success"
        requested = []
        def get_json(path):
            requested.append(path)
            page = int(path.split("&page=")[-1])
            return {"total_count": len(rows), "workflow_runs": rows[(page - 1) * 100:page * 100]}
        self.assertTrue(balance_probe.accepted_offline_ci(get_json, source))
        self.assertEqual(len(requested), 3)
        self.assertTrue(requested[2].endswith("&page=3"))

        def duplicate_page(path):
            page = int(path.split("&page=")[-1])
            if page == 2:
                return {"total_count": 201, "workflow_runs": rows[:100]}
            return get_json(path)
        with self.assertRaises(ValueError):
            balance_probe.accepted_offline_ci(duplicate_page, source)

        def changing_count(path):
            page = int(path.split("&page=")[-1])
            result = get_json(path)
            if page == 2:
                result["total_count"] = 202
            return result
        with self.assertRaises(ValueError):
            balance_probe.accepted_offline_ci(changing_count, source)

    def test_probe_workflow_has_no_custom_admission_quotas(self):
        workflow = (SCRIPT.parent.parent / ".github/workflows/provider-balance-check.yml").read_text()
        self.assertIn("  workflow_dispatch:", workflow)
        self.assertNotIn("inputs.", workflow)
        for forbidden in ("timeout-minutes:", "max-parallel:", "max-cost:",
                          "max-tokens:", "budget:", "price:"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, workflow)

    def test_repository_workflows_require_explicit_manual_dispatch(self):
        workflows = sorted((SCRIPT.parent.parent / ".github/workflows").glob("*.y*ml"))
        self.assertTrue(workflows)
        for file in workflows:
            with self.subTest(workflow=file.name):
                # Require the repository's explicit block form so shorthand or
                # a newly added automatic event cannot silently escape this check.
                text = file.read_text()
                blocks = re.findall(r"(?m)^on:\s*\n((?:[ \t]+[^\n]*\n|\n)*)", text)
                self.assertEqual(len(blocks), 1)
                events = re.findall(r"(?m)^  ([A-Za-z_][A-Za-z0-9_-]*):", blocks[0])
                self.assertEqual(events, ["workflow_dispatch"])

    class _Response:
        def __init__(self, body, status=200):
            self.body = body
            self.status = status

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, count):
            return self.body[:count]

    class _Opener:
        def __init__(self, response=None, error=None):
            self.response = response
            self.error = error
            self.calls = []

        def open(self, request, timeout):
            self.calls.append((request, timeout))
            if self.error is not None:
                raise self.error
            return self.response

    def test_true_false_and_only_one_read_only_request(self):
        for flag, expected in ((True, "available"), (False, "unavailable")):
            with self.subTest(flag=flag):
                response = self._Response(json.dumps({"is_available": flag,
                    "balance_infos": [{"currency": "CNY", "total_balance": "SECRET-AMOUNT-412.15",
                                       "granted_balance": "0.00", "topped_up_balance": "412.15"}]}).encode())
                opener = self._Opener(response)
                self.assertEqual(balance_probe.probe_balance("SECRET-CREDENTIAL", opener), expected)
                self.assertEqual(len(opener.calls), 1)
                request, timeout = opener.calls[0]
                self.assertEqual(request.full_url, "https://api.deepseek.com/user/balance")
                self.assertEqual(request.get_method(), "GET")
                self.assertEqual(request.get_header("Authorization"), "Bearer SECRET-CREDENTIAL")
                self.assertEqual(timeout, balance_probe.TIMEOUT_SECONDS)

    def test_malformed_network_redirect_and_missing_key_are_unknown(self):
        bodies = [b"not-json", b"[]", b'{"is_available":"true"}',
                  b'{"is_available":1}', b'{"is_available":true,"is_available":false}',
                  b'{"is_available":true}', b'{"is_available":true,"balance_infos":[]}',
                  b'{"is_available":true,"balance_infos":[{"currency":"CNY"}]}',
                  b"x" * (balance_probe.MAX_RESPONSE_BYTES + 1)]
        for body in bodies:
            with self.subTest(body=body[:20]):
                self.assertEqual(balance_probe.probe_balance("KEY", self._Opener(self._Response(body))),
                                 "unknown")
        self.assertEqual(balance_probe.probe_balance("KEY", self._Opener(self._Response(b"{}", 503))),
                         "unknown")
        self.assertEqual(balance_probe.probe_balance("KEY", self._Opener(self._Response(
            b'{"is_available":false,"balance_infos":[]}'))), "unavailable")
        self.assertEqual(balance_probe.probe_balance("KEY", self._Opener(error=OSError(
            "SECRET-CREDENTIAL SECRET-AMOUNT-412.15"))), "unknown")
        no_key = self._Opener(error=AssertionError("must not request"))
        self.assertEqual(balance_probe.probe_balance("", no_key), "unknown")
        self.assertEqual(no_key.calls, [])
        self.assertIsNone(balance_probe._NoRedirect().redirect_request(None, None, 302, "", {},
                                                                        "https://example.com"))

    def test_verdict_roundtrips_and_artifact_contains_no_secret_or_amount(self):
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        spki = private_key.public_key().public_bytes(serialization.Encoding.DER,
                                                      serialization.PublicFormat.SubjectPublicKeyInfo)
        fingerprint = hashlib.sha256(spki).hexdigest()
        metadata = {"repository": "SakuyaInazaki/Mul-Pis", "run_id": "123",
                    "run_attempt": "1", "commit": "a" * 40, "event": "push"}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "public.pem"
            public.write_bytes(private_key.public_key().public_bytes(serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo))
            output = root / "provider-balance.enc.json"
            transport.encrypt_balance_verdict("available", public, output, metadata, fingerprint)
            private = root / "private.pem"
            private.write_bytes(private_key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            self.assertEqual(transport.decrypt_balance_verdict(output, private, fingerprint),
                             ("available", metadata))
            raw = output.read_bytes()
            self.assertNotIn(b"SECRET-CREDENTIAL", raw)
            self.assertNotIn(b"SECRET-AMOUNT-412.15", raw)
            self.assertNotIn(b'"availability"', raw)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            envelope = json.loads(raw)
            self.assertEqual(set(envelope), {"format", "key_wrap", "content_cipher",
                "recipient_spki_sha256", "metadata", "wrapped_key_b64", "nonce_b64",
                "ciphertext_b64"})
            self.assertEqual(envelope["format"], "mul-pis-provider-balance-v1")
            self.assertEqual(envelope["metadata"], metadata)
            aes_key = private_key.decrypt(base64.b64decode(envelope["wrapped_key_b64"]),
                padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()),
                             algorithm=hashes.SHA256(), label=None))
            aad = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode()
            plaintext = AESGCM(aes_key).decrypt(base64.b64decode(envelope["nonce_b64"]),
                base64.b64decode(envelope["ciphertext_b64"]), aad)
            self.assertEqual(json.loads(plaintext), {"kind": "provider-balance-availability",
                "version": 1, "availability": "available"})
            with self.assertRaises(Exception):
                AESGCM(aes_key).decrypt(base64.b64decode(envelope["nonce_b64"]),
                    base64.b64decode(envelope["ciphertext_b64"]), b"other run")
            tampered = root / "tampered.enc.json"
            altered = dict(envelope)
            altered["metadata"] = dict(metadata, run_id="456")
            tampered.write_text(json.dumps(altered))
            with self.assertRaises(transport.TransportError):
                transport.decrypt_balance_verdict(tampered, private, fingerprint)
            altered = dict(envelope, format="mul-pis-private-campaign-v1")
            tampered.write_text(json.dumps(altered))
            with self.assertRaises(transport.TransportError):
                transport.decrypt_balance_verdict(tampered, private, fingerprint)
            with self.assertRaises(transport.TransportError):
                transport.encrypt_balance_verdict("available", public, output, metadata, fingerprint)
            with self.assertRaises(transport.TransportError):
                transport.encrypt_balance_verdict("42", public, root / "invalid", metadata,
                                                  fingerprint)

    def test_cli_never_logs_verdict_credential_or_provider_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            private_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
            public = root / "public.pem"
            public.write_bytes(private_key.public_key().public_bytes(serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo))
            spki = private_key.public_key().public_bytes(serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo)
            output = root / "provider-balance.enc.json"
            args = ["provider_balance_probe.py", "--public-key", str(public),
                    "--expected-spki-sha256", hashlib.sha256(spki).hexdigest(),
                    "--output", str(output), "--repository", "SakuyaInazaki/Mul-Pis",
                    "--run-id", "123", "--run-attempt", "1", "--commit", "a" * 40,
                    "--event", "push", "--source-commit", "b" * 40]
            stdout, stderr = io.StringIO(), io.StringIO()
            with (patch.object(sys, "argv", args), patch.dict(os.environ, {
                    "DEEPSEEK_API_KEY": "SECRET-CREDENTIAL"}), patch.object(
                        balance_probe, "probe_balance", return_value="unknown") as fake_probe,
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr)):
                code = balance_probe.main()
            self.assertEqual(code, 0)
            fake_probe.assert_called_once_with("SECRET-CREDENTIAL")
            self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
            self.assertTrue(output.exists())
            output.unlink()
            with (patch.object(sys, "argv", args), patch.dict(os.environ, {
                    "DEEPSEEK_API_KEY": "SECRET-CREDENTIAL"}), patch.object(
                        balance_probe, "probe_balance", side_effect=RuntimeError(
                            "SECRET-CREDENTIAL SECRET-AMOUNT-412.15")),
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr)):
                code = balance_probe.main()
            self.assertEqual(code, 1)
            self.assertNotIn("SECRET-CREDENTIAL", stdout.getvalue() + stderr.getvalue())
            self.assertNotIn("SECRET-AMOUNT-412.15", stdout.getvalue() + stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
