import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

/** A cursor identifies a raw byte boundary, never a count of displayed characters. */
export interface DocumentPage {
  path: string;
  offset: number;
  nextOffset?: number;
  totalBytes: number;
  /** Sanitized, newline-preserving text. Concatenate pages to reconstruct visible content. */
  text: string;
  /** Newline-terminated fragments; concatenating them reproduces text exactly. */
  lines: string[];
}

export const DOCUMENT_PAGE_BYTES = 64 * 1024;
type EscapeState = "plain" | "escape" | "csi" | "osc" | "osc-escape" | "string" | "string-escape";
interface Cursor { escape: EscapeState }
interface FileCursors { identity: string; cursors: Map<number, Cursor> }

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function typeHint(file: string, head: Buffer): string | undefined {
  if (head.subarray(0, 5).toString("ascii") === "%PDF-") return "PDF";
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "PNG";
  if (head.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "JPEG";
  if (head.subarray(0, 4).toString("ascii") === "GIF8") return "GIF";
  if (head.subarray(0, 2).equals(Buffer.from([80, 75]))) return "ZIP archive";
  if (head.subarray(0, 2).equals(Buffer.from([31, 139]))) return "gzip archive";
  if (head.subarray(0, 16).toString("ascii") === "SQLite format 3\0") return "SQLite database";
  if (head.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) return "ELF executable";
  if (head.subarray(0, 2).toString("ascii") === "MZ") return "Windows executable";
  const ext = path.extname(file).toLowerCase();
  const knownBinary: Record<string, string> = {
    ".pdf": "PDF", ".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".gif": "GIF",
    ".webp": "WebP", ".zip": "ZIP archive", ".gz": "gzip archive", ".sqlite": "SQLite database",
    ".db": "database", ".docx": "Word document", ".xlsx": "Excel workbook", ".pptx": "PowerPoint deck",
    ".mp3": "audio", ".mp4": "video", ".wav": "audio", ".wasm": "WebAssembly module",
  };
  return knownBinary[ext];
}

function safeText(text: string): string {
  return text.replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function fragments(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function appendVisible(byte: number, output: number[]): void { output.push(byte); }

function scan(byte: number, state: EscapeState, output: number[]): EscapeState {
  switch (state) {
    case "plain":
      if (byte === 0x1b) return "escape";
      appendVisible(byte, output);
      return "plain";
    case "escape":
      if (byte === 0x5b) return "csi";
      if (byte === 0x5d) return "osc";
      if ([0x50, 0x58, 0x5e, 0x5f].includes(byte)) return "string"; // DCS, SOS, PM, APC
      return byte === 0x1b ? "escape" : "plain";
    case "csi":
      if (byte >= 0x40 && byte <= 0x7e) return "plain";
      if (byte === 0x1b) return "escape";
      return "csi";
    case "osc":
      if (byte === 0x07) return "plain";
      return byte === 0x1b ? "osc-escape" : "osc";
    case "osc-escape":
      if (byte === 0x5c) return "plain";
      return byte === 0x1b ? "osc-escape" : "osc";
    case "string": return byte === 0x1b ? "string-escape" : "string";
    case "string-escape":
      if (byte === 0x5c) return "plain";
      return byte === 0x1b ? "string-escape" : "string";
  }
}

/** Reads only registered output/artifact text paths supplied by the caller. Never pass raw session files. */
export class DocumentReader {
  readonly workspace: string;
  private readonly known = new Map<string, FileCursors>();

  constructor(workspace: string) { this.workspace = path.resolve(workspace); }

  async read(file: string, offset = 0): Promise<DocumentPage> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`Invalid document offset: ${offset}`);
    const root = await realpath(this.workspace);
    const requested = path.resolve(this.workspace, file);
    // Compare canonical paths so aliases such as /var and /private/var stay readable.
    const actual = await realpath(requested);
    if (!inside(root, actual)) throw new Error(`Document path resolves outside workspace: ${file} → ${actual}`);
    if (path.extname(actual).toLowerCase() === ".jsonl") throw new Error(`Raw JSONL/session files cannot be opened as documents: ${actual}`);

    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`Document path is not a regular file: ${actual}`);
      const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      const prior = this.known.get(actual);
      const cursors = prior?.identity === identity ? prior.cursors : new Map<number, Cursor>([[0, { escape: "plain" }]]);
      this.known.set(actual, { identity, cursors });
      if (offset > stat.size) throw new RangeError(`Document offset ${offset} exceeds ${stat.size} bytes: ${actual}`);
      const cursor = cursors.get(offset);
      if (!cursor) throw new RangeError(`Invalid document page boundary ${offset}; use a returned nextOffset for ${actual}`);

      const head = Buffer.alloc(Math.min(512, stat.size));
      const headRead = head.length ? (await handle.read(head, 0, head.length, 0)).bytesRead : 0;
      if (headRead !== head.length) throw new Error(`Document changed while reading: ${actual}`);
      const hinted = typeHint(actual, head.subarray(0, headRead));
      if (hinted) throw new Error(`Cannot display ${hinted} as text: ${actual}`);
      if (head.includes(0)) throw new Error(`Cannot display binary data (NUL bytes) as text: ${actual}`);

      const output: number[] = [];
      let escape = cursor.escape;
      let position = offset;
      const end = Math.min(stat.size, offset + DOCUMENT_PAGE_BYTES);
      const block = Buffer.alloc(8192);
      while (position < end) {
        const count = Math.min(block.length, end - position);
        const { bytesRead } = await handle.read(block, 0, count, position);
        if (!bytesRead) throw new Error(`Document changed while reading: ${actual}`);
        for (let i = 0; i < bytesRead; i++) {
          if (block[i] === 0) throw new Error(`Cannot display binary data (NUL bytes) as text: ${actual}`);
          escape = scan(block[i]!, escape, output);
        }
        position += bytesRead;
      }
      // A page cannot end halfway through a UTF-8 code point. At most three bytes are needed.
      let continuation = 0;
      for (const byte of output) {
        if (continuation > 0) { continuation = (byte & 0xc0) === 0x80 ? continuation - 1 : 0; continue; }
        if (byte >= 0xc2 && byte <= 0xdf) continuation = 1;
        else if (byte >= 0xe0 && byte <= 0xef) continuation = 2;
        else if (byte >= 0xf0 && byte <= 0xf4) continuation = 3;
      }
      while (continuation > 0 && position < stat.size) {
        const one = Buffer.alloc(1);
        const { bytesRead } = await handle.read(one, 0, 1, position);
        if (!bytesRead) throw new Error(`Document changed while reading: ${actual}`);
        if (one[0] === 0 || (one[0]! & 0xc0) !== 0x80) throw new Error(`Invalid UTF-8 text at byte ${position}: ${actual}`);
        escape = scan(one[0]!, escape, output);
        continuation--;
        position++;
      }
      let decoded: string;
      try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(output)); }
      catch { throw new Error(`Invalid UTF-8 or binary content in document: ${actual}`); }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error(`Document changed while reading: ${actual}`);
      const text = safeText(decoded);
      const nextOffset = position < stat.size ? position : undefined;
      if (nextOffset !== undefined) cursors.set(nextOffset, { escape });
      return { path: actual, offset, nextOffset, totalBytes: stat.size, text, lines: fragments(text) };
    } finally { await handle.close(); }
  }
}
