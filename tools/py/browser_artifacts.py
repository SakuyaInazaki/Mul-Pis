"""Bounded, incremental artifact capture for a live browser-use session."""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MAX_PAGE_STATES = 20
MAX_SCREENSHOTS = 12
MAX_HTML_BYTES = 5_000_000
MAX_TEXT_BYTES = 2_000_000
MAX_DOWNLOAD_BYTES = 250_000_000


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


class ArtifactRecorder:
    """Capture pages already rendered by browser-use; never refetch their URLs."""

    def __init__(self, out_dir: Path, meta: dict[str, Any]) -> None:
        self.out_dir = out_dir.resolve()
        self.meta = meta
        self.pages_dir = self.out_dir / "pages"
        self.downloads_dir = self.out_dir / "downloads"
        self.pages_dir.mkdir(parents=True, exist_ok=True)
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        self.meta.setdefault("artifacts", [])
        self.meta.setdefault("visitedUrls", [])
        self.meta.setdefault("warnings", [])
        self._last_page_state: tuple[str, str, str] | None = None
        self._downloads: set[str] = set()
        self._download_bytes = 0
        self._html_bytes = 0
        self._text_bytes = 0
        self._screenshots = 0
        self._page_sequence = 0
        self._download_sources: dict[str, tuple[str, str | None]] = {}
        self.persist()

    def persist(self) -> None:
        self.meta["finishedAt"] = utc_now()
        atomic_json(self.out_dir / "meta.json", self.meta)

    def warn_once(self, warning: str) -> None:
        if warning not in self.meta["warnings"]:
            self.meta["warnings"].append(warning)

    def note_download(self, event: Any) -> None:
        path = str(getattr(event, "path", "") or "")
        if path:
            self._download_sources[path] = (
                str(getattr(event, "url", "") or ""),
                str(getattr(event, "mime_type", "") or "") or None,
            )
            self.register_download(path, self._download_sources[path][0])
            self.persist()

    def safe_file(self, value: str | Path) -> Path | None:
        try:
            candidate = Path(value)
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(self.out_dir)
            if not resolved.is_file() or candidate.is_symlink():
                return None
            return resolved
        except (OSError, ValueError):
            return None

    def add_artifact(self, path: Path, kind: str, **facts: Any) -> None:
        safe = self.safe_file(path)
        if safe is None:
            self.warn_once(f"Rejected artifact outside output directory or through a symlink: {path}")
            return
        relative = str(safe.relative_to(self.out_dir))
        if any(item.get("path") == relative for item in self.meta["artifacts"]):
            return
        artifact = {"path": relative, "kind": kind, **{k: v for k, v in facts.items() if v}}
        self.meta["artifacts"].append(artifact)

    async def capture(self, browser_session: Any, *, final: bool = False) -> None:
        """Capture the focused page after interaction in the same live session."""
        captured_at = utc_now()
        current_url = ""
        try:
            page = await browser_session.get_current_page()
            if page is None:
                self.warn_once("No focused browser page was available for artifact capture")
                return
            url = await page.get_url()
            current_url = url
            title = await page.get_title()
            if url and url != "about:blank" and url not in self.meta["visitedUrls"]:
                self.meta["visitedUrls"].append(url)

            html = await page.evaluate("() => document.documentElement ? document.documentElement.outerHTML : ''")
            text = await page.evaluate("() => document.body ? document.body.innerText : ''")
            current_state = (url, html, text)
            should_capture_page = bool(url and url != "about:blank" and current_state != self._last_page_state)
            captured_sequence: int | None = None
            if should_capture_page and self._page_sequence < MAX_PAGE_STATES:
                self._page_sequence += 1
                captured_sequence = self._page_sequence
                stem = f"page-{self._page_sequence:03d}"
                html_data = html.encode("utf-8")
                text_data = text.encode("utf-8")
                if self._html_bytes + len(html_data) <= MAX_HTML_BYTES:
                    html_path = self.pages_dir / f"{stem}.html"
                    html_path.write_bytes(html_data)
                    self._html_bytes += len(html_data)
                    self.add_artifact(html_path, "html", url=url, title=title, capturedAt=captured_at, contentType="text/html")
                else:
                    self.warn_once(f"HTML capture limit reached ({MAX_HTML_BYTES} bytes); later page HTML was omitted")
                if self._text_bytes + len(text_data) <= MAX_TEXT_BYTES:
                    md_path = self.pages_dir / f"{stem}.md"
                    heading = f"# {title or url}\n\nSource: {url}\nCaptured: {captured_at}\n\n"
                    md_path.write_text(heading + text + "\n", encoding="utf-8")
                    self._text_bytes += len(text_data)
                    self.add_artifact(md_path, "markdown", url=url, title=title, capturedAt=captured_at, contentType="text/markdown")
                else:
                    self.warn_once(f"Text capture limit reached ({MAX_TEXT_BYTES} bytes); later page text was omitted")
                self._last_page_state = current_state
            elif should_capture_page:
                self.warn_once(f"Page-state capture limit reached ({MAX_PAGE_STATES}); later changed DOM states were omitted and coverage is incomplete")

            if captured_sequence is not None and self._screenshots < MAX_SCREENSHOTS:
                try:
                    shot_path = self.pages_dir / f"page-{captured_sequence:03d}.png"
                    shot_path.write_bytes(base64.b64decode(await page.screenshot()))
                    self._screenshots += 1
                    self.add_artifact(shot_path, "screenshot", url=url, title=title, capturedAt=captured_at, contentType="image/png")
                except Exception as exc:
                    self.warn_once(f"Live page screenshot failed: {type(exc).__name__}: {exc}")
            elif captured_sequence is not None:
                self.warn_once(f"Screenshot capture limit reached ({MAX_SCREENSHOTS}); later screenshots were omitted")
        except Exception as exc:
            self.warn_once(f"Live page capture failed: {type(exc).__name__}: {exc}")
        finally:
            self.capture_downloads(browser_session, current_url)
            self.persist()

    def capture_downloads(self, browser_session: Any, current_url: str) -> None:
        for raw_path in getattr(browser_session, "downloaded_files", []) or []:
            self.register_download(str(raw_path), current_url)

    def register_download(self, raw_path: str, current_url: str) -> None:
        if raw_path in self._downloads:
            return
        path = self.safe_file(raw_path)
        if path is None or path.parent != self.downloads_dir:
            self.warn_once(f"Rejected download outside the dedicated output directory or through a symlink: {raw_path}")
            return
        try:
            size = path.stat().st_size
        except OSError as exc:
            self.warn_once(f"Could not inspect download {path.name}: {exc}")
            return
        if size > MAX_DOWNLOAD_BYTES or self._download_bytes + size > MAX_DOWNLOAD_BYTES:
            self.warn_once(f"Download artifact limit reached ({MAX_DOWNLOAD_BYTES} bytes); oversized downloads were not registered")
            return
        source_url, content_type = self._download_sources.get(raw_path, (current_url, None))
        self.add_artifact(
            path,
            "download",
            url=source_url,
            capturedAt=utc_now(),
            contentType=content_type or mimetypes.guess_type(path.name)[0],
        )
        self._downloads.add(raw_path)
        self._download_bytes += size
