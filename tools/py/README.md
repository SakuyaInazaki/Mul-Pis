# M05 external knowledge acquisition tools

This directory contains small command-line adapters for the M05 acquisition tools. Run `scripts/setup-tools.sh` from anywhere inside or outside the repository; it creates the repository `.venv`, installs the Python packages and Playwright Chromium, and writes exact installed versions to `.venv-tools.json`.

## Commands

- `fetch_page.py URL --out DIR [--timeout SECONDS] [--no-browser]` uses headless Chromium through Crawl4AI and prefers its main-content/fit Markdown. It writes `page.md`, `page.html`, and `meta.json`. Non-HTML responses are saved as `download.<ext>`. `--no-browser`, Crawl4AI import failure, or browser failure uses a dependency-free HTTP and minimal HTML-to-text fallback.
- PDFs are not handled in Python any more. The harness calls poppler directly (`src/tools/pdf.ts`): `pdftotext -layout` for the text layer and `pdftoppm -png` to render single pages on demand for a multimodal model. No local ML model is installed or downloaded (Docling was removed at the user's request).
- `browser_task.py --url URL --task TEXT --out DIR --model provider/model` is the interactive adapter for tasks that benefit from navigation, expansion, pagination, or downloads. It supports `openai/...` and `anthropic/...` through browser-use model classes and requires `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Missing credentials exit with status 3 before importing or calling an LLM. Each invocation creates a fresh headless browser session; existing user profiles, login state, and credential management are not wired in.

No adapter attempts to bypass robots blocks, authentication, paywalls, or other access controls.

## JSON contracts

`fetch_page.py` always writes every key in this object and prints the compact object as its final stdout line:

```json
{"url":"","finalUrl":"","status":null,"title":"","fetchedAt":"ISO UTC","engine":"crawl4ai|http","kind":"page|file","contentType":"","bytes":0,"markdownPath":"","htmlPath":"","filePath":"","links":[{"text":"","href":""}],"warnings":[],"error":null}
```

`browser_task.py` writes `meta.json` incrementally. The browser model's `result.md` is a report and is kept separate from registerable source artifacts:

```json
{"url":"","task":"","model":"provider/model","finishedAt":"ISO UTC","steps":null,"artifacts":[{"path":"pages/page-001.html","kind":"html","url":"","title":"","capturedAt":"ISO UTC","contentType":"text/html"}],"visitedUrls":[],"warnings":[],"error":null}
```

Content acquisition exits 0 when content is saved and 2 when no content is obtained. Browser configuration errors exit 3.

## Installed and verified versions

`scripts/setup-tools.sh` was run on 2026-09-20 from a network-enabled shell (an earlier attempt inside a DNS-restricted sandbox could not install anything). A first build had included Docling; it was removed the same day because the user does not want local ML models, and the venv was rebuilt with only Crawl4AI, browser-use and Playwright. `.venv-tools.json` records the exact versions after the rebuild. The venv is ignored by Git. Only Chromium headless shells are kept under `.venv/ms-playwright` (full Chromium builds are deleted by the setup script; Crawl4AI was verified to work with the shells alone). The venv is about 1.1 GB, of which the browsers are about 0.4 GB.

Known limitations: minimal HTTP conversion preserves readable text but not full Markdown structure; JavaScript-only pages need Crawl4AI; `pdftotext` cannot OCR image-only PDFs, so scanned pages must be rendered with `render_pdf_page` and read by a multimodal model; browser-use consumes the selected provider's API. During one live browser session it records changed DOM/text states, screenshots, visited URLs, and downloads after steps, saving metadata atomically so partial results survive failures. Capture is bounded to 20 page states, 12 screenshots, 5 MB HTML, 2 MB page text, and 250 MB of downloads registered as material; the last value is not a hard browser disk-write quota. Limit warnings mean coverage must not be described as complete. Search providers are plain HTTP calls from the harness (`src/tools/search.ts`); no local search service is used. DuckDuckGo HTML continuation is not reliably implemented as an API call and may require browser pagination.

Verification performed on 2026-09-20 after installation:

- Shell syntax passed for all three scripts; all Python adapters compiled.
- `fetch_page.py` through the harness adapter (`src/tools/fetch.ts`): `https://example.com/` → engine `crawl4ai`, HTTP 200, `page.md` with the page text and 1 link; `https://arxiv.org/abs/2609.20519` → engine `crawl4ai`, HTTP 200, title and 76 links extracted, no warnings.
- `browser_task.py --help` passed. An OpenAI invocation with an empty `OPENAI_API_KEY` wrote `meta.json` and exited 3 without importing browser-use or calling an API.
- PDF path (TypeScript, poppler): `extractPdf` on `resources/2609.11873v1.pdf` with `maxPages: 1` reports engine `pdftotext`, 75 pages, truncated; `renderPdfPage` renders `pages/2609.11873v1-p001.png` and reuses it on repeat; covered by `test/pdf-pages.test.ts`.
