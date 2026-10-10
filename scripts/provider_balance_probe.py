#!/usr/bin/env python3
"""One read-only DeepSeek balance request; publish only a sealed static verdict."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path


BALANCE_URL = "https://api.deepseek.com/user/balance"
MAX_RESPONSE_BYTES = 16 * 1024
TIMEOUT_SECONDS = 8


def accepted_offline_ci(get_json, source: str) -> bool:
    """Inspect every page of the exact-source CI run census before admission."""
    seen: set[int] = set()
    total: int | None = None
    page = 1
    accepted = False
    while True:
        response = get_json('actions/workflows/workflow-regression.yml/runs?head_sha=' +
                            source + '&per_page=100&page=' + str(page))
        rows = response.get('workflow_runs')
        count = response.get('total_count')
        if (type(count) is not int or count < 0 or not isinstance(rows, list) or
                len(rows) > 100 or (total is not None and count != total)):
            raise ValueError('unstable CI run census')
        if total is None:
            total = count
        expected = min(100, total - len(seen))
        if len(rows) != expected:
            raise ValueError('incomplete CI run census')
        for row in rows:
            if not isinstance(row, dict) or type(row.get('id')) is not int or row['id'] <= 0:
                raise ValueError('invalid CI run identity')
            if row['id'] in seen:
                raise ValueError('duplicate CI run identity')
            seen.add(row['id'])
            if (row.get('head_sha') == source and
                    row.get('head_branch') == 'improve/workflow-learning-reliability' and
                    row.get('event') == 'push' and row.get('run_attempt') == 1 and
                    row.get('conclusion') == 'success'):
                accepted = True
        if len(seen) == total:
            return accepted
        page += 1


def valid_probe_request_before(parents: list[str], before: str) -> bool:
    """Bind a probe push to an initial creation or the exact prior probe tip."""
    if (len(parents) not in (1, 2) or
            any(not re.fullmatch(r"[0-9a-f]{40}", parent) for parent in parents) or
            not re.fullmatch(r"[0-9a-f]{40}", before)):
        return False
    if len(parents) == 1:
        return before in {"0" * 40, parents[0]}
    return parents[1] != parents[0] and before == parents[1]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("duplicate JSON field")
        result[name] = value
    return result


def probe_balance(api_key: str, opener=None) -> str:
    """Return available, unavailable, or unknown without exposing provider data."""
    if not api_key:
        return "unknown"
    try:
        request = urllib.request.Request(BALANCE_URL, headers={
            "Authorization": "Bearer " + api_key,
            "Accept": "application/json",
        }, method="GET")
        client = opener if opener is not None else urllib.request.build_opener(_NoRedirect())
        with client.open(request, timeout=TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return "unknown"
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            return "unknown"
        parsed = json.loads(body.decode("utf-8"), object_pairs_hook=_unique_object)
        if not isinstance(parsed, dict):
            return "unknown"
        value = parsed.get("is_available")
        infos = parsed.get("balance_infos")
        if type(value) is not bool or not isinstance(infos, list):
            return "unknown"
        for info in infos:
            if not isinstance(info, dict) or not isinstance(info.get("currency"), str) or not info["currency"]:
                return "unknown"
            if any(not isinstance(info.get(field), str) for field in (
                    "total_balance", "granted_balance", "topped_up_balance")):
                return "unknown"
        if not value:
            return "unavailable"
        return "available" if infos else "unknown"
    except Exception:
        # Includes HTTP/network/JSON errors; no provider error body reaches logs.
        return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description="Private provider balance availability check")
    parser.add_argument("--public-key", required=True, type=Path)
    parser.add_argument("--expected-spki-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    for field in ("repository", "run-id", "run-attempt", "commit", "event", "source-commit"):
        parser.add_argument("--" + field, required=True)
    args = parser.parse_args()
    try:
        from private_actions_transport import encrypt_balance_verdict

        metadata = {"repository": args.repository, "run_id": args.run_id,
                    "run_attempt": args.run_attempt, "commit": args.commit,
                    "event": args.event}
        if (args.repository != "SakuyaInazaki/Mul-Pis" or args.event != "push" or
                args.run_attempt != "1" or not re.fullmatch(r"[1-9][0-9]*", args.run_id) or
                not re.fullmatch(r"[0-9a-f]{40}", args.commit) or
                not re.fullmatch(r"[0-9a-f]{40}", args.source_commit) or
                args.source_commit == args.commit):
            raise ValueError("invalid run binding")
        verdict = probe_balance(os.environ.get("DEEPSEEK_API_KEY", ""))
        encrypt_balance_verdict(verdict, args.public_key, args.output,
                                metadata, args.expected_spki_sha256)
        return 0
    except Exception:
        print("Private provider balance check failed.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
