#!/usr/bin/env python3
"""Run an interactive browser task and preserve observed source artifacts."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# runScript invokes adapters with Python isolated mode, which omits the script directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


from browser_artifacts import ArtifactRecorder, atomic_json


def write_meta(out_dir: Path, meta: dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    atomic_json(out_dir / "meta.json", meta)


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


async def run_agent(
    url: str, task: str, provider: str, model: str, out_dir: Path,
    meta: dict[str, Any], max_steps: int,
) -> tuple[str, int | None, bool | None]:
    os.environ.setdefault(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path(sys.prefix) / "ms-playwright")
    )
    from browser_use import Agent, BrowserSession, ChatAnthropic, ChatOpenAI
    from browser_use.browser.events import FileDownloadedEvent

    llm = ChatOpenAI(model=model) if provider == "openai" else ChatAnthropic(model=model)
    full_task = (
        f"Start at this URL: {url}\n\nTask: {task}\n\n"
        "Respect access controls and paywalls; do not attempt to bypass them. "
        "Use normal access already available in the browser session when the task calls for it."
    )
    browser_session = BrowserSession(
        headless=True,
        downloads_path=out_dir / "downloads",
        enable_default_extensions=False,
    )
    recorder = ArtifactRecorder(out_dir, meta)
    browser_session.event_bus.on(FileDownloadedEvent, recorder.note_download)
    agent = Agent(task=full_task, llm=llm, browser_session=browser_session, use_judge=False)

    async def capture_step(_agent: Any) -> None:
        await recorder.capture(browser_session)

    try:
        history = await agent.run(max_steps=max_steps, on_step_end=capture_step)
        await recorder.capture(browser_session, final=True)
    finally:
        try:
            current_url = await browser_session.get_current_page_url()
        except Exception as exc:
            current_url = ""
            recorder.warn_once(
                f"Could not read final browser URL: {type(exc).__name__}: {exc}"
            )
        recorder.capture_downloads(browser_session, current_url)
        recorder.persist()
    final = history.final_result() or ""
    history_items = getattr(history, "history", None)
    steps = len(history_items) if history_items is not None else None
    return str(final), steps, history.is_successful()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run an LLM-driven browser-use task with raw artifact capture"
    )
    parser.add_argument("--url", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--out", required=True, type=Path, metavar="DIR")
    parser.add_argument(
        "--model", required=True, help="provider/model; supports openai and anthropic"
    )
    parser.add_argument("--max-steps", type=int, default=40)
    args = parser.parse_args()

    meta: dict[str, Any] = {
        "url": args.url,
        "task": args.task,
        "model": args.model,
        "finishedAt": utc_now(),
        "steps": None,
        "artifacts": [],
        "visitedUrls": [],
        "warnings": [],
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
        if args.max_steps <= 0 or args.max_steps > 200:
            raise ValueError("--max-steps must be between 1 and 200")
        result, steps, successful = asyncio.run(
            run_agent(args.url, args.task, provider, model, args.out, meta, args.max_steps)
        )
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "result.md").write_text(result.rstrip() + "\n", encoding="utf-8")
        meta["steps"] = steps
        meta["agentReportedSuccess"] = successful
        if successful is False:
            meta["complete"] = False
            meta["warnings"].append("browser-use reported that the requested task was incomplete")
        elif successful is True:
            meta["warnings"].append("browser-use reported success; raw artifact coverage was not independently proven complete")
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
