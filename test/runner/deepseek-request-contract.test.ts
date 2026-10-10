import assert from "node:assert/strict";
import test from "node:test";
import { assertDeepSeekRequestContract, DeepSeekRequestContractError, type DeepSeekRequestViolation } from "../../src/runner/deepseek-request-contract.ts";

const secret = "PRIVATE prompt reasoning key tool-id";
const call = (id = "call_1") => ({ id, type: "function", function: { name: "read", arguments: "{}" } });
const assistant = (ids = ["call_1"]) => ({ role: "assistant", content: null, reasoning_content: secret, tool_calls: ids.map(call) });
const result = (id = "call_1") => ({ role: "tool", tool_call_id: id, content: secret });
const user = { role: "user", content: secret };
const request = (messages: unknown[], extra = {}) => ({ model: "deepseek-flash", thinking: { type: "enabled" }, tools: [], messages, ...extra });
const source = [{ role: "assistant", content: [{ type: "thinking", thinking: secret, thinkingSignature: "reasoning_content" }] }];

function invalid(payload: unknown, expected: DeepSeekRequestViolation, sourceMessages?: unknown[]): void {
	assert.throws(() => assertDeepSeekRequestContract(JSON.stringify(payload), { sourceMessages }), error => {
		assert.ok(error instanceof DeepSeekRequestContractError);
		assert.equal(error.violation, expected);
		assert.equal(error.issued, false);
		assert.equal(error.code, "runner.deepseek-request-contract");
		assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE|prompt reasoning key tool-id/);
		return true;
	});
}

test("valid thinking history is byte-for-byte unchanged and permits null assistant content", () => {
	const payload = request([user, assistant(), result(), user]);
	const before = JSON.stringify(payload);
	assertDeepSeekRequestContract(before, { sourceMessages: source });
	assert.equal(JSON.stringify(payload), before);
});

test("parallel tool results may return in a different order", () => {
	assertDeepSeekRequestContract(JSON.stringify(request([user, assistant(["a", "b"]), result("b"), result("a")])));
});

test("duplicate, orphan, missing and interrupted tool graphs are rejected without content", () => {
	invalid(request([user, assistant([secret, secret])]), "duplicate-tool-call");
	invalid(request([user, result(secret)]), "orphan-tool-result");
	invalid(request([user, assistant(), result(), result()]), "duplicate-tool-result");
	invalid(request([user, assistant()]), "incomplete-tool-results");
	invalid(request([user, assistant(), user, result()]), "incomplete-tool-results");
	invalid(request([user, assistant(), result(), assistant()]), "duplicate-tool-call");
});

test("thinking rejects forced tool choice but accepts auto/none and non-thinking required", () => {
	invalid(request([user], { tool_choice: "required" }), "thinking-tool-choice");
	invalid(request([user], { tool_choice: { type: "function", function: { name: secret } } }), "thinking-tool-choice");
	for (const tool_choice of ["auto", "none"]) assertDeepSeekRequestContract(JSON.stringify(request([user], { tool_choice })));
	assertDeepSeekRequestContract(JSON.stringify(request([user], { thinking: { type: "disabled" }, tool_choice: "required" })));
	invalid({ messages: [user], tools: [], tool_choice: "required" }, "thinking-tool-choice");
});

test("missing, unsigned or lost reasoning is refused rather than fabricated", () => {
	const missing = { ...assistant(), reasoning_content: undefined };
	invalid(request([user, missing, result()]), "missing-reasoning");
	invalid(request([user, assistant(), result()]), "unsigned-reasoning", [{ role: "assistant", content: [{ type: "thinking", thinking: secret }] }]);
	invalid(request([user, { ...assistant(), reasoning_content: "" }, result()]), "reasoning-replay-mismatch", source);
	assertDeepSeekRequestContract(JSON.stringify({ messages: [user, { role: "assistant", content: "ok" }] }));
});

test("invalid serialized shape and roles produce static diagnostics", () => {
	assert.throws(() => assertDeepSeekRequestContract("PRIVATE not JSON"), DeepSeekRequestContractError);
	invalid(request([]), "request-shape");
	invalid(request([{ role: secret, content: secret }]), "message-shape");
	invalid(request([user, { ...assistant(), tool_calls: [{ id: secret }] }]), "tool-call-shape");
});
