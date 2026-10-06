"""Offline lifecycle checks for the browser-use step adapter."""
import asyncio
import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from browser_task import run_until_done
import browser_artifacts


class History:
    def __init__(self, agent):
        self.agent = agent
        self.usage = None

    def is_done(self):
        return self.agent.steps >= self.agent.finish_at


class Browser:
    def __init__(self):
        self.starts = 0

    async def start(self):
        self.starts += 1


class Usage:
    async def get_usage_summary(self):
        return {"tokens": 7}


class Events:
    def __init__(self):
        self.stops = 0

    async def stop(self, **_kwargs):
        self.stops += 1


class Agent:
    def __init__(self, finish_at=1, error=None):
        self.finish_at = finish_at
        self.error = error
        self.steps = 0
        self.state = type("State", (), {"stopped": False})()
        self.history = History(self)
        self.token_cost_service = Usage()
        self.eventbus = Events()
        self.logged = 0
        self.skills = 0
        self.initial_actions = 0
        self.closes = 0

    async def _register_skills_as_actions(self):
        self.skills += 1

    async def _log_agent_run(self):
        self.logged += 1

    async def _execute_initial_actions(self):
        self.initial_actions += 1

    async def step(self):
        if self.error:
            raise self.error
        self.steps += 1

    async def close(self):
        self.closes += 1


class BrowserStepAdapterTest(unittest.IsolatedAsyncioTestCase):
    async def test_more_than_sdk_run_default_steps_and_full_lifecycle(self):
        agent, browser = Agent(501), Browser()
        captures = []
        result = await run_until_done(agent, browser, lambda a: self.capture(captures, a))
        self.assertIs(result, agent.history)
        self.assertEqual(agent.steps, 501)
        self.assertEqual(len(captures), 501)
        self.assertEqual((agent.logged, browser.starts, agent.skills, agent.initial_actions, agent.eventbus.stops, agent.closes), (1, 1, 1, 1, 1, 1))
        self.assertEqual(result.usage, {"tokens": 7})

    async def capture(self, captures, agent):
        captures.append(agent.steps)

    async def test_failure_and_cancel_close_browser(self):
        for error in (RuntimeError("provider failed"), asyncio.CancelledError()):
            agent, browser = Agent(error=error), Browser()
            with self.assertRaises(type(error)):
                await run_until_done(agent, browser, lambda a: self.capture([], a))
            self.assertEqual((browser.starts, agent.eventbus.stops, agent.closes), (1, 1, 1))

    async def test_incompatible_sdk_fails_before_start(self):
        agent, browser = Agent(), Browser()
        agent.step = None
        with self.assertRaisesRegex(RuntimeError, "step adapter unavailable"):
            await run_until_done(agent, browser, lambda a: self.capture([], a))
        self.assertEqual(browser.starts, 0)

    async def test_artifact_capture_has_no_page_or_screenshot_count_stop(self):
        class Page:
            def __init__(self, index):
                self.index = index

            async def get_url(self):
                return f"https://example.invalid/{self.index}"

            async def get_title(self):
                return "page"

            async def evaluate(self, script):
                return f"<body>{self.index}</body>" if "outerHTML" in script else f"text {self.index}"

            async def screenshot(self):
                return base64.b64encode(b"png").decode()

        class Session:
            downloaded_files = []

            def __init__(self):
                self.index = 0

            async def get_current_page(self):
                self.index += 1
                return Page(self.index)

        with tempfile.TemporaryDirectory() as tmp:
            meta = {"artifacts": [], "visitedUrls": [], "warnings": []}
            recorder = browser_artifacts.ArtifactRecorder(Path(tmp), meta)
            session = Session()
            for _ in range(25):
                await recorder.capture(session)
            self.assertEqual(len([item for item in meta["artifacts"] if item["kind"] == "html"]), 25)
            self.assertEqual(len([item for item in meta["artifacts"] if item["kind"] == "markdown"]), 25)
            self.assertEqual(len([item for item in meta["artifacts"] if item["kind"] == "screenshot"]), 25)
            self.assertFalse(any("limit reached" in warning for warning in meta["warnings"]))

            with patch.object(browser_artifacts, "MAX_SCREENSHOT_BYTES", 1):
                await recorder.capture(session)
            self.assertTrue(any("Screenshot capture limit reached" in warning for warning in meta["warnings"]))


if __name__ == "__main__":
    unittest.main()
