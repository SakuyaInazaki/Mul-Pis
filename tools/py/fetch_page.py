#!/usr/bin/env python3
"""Fetch a web page with Crawl4AI, with an honest plain-HTTP fallback."""

from __future__ import annotations

import argparse
import asyncio
import json
import mimetypes
import os
import re
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser


USER_AGENT = "Mul-Pis-M05/1.0 (+research acquisition; respects access controls)"
BLOCKED_STATUSES = {401, 403, 407, 429, 451}


class ContentParser(HTMLParser):
    """Small dependency-free HTML title/text/link extractor."""

    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.links: list[dict[str, str]] = []
        self._in_title = False
        self._skip_depth = 0
        self._link_href: str | None = None
        self._link_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        values = dict(attrs)
        if tag == "title":
            self._in_title = True
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
        if tag == "a" and values.get("href"):
            self._link_href = urljoin(self.base_url, values["href"] or "")
            self._link_text = []
        if tag in {
            "p", "div", "section", "article", "main", "header", "footer", "nav",
            "h1", "h2", "h3", "h4", "h5", "h6", "li", "br", "tr",
        }:
            self.text_parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
        if tag == "a" and self._link_href:
            text = " ".join("".join(self._link_text).split())
            parsed = urlparse(self._link_href)
            if parsed.scheme.lower() in {"http", "https"}:
                self.links.append({"text": text, "href": self._link_href})
            self._link_href = None
            self._link_text = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)
        if self._skip_depth:
            return
        self.text_parts.append(data)
        if self._link_href:
            self._link_text.append(data)

    @property
    def title(self) -> str:
        return " ".join("".join(self.title_parts).split())

    @property
    def markdown(self) -> str:
        lines = [" ".join(line.split()) for line in "".join(self.text_parts).splitlines()]
        return "\n\n".join(line for line in lines if line).strip() + "\n"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def empty_meta(url: str, engine: str) -> dict[str, Any]:
    return {
        "url": url,
        "finalUrl": url,
        "status": None,
        "title": "",
        "fetchedAt": utc_now(),
        "engine": engine,
        "kind": "page",
        "contentType": "",
        "bytes": 0,
        "markdownPath": "",
        "htmlPath": "",
        "filePath": "",
        "links": [],
        "warnings": [],
        "error": None,
    }


def content_extension(content_type: str, url: str) -> str:
    media_type = content_type.split(";", 1)[0].strip().lower()
    explicit = {
        "application/pdf": ".pdf",
        "application/json": ".json",
        "application/zip": ".zip",
        "text/plain": ".txt",
        "text/csv": ".csv",
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }.get(media_type)
    if explicit:
        return explicit
    guessed = mimetypes.guess_extension(media_type) if media_type else None
    if guessed:
        return guessed
    suffix = Path(urlparse(url).path).suffix
    return suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,10}", suffix or "") else ".bin"


def is_html(content_type: str) -> bool:
    media_type = content_type.split(";", 1)[0].strip().lower()
    return not media_type or media_type in {"text/html", "application/xhtml+xml"}


def write_page(
    out_dir: Path,
    html: str,
    markdown: str,
    meta: dict[str, Any],
    *,
    links_complete: bool,
) -> None:
    html_path = out_dir / "page.html"
    markdown_path = out_dir / "page.md"
    html_path.write_text(html, encoding="utf-8")
    markdown_path.write_text(markdown, encoding="utf-8")
    meta["htmlPath"] = str(html_path.resolve())
    meta["markdownPath"] = str(markdown_path.resolve())
    parser = ContentParser(meta["finalUrl"])
    parser.feed(html)
    if not meta["title"]:
        meta["title"] = parser.title
    unique_links: list[dict[str, str]] = []
    seen: set[str] = set()
    for link in parser.links:
        if link["href"] in seen:
            continue
        seen.add(link["href"])
        unique_links.append(link)
    meta["linksTotal"] = len(unique_links)
    meta["links"] = unique_links
    meta["linksComplete"] = links_complete


