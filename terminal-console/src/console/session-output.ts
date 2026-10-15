import { constants } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function clean(input: string): string {
  let output = "", state: "plain" | "escape" | "csi" | "osc" | "osc-escape" | "string" | "string-escape" = "plain";
  for (const char of input) {
    const code = char.charCodeAt(0);
    switch (state) {
      case "plain":
        if (code === 27) { state = "escape"; break; }
        if (/^[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]$/u.test(char)) break;
        output += char; break;
      case "escape":
        if (char === "[") state = "csi";
        else if (char === "]") state = "osc";
        else if (["P", "X", "^", "_"].includes(char)) state = "string";
        else state = code === 27 ? "escape" : "plain";
        break;
      case "csi": state = code >= 0x40 && code <= 0x7e ? "plain" : code === 27 ? "escape" : "csi"; break;
      case "osc": state = code === 7 ? "plain" : code === 27 ? "osc-escape" : "osc"; break;
      case "osc-escape": state = char === "\\" ? "plain" : code === 27 ? "osc-escape" : "osc"; break;
      case "string": state = code === 27 ? "string-escape" : "string"; break;
      case "string-escape": state = char === "\\" ? "plain" : code === 27 ? "string-escape" : "string"; break;
    }
  }
  return output;
}

function visibleMessage(row: unknown): string | undefined {
  const record = object(row);
  const message = object(record?.message) ?? record;
  if (!message || (message.role !== "assistant" && message.role !== "toolResult")) return undefined;
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = parts.flatMap(part => {
    const item = object(part);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  });
  // An older typed-message shape stores one visible text block directly on the message.
  if (message.type === "text" && typeof message.text === "string") text.push(message.text);
  if (!text.length) return undefined;
  return clean(text.join("\n"));
}

async function registered(root: string, workspaceAlias: string, actual: string): Promise<boolean> {
  for (let stage = 1; stage <= 9; stage++) {
    const stageDir = path.join(root, "stages", `M${String(stage).padStart(2, "0")}`);
    for (const entry of await readdir(stageDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const runDir = path.join(stageDir, entry.name);
      for (const recordName of ["run.json", ...(stage === 7 ? ["goal.json"] : [])]) {
        const recordPath = path.join(runDir, recordName);
        let record: Record<string, unknown> | undefined;
        try {
          const canonical = await realpath(recordPath);
          if (!inside(root, canonical) || (await stat(canonical)).size > MAX_RECORD_BYTES) continue;
          record = object(JSON.parse(await readFile(canonical, "utf8")));
        } catch { continue; }
        const refs: unknown[] = [];
        if (Array.isArray(record?.sessions)) refs.push(...record.sessions);
        if (Array.isArray(record?.tasks)) for (const task of record.tasks) {
          const session = object(task)?.session;
          if (session) refs.push(session);
        }
        for (const ref of refs) {
          const file = object(ref)?.file;
          if (typeof file !== "string") continue;
          const candidate = path.resolve(workspaceAlias, file);
          try {
            const canonical = await realpath(candidate);
            if (inside(root, canonical) && canonical === actual) return true;
          } catch { /* stale registration */ }
        }
      }
    }
  }
  return false;
}

/** Opens registered Pi session output on demand and returns only visible assistant/tool text. */
export class VisibleSessionReader {
  readonly workspace: string;
  constructor(workspace: string) { this.workspace = path.resolve(workspace); }

  async read(file: string): Promise<string[]> {
    const root = await realpath(this.workspace);
    const requested = path.resolve(this.workspace, file);
    const actual = await realpath(requested);
    if (!inside(root, actual)) throw new Error(`Session path resolves outside workspace: ${file} → ${actual}`);
    if (path.extname(actual).toLowerCase() !== ".jsonl") throw new Error(`Expected a registered session JSONL file: ${actual}`);
    if (!await registered(root, this.workspace, actual)) throw new Error(`Session file is not registered in this workspace: ${actual}`);

    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new Error(`Session path is not a regular file: ${actual}`);
      if (details.size > MAX_SESSION_BYTES) throw new Error(`Session JSONL exceeds ${MAX_SESSION_BYTES} byte limit: ${actual}`);
      const output: string[] = [];
      const chunk = Buffer.alloc(64 * 1024);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let position = 0, lineBytes: number[] = [], lineNumber = 0;
      const acceptLine = (): void => {
        lineNumber++;
        if (!lineBytes.length) return;
        let raw: string;
        try { raw = decoder.decode(Uint8Array.from(lineBytes)); }
        catch { throw new Error(`Invalid UTF-8 in session JSONL line ${lineNumber}: ${actual}`); }
        lineBytes = [];
        if (!raw.trim()) return;
        let row: unknown;
        try { row = JSON.parse(raw); }
        catch { throw new Error(`Invalid session JSONL line ${lineNumber}: ${actual}`); }
        const visible = visibleMessage(row);
        if (visible !== undefined) output.push(visible);
      };
      while (position < details.size) {
        const count = Math.min(chunk.length, details.size - position);
        const { bytesRead } = await handle.read(chunk, 0, count, position);
        if (!bytesRead) throw new Error(`Session changed while reading: ${actual}`);
        for (let i = 0; i < bytesRead; i++) {
          if (chunk[i] === 10) acceptLine();
          else {
            lineBytes.push(chunk[i]!);
            if (lineBytes.length > MAX_LINE_BYTES) throw new Error(`Session JSONL line exceeds ${MAX_LINE_BYTES} byte limit: ${actual}`);
          }
        }
        position += bytesRead;
      }
      if (lineBytes.length) acceptLine();
      const after = await handle.stat();
      if (after.size !== details.size || after.mtimeMs !== details.mtimeMs) throw new Error(`Session changed while reading: ${actual}`);
      return output;
    } finally { await handle.close(); }
  }
}
