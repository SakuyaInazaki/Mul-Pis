import base64
import contextlib
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

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


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

    def test_rejects_unsafe_archive_members(self):
        variants = [
            [("../escape", b"x", "file"), ("a", b"a", "file"), ("b", b"b", "file")],
            [("link", b"elsewhere", "symlink"), ("a", b"a", "file"), ("b", b"b", "file")],
            [("x", b"a", "file"), ("x", b"b", "file"), ("b", b"c", "file")],
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for variant in variants:
                with self.subTest(variant=variant):
                    with self.assertRaises(transport.TransportError):
                        transport.decode_secret(archive(variant), Path(tmp))
            self.assertEqual(list(Path(tmp).iterdir()), [])


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

    def test_multipart_checkpoint_rejects_missing_and_tampered_parts(self):
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

    def test_roundtrip_and_allowlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results"
            results.mkdir()
            accepted = {
                "candidate.cpp": b"secret candidate",
                "round-1-reviewer-feedback.txt": b"Full reviewer rationale, beyond a short index.",
                "workflow-archive.json": b'{"trustedAdoption":false}',
                "m04-transaction.json": b'{"kind":"m04-knowledge-transaction","state":"rejected-draft"}',
                "campaign-status.json": b'{"status":"incomplete"}',
                "ledger-continuation.part-00000000.enc": b"c2VnbWVudC0w",
                "repair-state.json": b'{"kind":"workflow-repair-state","strategy":"fresh-context"}',
            }
            for name, content in accepted.items():
                (results / name).write_bytes(content)
            (results / "ignored.txt").write_bytes(b"excluded private data")
            public = root / "public.pem"
            public.write_bytes(self.private_key.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
            encrypted = root / "out.enc.json"
            transport.encrypt_results(results, public, encrypted, self.metadata, self.fingerprint)
            self.assertNotIn("secret candidate", encrypted.read_text())
            self.assertNotIn("excluded private data", encrypted.read_text())
            private_file = root / "private.key"
            private_file.write_bytes(self.private_key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption()))
            recovered = transport.decrypt_results(encrypted, private_file, root)
            self.assertEqual({p.name: p.read_bytes() for p in recovered.iterdir()}, accepted)
            self.assertEqual(recovered.stat().st_mode & 0o777, 0o700)
            self.assertEqual((recovered / "candidate.cpp").stat().st_mode & 0o777, 0o600)

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


class BalanceProbeTests(unittest.TestCase):
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

    def test_invalid_response_network_failure_and_missing_key_are_unknown(self):
        self.assertEqual(balance_probe.probe_balance(
            "KEY", self._Opener(self._Response(b"not-json"))), "unknown")
        self.assertEqual(balance_probe.probe_balance("KEY", self._Opener(error=OSError(
            "SECRET-CREDENTIAL SECRET-AMOUNT-412.15"))), "unknown")
        no_key = self._Opener(error=AssertionError("must not request"))
        self.assertEqual(balance_probe.probe_balance("", no_key), "unknown")
        self.assertEqual(no_key.calls, [])

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
            tampered = root / "tampered.enc.json"
            altered = dict(envelope)
            altered["metadata"] = dict(metadata, run_id="456")
            tampered.write_text(json.dumps(altered))
            with self.assertRaises(transport.TransportError):
                transport.decrypt_balance_verdict(tampered, private, fingerprint)

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
