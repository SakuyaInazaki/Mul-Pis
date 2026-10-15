/** Offline validation for browser-use artifacts. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";


import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";


const execFileAsync = promisify(execFile);

describe("browser artifacts", () => {

	it("captures changed same-URL states and links without network access", async () => {
		// This fixture uses only the standard library; a clean CI checkout has no project .venv.
		const python = process.env.PYTHON ?? "python3";
		const testFile = path.resolve("tools/py/test_browser_artifacts.py");
		const { stdout, stderr } = await execFileAsync(python, ["-I", testFile], { cwd: path.resolve(".") });
		const count = `${stdout}${stderr}`.match(/Ran (\d+) tests/);
		assert.ok(count && Number(count[1]) >= 9, "all browser lifecycle/artifact regressions execute");
		assert.match(`${stdout}${stderr}`, /OK/);
	});


});
