import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HISTORY_DEPTH, layoutPrompt, PROMPT_SECTION_ORDER, validateHistoryDepth,
	type PromptSectionV1 } from "../src/m07/prompt-layout.ts";

const section = (key: string, kind: PromptSectionV1["kind"], text = key): PromptSectionV1 =>
	({ key, kind, text });

test("the layout is static to dynamic, and history keeps the caller's own order", () => {
	const mixed: PromptSectionV1[] = [section("round", "dynamic"), section("h1", "history"),
		section("rules", "instruction"), section("cards", "knowledge"), section("chip", "hardware"),
		section("h2", "history"), section("known", "understanding")];
	const laid = layoutPrompt(mixed, { historyDepth: 4 });
	assert.deepEqual(laid.receipt.sections.map(item => item.key),
		["rules", "known", "chip", "cards", "h1", "h2", "round"],
		"the task's own understanding sits right after the instructions; within history the caller's order is kept");
	assert.deepEqual(PROMPT_SECTION_ORDER,
		["instruction", "understanding", "hardware", "knowledge", "history", "dynamic"]);
	const sameSectionsOtherOrder = layoutPrompt([mixed[2], mixed[6], mixed[4], mixed[1], mixed[5], mixed[3], mixed[0]],
		{ historyDepth: 4 });
	assert.equal(sameSectionsOtherOrder.text, laid.text, "the same sections always produce the same bytes");
});

test("history depth bounds the carried history from the newest end and records what was dropped", () => {
	const sections = [section("rules", "instruction"),
		...["h1", "h2", "h3", "h4", "h5"].map(key => section(key, "history")),
		section("round", "dynamic")];
	const deep = layoutPrompt(sections, { historyDepth: 2 });
	assert.deepEqual(deep.receipt.sections.map(item => item.key), ["rules", "h4", "h5", "round"],
		"the most recent rounds survive");
	assert.equal(deep.receipt.historyIncluded, 2);
	assert.equal(deep.receipt.historyOmitted, 3);
	const none = layoutPrompt(sections, { historyDepth: 0 });
	assert.equal(none.receipt.historyIncluded, 0);
	assert.equal(none.receipt.historyOmitted, 5);
	assert.ok(!none.text.includes("h5"));
	const all = layoutPrompt(sections, { historyDepth: 50 });
	assert.equal(all.receipt.historyOmitted, 0);
});

test("the receipt records what each section cost so a depth scan has numbers to read", () => {
	const laid = layoutPrompt([section("rules", "instruction", "12345"),
		section("h1", "history", "abc"), section("round", "dynamic", "xy")], { historyDepth: 1 });
	assert.deepEqual(laid.receipt.sections.map(item => [item.key, item.chars]),
		[["rules", 5], ["h1", 3], ["round", 2]]);
	assert.equal(laid.receipt.totalChars, laid.text.length);
	assert.equal(laid.receipt.historyDepth, 1);
	assert.equal(laid.receipt.kind, "m07-prompt-layout");
});

test("an empty section never reaches the prompt, and the depth knob is validated", () => {
	const laid = layoutPrompt([section("rules", "instruction", "   "), section("round", "dynamic", "work")],
		{ historyDepth: DEFAULT_HISTORY_DEPTH });
	assert.deepEqual(laid.receipt.sections.map(item => item.key), ["round"]);
	assert.equal(validateHistoryDepth(undefined), DEFAULT_HISTORY_DEPTH);
	assert.equal(validateHistoryDepth(0), 0);
	assert.throws(() => validateHistoryDepth(-1), /historyDepth/);
	assert.throws(() => validateHistoryDepth(1.5), /historyDepth/);
	assert.throws(() => validateHistoryDepth("4"), /historyDepth/);
});
