#!/usr/bin/env python3
"""Run a last-resort interactive browser task through browser-use."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_meta(out_dir: Path, meta: dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def split_model(spec: str) -> tuple[str, str]:
    if "/" not in spec:
        raise ValueError(
            "--model must use provider/model format "
            "(for example openai/gpt-4.1-mini)"
        )
    provider, model = spec.split("/", 1)
    provider = provider.lower().strip()
    model = model.strip()
    if provider not in {"openai", "anthropic"} or not model:
        raise ValueError("supported model providers are openai and anthropic")
    return provider, model


async def run_agent(url: str, task: str, provider: str, model: str) -> tuple[str, int | None]:
    os.environ.setdefault(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path(sys.prefix) / "ms-playwright")
    )
    from browser_use import Agent, ChatAnthropic, ChatOpenAI

    llm = ChatOpenAI(model=model) if provider == "openai" else ChatAnthropic(model=model)
    full_task = (
        f"Start at this URL: {url}\n\nTask: {task}\n\n"
        "Respect robots directives, logins, paywalls, and access controls. "
        "Do not attempt to bypass them."
    )
    history = await Agent(task=full_task, llm=llm).run()
    final = history.final_result() or ""
    history_items = getattr(history, "history", None)
    steps = len(history_items) if history_items is not None else None
    return str(final), steps


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run an LLM-driven browser-use task (last resort)"
    )
    parser.add_argument("--url", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--out", required=True, type=Path, metavar="DIR")
    parser.add_argument(
        "--model", required=True, help="provider/model; supports openai and anthropic"
    )
    args = parser.parse_args()

    meta: dict[str, Any] = {
        "url": args.url,
        "task": args.task,
        "model": args.model,
        "finishedAt": utc_now(),
        "steps": None,
        "error": None,
    }
    try:
        provider, model = split_model(args.model)
    except ValueError as exc:
        meta["error"] = str(exc)
        write_meta(args.out, meta)
        print(f"error: {exc}", file=sys.stderr)
        return 3

    key_name = "OPENAI_API_KEY" if provider == "openai" else "ANTHROPIC_API_KEY"
    if not os.environ.get(key_name):
        meta["error"] = f"{key_name} is required for model {args.model}"
        write_meta(args.out, meta)
        print(f"error: {meta['error']}", file=sys.stderr)
        return 3

    try:
        result, steps = asyncio.run(run_agent(args.url, args.task, provider, model))
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "result.md").write_text(result.rstrip() + "\n", encoding="utf-8")
        meta["steps"] = steps
        meta["finishedAt"] = utc_now()
        write_meta(args.out, meta)
        return 0
    except Exception as exc:
        meta["finishedAt"] = utc_now()
        meta["error"] = f"browser-use failed: {type(exc).__name__}: {exc}"
        write_meta(args.out, meta)
        print(f"error: {meta['error']}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
