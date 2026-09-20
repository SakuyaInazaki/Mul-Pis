"""Offline tests for browser artifact capture and page-link extraction."""

from __future__ import annotations

import asyncio
import base64
import io
import sys
import tempfile
import types
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser_artifacts import ArtifactRecorder
import fetch_page
from fetch_page import ContentParser, empty_meta, write_page


class FakePage:
    def __init__(self) -> None:
        self.url = "https://example.test/thread"
        self.title = "Thread"
        self.html = "<html><body>first</body></html>"
        self.text = "first"
        self.fail_screenshot = False

    async def get_url(self) -> str:
        return self.url

    async def get_title(self) -> str:
        return self.title

    async def evaluate(self, expression: str) -> str:
        return self.html if "outerHTML" in expression else self.text

    async def screenshot(self) -> str:
        if self.fail_screenshot:
            raise RuntimeError("offline screenshot failure")
        return base64.b64encode(b"fake-png").decode("ascii")


class FakeSession:
    def __init__(self, page: FakePage) -> None:
        self.page = page
        self.downloaded_files: list[str] = []

    async def get_current_page(self) -> FakePage:
        return self.page


class ArtifactRecorderTests(unittest.TestCase):
    def test_same_url_changed_dom_is_captured_and_download_is_registered(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            out_dir = Path(temporary)
            meta: dict[str, object] = {"warnings": [], "artifacts": [], "visitedUrls": []}
            recorder = ArtifactRecorder(out_dir, meta)
            page = FakePage()
            session = FakeSession(page)

            asyncio.run(recorder.capture(session))
            page.html = "<html><body>first expanded reply</body></html>"
            page.text = "first expanded reply"
            asyncio.run(recorder.capture(session))
            asyncio.run(recorder.capture(session))

            download = out_dir / "downloads" / "paper.pdf"
            download.write_bytes(b"pdf")
            session.downloaded_files.append(str(download))
            recorder.note_download(
                SimpleNamespace(path=str(download), url="https://example.test/paper.pdf", mime_type="application/pdf")
            )
            recorder.capture_downloads(session, page.url)
            recorder.persist()

            artifacts = meta["artifacts"]
            self.assertEqual(sum(item["kind"] == "html" for item in artifacts), 2)
            self.assertEqual(sum(item["kind"] == "markdown" for item in artifacts), 2)
            self.assertEqual(sum(item["kind"] == "screenshot" for item in artifacts), 2)
            downloads = [item for item in artifacts if item["kind"] == "download"]
            self.assertEqual(downloads[0]["url"], "https://example.test/paper.pdf")
            self.assertEqual(meta["visitedUrls"], [page.url])
            self.assertTrue((out_dir / "meta.json").is_file())

    def test_screenshot_failure_still_keeps_page_facts_and_download(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            out_dir = Path(temporary)
            meta: dict[str, object] = {"warnings": [], "artifacts": [], "visitedUrls": []}
            recorder = ArtifactRecorder(out_dir, meta)
            page = FakePage()
            page.fail_screenshot = True
            session = FakeSession(page)
            download = out_dir / "downloads" / "data.csv"
            download.write_bytes(b"a,b\n1,2\n")
            session.downloaded_files.append(str(download))

            asyncio.run(recorder.capture(session))

            kinds = [item["kind"] for item in meta["artifacts"]]
            self.assertIn("html", kinds)
            self.assertIn("markdown", kinds)
            self.assertIn("download", kinds)
            self.assertNotIn("screenshot", kinds)
            self.assertTrue(any("screenshot failed" in warning for warning in meta["warnings"]))


class LinkExtractionTests(unittest.TestCase):
    def test_preserves_link_variants_and_reports_explicit_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            out_dir = Path(temporary)
            html = (
                "<title>Links</title>"
                "<a href='/single?x=1&amp;y=2'>single</a>"
                '<a href="double">double</a>'
                "<a href=unquoted>unquoted</a>"
                "<a href='mailto:no@example.test'>mail</a>"
                + "".join(f"<a href='/n/{index}'>n</a>" for index in range(5_002))
            )
            parser = ContentParser("https://example.test/base/")
            parser.feed(html)
            meta = {
                "finalUrl": "https://example.test/base/",
                "title": "",
                "warnings": [],
            }
            write_page(out_dir, html, parser.markdown, meta, links_complete=True)

            self.assertEqual(meta["links"][0]["href"], "https://example.test/single?x=1&y=2")
            self.assertEqual(meta["links"][1]["href"], "https://example.test/base/double")
            self.assertEqual(meta["links"][2]["href"], "https://example.test/base/unquoted")
            self.assertEqual(len(meta["links"]), 5_005)
            self.assertEqual(meta["linksTotal"], 5_005)
            self.assertTrue(meta["linksComplete"])

    def test_non_page_metadata_does_not_claim_link_completeness(self) -> None:
        meta = empty_meta("https://example.test/file.pdf", "http")
        self.assertNotIn("linksTotal", meta)
        self.assertNotIn("linksComplete", meta)

    def test_python_fetch_paths_keep_error_pages_but_not_complete_links(self) -> None:
        html = b'<html><title>Denied</title><a href="/help">help</a></html>'
        headers = Message()
        headers["Content-Type"] = "text/html; charset=utf-8"
        for status in (403, 404, 429):
            with self.subTest(engine="http", status=status), tempfile.TemporaryDirectory() as temporary:
                error = HTTPError(
                    f"https://example.test/{status}", status, "error", headers, io.BytesIO(html)
                )
                with patch.object(fetch_page, "robots_allows", return_value=(True, None)), patch.object(
                    fetch_page, "urlopen", side_effect=error
                ):
                    meta, saved = fetch_page.http_fetch(
                        f"https://example.test/{status}", Path(temporary), 1
                    )
                self._assert_error_page(meta, saved, status)

            result = SimpleNamespace(
                status_code=status,
                redirected_status_code=None,
                url=f"https://example.test/{status}",
                redirected_url=None,
                response_headers={"content-type": "text/html"},
                html=html.decode(),
                markdown="Denied\n\nhelp\n",
                metadata={"title": "Denied"},
                success=False,
                error_message=f"HTTP {status}",
            )

            class Config:
                def __init__(self, **_kwargs):
                    pass

            class FakeCrawler:
                def __init__(self, **_kwargs):
                    pass

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_args):
                    return None

                async def arun(self, **_kwargs):
                    return result

            modules = {
                "crawl4ai": types.SimpleNamespace(
                    AsyncWebCrawler=FakeCrawler, BrowserConfig=Config, CrawlerRunConfig=Config
                ),
                "crawl4ai.content_filter_strategy": types.SimpleNamespace(
                    PruningContentFilter=Config
                ),
                "crawl4ai.markdown_generation_strategy": types.SimpleNamespace(
                    DefaultMarkdownGenerator=Config
                ),
            }
            with self.subTest(engine="crawl4ai", status=status), tempfile.TemporaryDirectory() as temporary, patch.dict(
                sys.modules, modules
            ):
                meta, saved = asyncio.run(
                    fetch_page.crawl_fetch(
                        f"https://example.test/{status}", Path(temporary), 1
                    )
                )
                self._assert_error_page(meta, saved, status)

    def _assert_error_page(self, meta: dict, saved: bool, status: int) -> None:
        self.assertTrue(saved)
        self.assertEqual(meta["error"], f"HTTP {status}")
        self.assertFalse(meta["linksComplete"])
        self.assertEqual(meta["linksTotal"], 1)
        self.assertTrue(Path(meta["htmlPath"]).is_file())
        self.assertTrue(Path(meta["markdownPath"]).is_file())


if __name__ == "__main__":
    unittest.main()
