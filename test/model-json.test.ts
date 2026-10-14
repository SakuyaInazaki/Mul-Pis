import assert from "node:assert/strict";
import test from "node:test";
import { parseModelJson } from "../src/improvement/model-json.ts";

test("one JSON document follows a complete TypeScript example", () => {
 const answer = ["Explanation", "```ts", "const example = { source: 'M07' };", "```", "",
  "```json", '{"claim":"source observation"}', "```"].join("\n");
 assert.deepEqual(parseModelJson(answer), { claim: "source observation" });
 assert.deepEqual(parseModelJson('{"claim":"raw JSON"}'), { claim: "raw JSON" });
});

test("multiple, missing, and unfinished JSON fences remain rejected", () => {
 assert.throws(() => parseModelJson('```json\n{"a":1}\n```\n```json\n{"b":2}\n```'), /one complete/);
 assert.throws(() => parseModelJson('```ts\nconst example = 1;\n```'), /one complete/);
 assert.throws(() => parseModelJson('```json\n{"a":1}'), /one complete/);
 assert.throws(() => parseModelJson('```json\n{"a":1}\n```\n```ts\nconst unclosed = 1;'), /one complete/);
 assert.throws(() => parseModelJson('```json\n{"a":1}\n```\n\n{"b":2}'), /ambiguous second JSON/);
});

test("shorter nested fences inside a four-backtick example are not extracted", () => {
 const example = ['````ts', '```json', '{"notTheAnswer":true}', '```', '````'].join("\n");
 assert.throws(() => parseModelJson(example), /one complete/);
 assert.deepEqual(parseModelJson(`${example}\n\n\`\`\`json\n{"answer":true}\n\`\`\``), { answer: true });
 assert.deepEqual(parseModelJson('```ts\n\n{}\n\n```\n\n```json\n{"answer":true}\n```'), { answer: true });
});
