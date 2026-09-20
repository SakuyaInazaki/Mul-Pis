#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$REPO_ROOT/.venv"
PYTHON_BIN="$VENV_DIR/bin/python"
export UV_CACHE_DIR="${TMPDIR:-/tmp}/pre-rsi-uv-cache"
export PLAYWRIGHT_BROWSERS_PATH="$VENV_DIR/ms-playwright"

cd "$REPO_ROOT"

if [[ ! -x "$PYTHON_BIN" ]]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 .venv
  elif command -v python3.12 >/dev/null 2>&1; then
    python3.12 -m venv .venv
  elif [[ -x /opt/homebrew/bin/python3.12 ]]; then
    /opt/homebrew/bin/python3.12 -m venv .venv
  else
    echo "error: Python 3.12 is required (looked for uv, python3.12, and /opt/homebrew/bin/python3.12)" >&2
    exit 1
  fi
fi

PYTHON_MINOR="$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "$PYTHON_MINOR" != "3.12" ]]; then
  echo "error: existing .venv uses Python $PYTHON_MINOR; expected 3.12" >&2
  echo "Move or remove .venv, then rerun this script." >&2
  exit 1
fi

if command -v uv >/dev/null 2>&1; then
  uv pip install --python "$PYTHON_BIN" crawl4ai browser-use playwright
else
  "$PYTHON_BIN" -m pip install --upgrade pip
  "$PYTHON_BIN" -m pip install crawl4ai browser-use playwright
fi

if [[ -x "$VENV_DIR/bin/crawl4ai-setup" ]]; then
  "$VENV_DIR/bin/crawl4ai-setup"
else
  echo "note: crawl4ai-setup is not provided by the installed Crawl4AI package; skipping"
fi

"$PYTHON_BIN" -m playwright install chromium --only-shell

# Keep the venv small: headless runs only need chromium_headless_shell. Full Chromium builds
# (installed by crawl4ai-setup/patchright) are removed; restore one with
#   .venv/bin/python -m playwright install chromium
# if a headed browser is ever required.
find "$PLAYWRIGHT_BROWSERS_PATH" -maxdepth 1 -type d -name 'chromium-[0-9]*' -exec rm -rf {} + 2>/dev/null || true

"$PYTHON_BIN" - <<'PY'
import importlib.metadata
import json
import pathlib
import platform

packages = ("crawl4ai", "browser-use", "playwright")
versions = {name: importlib.metadata.version(name) for name in packages}
versions["python"] = platform.python_version()
pathlib.Path(".venv-tools.json").write_text(
    json.dumps(versions, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
PY

echo "M05 Python tools are ready:"
"$PYTHON_BIN" - <<'PY'
import json
from pathlib import Path

for name, version in json.loads(Path(".venv-tools.json").read_text()).items():
    print(f"  {name}: {version}")
print("  chromium: installed by Playwright")
PY
