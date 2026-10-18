#!/usr/bin/env node
// Read-only inspection. A parsed export is not candidate-bound evidence until
// the trusted host freezes the original file and verifies the executed source.
import { importNcuReport, probeGpuProfilers, readProfilerCsv } from "../src/m07/candidate-performance.ts";

const [kind, filePath, basisId, rawIndex, selector, stepUnit] = process.argv.slice(2);
let selection;
if (selector?.startsWith("{")) {
  try {
    selection = JSON.parse(selector);
    if (!selection || Array.isArray(selection) || typeof selection !== "object" ||
        Object.values(selection).some(value => typeof value !== "string")) throw new Error("selectors must be strings");
  } catch {
    console.error("selector must be a JSON object of string fields");
    process.exit(2);
  }
}
if (kind === "probe") {
  console.log(JSON.stringify(await probeGpuProfilers(), null, 2));
} else if (["ncu-csv", "ncu-report", "msprof-kernel", "msprof-step"].includes(kind) &&
    filePath && basisId && /^(?:0|[1-9][0-9]*)$/.test(rawIndex ?? "")) {
  const allowed = kind.startsWith("ncu") ? ["launchId"] : kind === "msprof-kernel" ?
    ["kernelName", "taskId", "stepId"] : ["stepId", "deviceId", "unit"];
  if (selection && (Object.keys(selection).some(key => !allowed.includes(key)) ||
      kind === "msprof-step" && selection.unit !== undefined && !["ns", "us", "ms", "s"].includes(selection.unit))) {
    console.error(`unsupported ${kind} selector; allowed fields: ${allowed.join(", ")}`);
    process.exit(2);
  }
  const receiptIndex = Number(rawIndex);
  const input = { basisId, receiptIndex,
    ...(selection ?? (kind === "ncu-csv" || kind === "ncu-report" ? { launchId: selector } :
      kind === "msprof-kernel" ? { taskId: selector } : {
        ...(selector && selector !== "-" ? { stepId: selector } : {}),
        ...(stepUnit ? { unit: stepUnit } : {}) })) };
  const result = kind === "ncu-report" ? await importNcuReport(filePath, input) :
    await readProfilerCsv(kind, filePath, input);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "parsed") process.exitCode = 1;
} else {
  console.error("usage: node scripts/profile-evidence.mjs probe | <ncu-csv|ncu-report|msprof-kernel|msprof-step> <existing-file> <basis-id> <frozen-receipt-index> [selector JSON]; selectors: ncu {launchId}, kernel {kernelName,taskId,stepId}, step {stepId,deviceId,unit}. Legacy positional selectors remain accepted.");
  process.exitCode = 2;
}
