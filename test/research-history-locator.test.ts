import assert from "node:assert/strict";
import test from "node:test";
import { locateHistoryEntries, type HistoryPartByteSpan } from "../src/runner/research-history-locator.ts";

function spans(length: number, cuts: number[]): HistoryPartByteSpan[] {
	const boundaries = [0, ...cuts, length];
	return boundaries.slice(1).map((endByte, index) => ({ startByte: boundaries[index]!, endByte }));
}

test("locates every top-level entry and its file names without nested quoted fake IDs", () => {
	const history = { version: 1, kind: "untrusted-version-bound-research-history",
		metadata: { entries: [{ goalRunId: "FAKE", taskId: "T999" }],
			text: '"entries":[{"goalRunId":"FAKE"}]' }, entries: [
		{ goalRunId: "R001", taskId: "T001", files: { "candidate.cpp": "quoted \\\"goalRunId\\\":\\\"FAKE\\\"" },
			nested: { goalRunId: "FAKE", taskId: "T999" } },
		{ taskId: "T002", files: { "雪.txt": "second", "report.json": "{}" } },
		{ goalRunId: "bad\nidentity", taskId: "T003", files: {} },
	] };
	const rendered = Buffer.from(`${JSON.stringify(history, null, 2)}\n`, "utf8");
	const located = locateHistoryEntries(rendered, spans(rendered.length, []));
	assert.equal(located.length, history.entries.length);
	assert.deepEqual(located.map(item => item.entryOrdinal), [0, 1, 2]);
	assert.deepEqual(located.map(item => item.goalRunId), ["R001", undefined, undefined]);
	assert.deepEqual(located.map(item => item.taskId), ["T001", "T002", "T003"]);
	assert.deepEqual(located.map(item => item.fileNames), [["candidate.cpp"], ["雪.txt", "report.json"], []]);
	for (const item of located) {
		assert.deepEqual(JSON.parse(rendered.subarray(item.startByte, item.endByte).toString("utf8")),
			history.entries[item.entryOrdinal]);
		assert.equal(item.parts.length, 1);
		assert.equal(item.parts[0]!.startByte, item.startByte);
		assert.equal(item.parts[0]!.endByte, item.endByte);
	}
});

test("ranges cover an entry across parts, including a cut inside a UTF-8 character", () => {
	const entries = [
		{ goalRunId: "R001", taskId: "T001", files: { "a.txt": "雪".repeat(50) } },
		{ goalRunId: "R002", taskId: "T002", files: { "b.txt": "later" } },
	];
	const rendered = Buffer.from(`${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
	const character = rendered.indexOf(Buffer.from("雪", "utf8"));
	assert.ok(character > 0);
	const partSpans = spans(rendered.length, [character + 1, character + 15, rendered.length - 8]);
	const located = locateHistoryEntries(rendered, partSpans);
	assert.equal(located.length, 2);
	assert.deepEqual(located[0]!.parts.map(range => range.partIndex), [0, 1, 2]);
	for (const item of located) {
		const reconstructed = Buffer.concat(item.parts.map(range => {
			const part = partSpans[range.partIndex]!;
			assert.ok(range.startByte >= 0 && range.endByte <= part.endByte - part.startByte);
			const contents = rendered.subarray(part.startByte, part.endByte);
			const startLine = 1 + contents.subarray(0, range.startByte).filter(byte => byte === 0x0a).length;
			const endLine = 1 + contents.subarray(0, range.endByte - 1).filter(byte => byte === 0x0a).length;
			assert.deepEqual([range.startLine, range.endLine], [startLine, endLine]);
			return contents.subarray(range.startByte, range.endByte);
		})) ;
		assert.deepEqual(reconstructed, rendered.subarray(item.startByte, item.endByte));
		assert.deepEqual(JSON.parse(reconstructed.toString("utf8")), entries[item.entryOrdinal]);
	}
});

test("no entries are missed when an entry starts at a part edge", () => {
	const entries = Array.from({ length: 25 }, (_, index) => ({ goalRunId: `R${index}`, taskId: `T${String(index).padStart(3, "0")}`,
		files: { [`file-${index}.txt`]: "a,b}[]:\"".repeat(index) } }));
	const rendered = Buffer.from(JSON.stringify({ entries }), "utf8");
	const onePart = locateHistoryEntries(rendered, spans(rendered.length, []));
	const cut = onePart[10]!.startByte;
	const manyParts = locateHistoryEntries(rendered, spans(rendered.length, [cut]));
	assert.equal(manyParts.length, entries.length);
	assert.equal(manyParts[10]!.parts[0]!.partIndex, 1);
	for (let index = 0; index < entries.length; index++) {
		assert.deepEqual([manyParts[index]!.startByte, manyParts[index]!.endByte],
			[onePart[index]!.startByte, onePart[index]!.endByte]);
	}
});

test("rejects malformed JSON and invalid part coverage", () => {
	const valid = Buffer.from('{"entries":[{"taskId":"T001"}]}', "utf8");
	for (const malformed of [
		'{"entries":[{"taskId":"T001",}]}',
		'{"entries":[{"taskId":"T001"}]',
		'{"entries":[{"files":{"x":"\\q"}}]}',
		'{"entries":[],"entries":[]}',
		'{"entries":"fake"}',
	]) {
		const bytes = Buffer.from(malformed, "utf8");
		assert.throws(() => locateHistoryEntries(bytes, spans(bytes.length, [])));
	}
	assert.throws(() => locateHistoryEntries(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
		spans(7, [])));
	for (const badSpans of [
		[{ startByte: 0, endByte: valid.length - 1 }],
		[{ startByte: 1, endByte: valid.length }],
		[{ startByte: 0, endByte: valid.length + 1 }],
		[{ startByte: 0, endByte: 5 }, { startByte: 6, endByte: valid.length }],
		[{ startByte: 0, endByte: 0 }, { startByte: 0, endByte: valid.length }],
	]) assert.throws(() => locateHistoryEntries(valid, badSpans));
});
