/** A profile shaped like a real accelerator contract, used by the platform tests.
 * Capacities carry probe receipts because the loader refuses copied constants. */
export function probe(command: string) {
	return { command, capturedAt: "2026-10-18T09:00:00.000Z", outputPath: "/host/only/probe.txt" };
}

export function profileFixture(): Record<string, unknown> {
	return {
		version: 1,
		id: "device-a",
		chip: "Device A rev 2",
		toolchain: "Toolchain 8.3.RC1",
		capacities: {
			unified_buffer_bytes: { value: 196_352, unit: "byte", probe: probe("device-query --unified-buffer-bytes") },
		},
		editableSurface: {
			allow: ["^kernel/[^/]+\\.cpp$"],
			readOnly: ["^verify/", "^host/"],
			singleFilePerTurn: true,
		},
		symbols: {
			namespaces: ["DeviceApi::"],
			names: ["DataCopy", "DataCopyPad", "SoftMax", "AllocTensor", "FreeTensor"],
			provenance: probe("extract-signatures --headers /opt/toolchain/include"),
		},
		rules: [
			{ id: "single-core-launch", kind: "forbid", pattern: "SetBlockDim\\s*\\(\\s*1\\s*\\)",
				appliesTo: "^kernel/", purpose: "performance", severity: "reject",
				message: "the launch runs on one core", suggest: "set the block dimension from the probed core count" },
			{ id: "high-throughput-mode", kind: "require", pattern: "SetHighThroughput\\s*\\(\\s*true\\s*\\)",
				appliesTo: "^kernel/matmul\\.cpp$", purpose: "performance", severity: "warn",
				message: "the high-throughput mode switch is absent" },
			{ id: "copy-length-alignment", kind: "forbid", pattern: "DataCopy\\([^)]*,\\s*\\d*[13579]\\s*\\)",
				appliesTo: "^kernel/", purpose: "correctness", severity: "reject",
				message: "copy length must be a multiple of the 32-byte physical block" },
			{ id: "innermost-stride-bandwidth", kind: "forbid", pattern: "// stride-unaligned",
				appliesTo: "^kernel/", purpose: "bandwidth", severity: "warn",
				message: "a non-512-byte innermost stride loses full-burst transfers" },
			{ id: "queue-balance", kind: "pairing", open: "EnQue\\s*\\(", close: "DeQue\\s*\\(",
				appliesTo: "^kernel/", purpose: "correctness", severity: "reject",
				message: "every enqueue needs its matching dequeue" },
			{ id: "tail-mask", kind: "require", pattern: "tailLength|remainder",
				appliesTo: "^kernel/", purpose: "correctness", severity: "reject",
				message: "a shape that does not divide evenly needs an explicit tail branch" },
			{ id: "buffer-budget", kind: "budget", capacity: "unified_buffer_bytes",
				allocation: "InitBuffer\\([^,]+,\\s*(\\d+)\\)", multiplier: "BUFFER_NUM\\s*=\\s*(\\d+)",
				appliesTo: "^kernel/", purpose: "correctness", severity: "reject",
				message: "the on-chip buffer allocation exceeds the probed capacity" },
			{ id: "device-launch-present", kind: "require", pattern: "EXEC_DEVICE_CMD",
				appliesTo: "^binding/", purpose: "integrity", severity: "reject",
				message: "the binding must launch the submitted kernel on the device" },
			{ id: "no-framework-fallback", kind: "forbidWithin", region: "PYBIND11_MODULE[\\s\\S]*?\\n\\}",
				pattern: "framework::", appliesTo: "^binding/", purpose: "integrity", severity: "reject",
				message: "the binding may not compute through the framework instead of the kernel" },
		],
		diagnostics: [
			{ id: "missing-symbol", pattern: "no member named '([A-Za-z_][A-Za-z0-9_]*)'", class: "syntax",
				routeSymbols: true, hint: "look the call up in the extracted API surface instead of retrying" },
			{ id: "buffer-overflow", pattern: "unified buffer overflow", class: "hardware",
				hint: "recompute the tile length against the probed capacity" },
			{ id: "device-unavailable", pattern: "device is busy or unavailable", class: "infrastructure" },
		],
		metrics: [
			{ name: "mte2_ratio", pattern: "mte2_ratio[^0-9]*([0-9.]+)" },
			{ name: "vector_ratio", pattern: "vector_ratio[^0-9]*([0-9.]+)" },
		],
		bottleneck: {
			labels: [
				{ id: "transfer", when: [{ metric: "mte2_ratio", op: ">=", value: 0.5 }],
					actions: ["alignment", "coalescing", "double-buffer", "copy-compute-overlap"] },
				{ id: "vector", when: [{ metric: "vector_ratio", op: ">=", value: 0.5 }], actions: ["vectorisation", "scalar-removal"] },
			],
		},
		timing: { protocolVersion: "device-a-timing-1", warmup: 3, repeats: 100,
			latencySource: "step_trace.csv:computing", metricSource: "kernel_details.csv", minRuntimeMs: 15 },
		precision: { dtypes: [{ name: "fp16", mantissaBits: 10 }, { name: "fp32", mantissaBits: 13 }], maxRelaxation: 10 },
		cases: {
			alignmentBytes: 512,
			table: [
				{ id: "c1", elements: 1_000_000, innermostBytes: 512, dims: 1, range: "small-symmetric" },
				{ id: "c2", elements: 4_097, innermostBytes: 1_009, dims: 2, range: "large-asymmetric" },
				{ id: "c3", elements: 30_000_000, innermostBytes: 1_537, dims: 3, range: "dtype-boundary" },
				{ id: "c4", elements: 300_000_000, innermostBytes: 1_024, dims: 5, range: "zeros-and-nan" },
				{ id: "c5", elements: 2_000_003, innermostBytes: 4_097, dims: 4, range: "small-symmetric" },
			],
		},
		deviceSerialization: { leaseFile: "/replaced/by/test", commandPattern: "device-run|device-profile", timeoutMs: 5_000 },
	};
}