def robots_allows(url: str, timeout: float) -> tuple[bool, str | None]:
    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    try:
        request = Request(robots_url, headers={"User-Agent": USER_AGENT})
        with urlopen(request, timeout=min(timeout, 10.0)) as response:
            text = response.read(1_000_000).decode("utf-8", errors="replace")
        rules = RobotFileParser()
        rules.set_url(robots_url)
        rules.parse(text.splitlines())
        if not rules.can_fetch(USER_AGENT, url):
            return False, f"robots.txt disallows this URL; no fetch was attempted ({robots_url})"
    except HTTPError as exc:
        if exc.code in BLOCKED_STATUSES:
            return False, (
                f"robots.txt access was blocked with HTTP {exc.code}; "
                "the target URL was not fetched"
            )
        if exc.code not in {404, 410}:
            return True, f"robots.txt returned HTTP {exc.code}; continued without bypass techniques"
    except Exception as exc:
        return True, (
            f"Could not check robots.txt ({type(exc).__name__}: {exc}); "
            "continued without bypass techniques"
        )
    return True, None


def http_fetch(
    url: str,
    out_dir: Path,
    timeout: float,
    prior_warnings: list[str] | None = None,
) -> tuple[dict[str, Any], bool]:
    meta = empty_meta(url, "http")
    meta["warnings"] = list(prior_warnings or [])
    allowed, robots_message = robots_allows(url, timeout)
    if robots_message and allowed:
        meta["warnings"].append(robots_message)
    if not allowed:
        meta["error"] = robots_message
        return meta, False
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    response = None
    try:
        response = urlopen(request, timeout=timeout)
    except HTTPError as exc:
        response = exc
        meta["warnings"].append(f"HTTP server returned {exc.code} {exc.reason}")
    except Exception as exc:
        meta["error"] = f"HTTP fetch failed: {type(exc).__name__}: {exc}"
        return meta, False

    try:
        body = response.read()
        meta["status"] = int(response.status)
        meta["finalUrl"] = response.geturl()
        meta["contentType"] = response.headers.get("Content-Type", "")
        meta["bytes"] = len(body)
        if meta["status"] in BLOCKED_STATUSES:
            meta["warnings"].append(
                f"Access appears blocked (HTTP {meta['status']}); no bypass was attempted"
            )
        if meta["status"] >= 400:
            meta["error"] = f"HTTP {meta['status']}"
            meta["warnings"].append(
                f"Saved HTTP {meta['status']} response page for diagnosis; "
                "target-page link extraction is not claimed complete"
            )
        if not body:
            meta["error"] = f"HTTP {meta['status']} returned no content"
            return meta, False
        if not is_html(meta["contentType"]):
            meta["kind"] = "file"
            file_path = out_dir / f"download{content_extension(meta['contentType'], meta['finalUrl'])}"
            file_path.write_bytes(body)
            meta["filePath"] = str(file_path.resolve())
            return meta, True

        charset = response.headers.get_content_charset() or "utf-8"
        html = body.decode(charset, errors="replace")
        parser = ContentParser(meta["finalUrl"])
        parser.feed(html)
        write_page(
            out_dir,
            html,
            parser.markdown,
            meta,
            links_complete=meta["status"] < 400,
        )
        return meta, True
    except Exception as exc:
        meta["error"] = f"Could not save fetched content: {type(exc).__name__}: {exc}"
        return meta, False
    finally:
        response.close()


def header_value(headers: Any, name: str) -> str:
    if not headers:
        return ""
    for key, value in dict(headers).items():
        if str(key).lower() == name.lower():
            return str(value)
    return ""


def crawl_markdown(result: Any) -> str:
    value = getattr(result, "markdown", None)
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    for attr in ("fit_markdown", "raw_markdown", "markdown_with_citations"):
        candidate = getattr(value, attr, None)
        if candidate:
            return str(candidate)
    return str(value) if value else ""


async def crawl_fetch(url: str, out_dir: Path, timeout: float) -> tuple[dict[str, Any], bool]:
    meta = empty_meta(url, "crawl4ai")
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(Path(sys.prefix) / "ms-playwright"))
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig
        from crawl4ai.content_filter_strategy import PruningContentFilter
        from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
    except Exception as exc:
        warning = f"Crawl4AI import failed; used HTTP fallback: {type(exc).__name__}: {exc}"
        return http_fetch(url, out_dir, timeout, [warning])

    try:
        browser_config = BrowserConfig(headless=True)
        markdown_generator = DefaultMarkdownGenerator(
            content_filter=PruningContentFilter(
                threshold=0.48, threshold_type="fixed", min_word_threshold=0
            )
        )
        run_config = CrawlerRunConfig(
            page_timeout=max(1, int(timeout * 1000)),
            check_robots_txt=True,
            markdown_generator=markdown_generator,
        )
        async with AsyncWebCrawler(config=browser_config) as crawler:
            result = await asyncio.wait_for(
                crawler.arun(url=url, config=run_config), timeout=timeout + 15
            )
    except Exception as exc:
        warning = f"Crawl4AI failed; used HTTP fallback: {type(exc).__name__}: {exc}"
        return http_fetch(url, out_dir, timeout, [warning])

    meta["status"] = (
        getattr(result, "redirected_status_code", None)
        or getattr(result, "status_code", None)
    )
    meta["finalUrl"] = str(
        getattr(result, "redirected_url", None)
        or getattr(result, "url", None)
        or url
    )
    meta["contentType"] = header_value(getattr(result, "response_headers", None), "content-type")
    if meta["status"] in BLOCKED_STATUSES:
        meta["warnings"].append(
            f"Access appears blocked (HTTP {meta['status']}); no bypass was attempted"
        )
    if not is_html(meta["contentType"]):
        warning = "Crawl4AI reported non-HTML content; downloaded it with plain HTTP"
        return http_fetch(url, out_dir, timeout, meta["warnings"] + [warning])

    html = str(getattr(result, "html", None) or "")
    markdown = crawl_markdown(result)
    meta["bytes"] = len(html.encode("utf-8"))
    metadata = getattr(result, "metadata", None) or {}
    if isinstance(metadata, dict):
        meta["title"] = str(metadata.get("title") or "")
    if not bool(getattr(result, "success", True)):
        message = str(getattr(result, "error_message", None) or "Crawl4AI reported failure")
        meta["warnings"].append(message)
    result_success = bool(getattr(result, "success", True))
    status_success = isinstance(meta["status"], int) and meta["status"] < 400
    if isinstance(meta["status"], int) and meta["status"] >= 400:
        meta["error"] = f"HTTP {meta['status']}"
        meta["warnings"].append(
            f"Saved HTTP {meta['status']} response page for diagnosis; "
            "target-page link extraction is not claimed complete"
        )
    if html or markdown:
        if not html:
            html = ""
        if not markdown:
            parser = ContentParser(meta["finalUrl"])
            parser.feed(html)
            markdown = parser.markdown
            meta["warnings"].append(
                "Crawl4AI returned no markdown; generated minimal text from HTML"
            )
        write_page(
            out_dir,
            html,
            markdown,
            meta,
            links_complete=result_success and status_success,
        )
        return meta, True

    meta["error"] = str(getattr(result, "error_message", None) or "Crawl4AI returned no content")
    return meta, False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch a URL into page/file artifacts and meta.json"
    )
    parser.add_argument("url", metavar="URL")
    parser.add_argument("--out", required=True, type=Path, metavar="DIR")
    parser.add_argument("--timeout", type=float, default=30.0, metavar="SECONDS")
    parser.add_argument("--no-browser", action="store_true", help="use plain HTTP instead of Crawl4AI")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")

    args.out.mkdir(parents=True, exist_ok=True)
    if args.no_browser:
        meta, ok = http_fetch(args.url, args.out, args.timeout)
    else:
        meta, ok = asyncio.run(crawl_fetch(args.url, args.out, args.timeout))
    meta_path = args.out / "meta.json"
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
