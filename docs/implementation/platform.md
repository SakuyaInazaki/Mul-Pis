# Platform profiles and the execution contract

A workflow that optimises operators runs against one accelerator at a time, and almost everything that
decides whether a candidate can even compile is specific to that accelerator: the on-chip buffer size, the
alignment the hardware requires, the API surface the installed toolchain actually declares, the file layout
the build expects, the counters the profiler emits. None of that belongs in harness code. Code cannot be
checked against the machine it will run on, published constants for one chip contradict each other, and a
constraint written into a prompt is a request rather than a structure.

So the harness carries no platform knowledge at all. It loads one **platform profile**, a host-owned JSON
file, and enforces what that profile declares.

## What the harness does with a profile

`src/platform/profile.ts` parses and validates the file, `src/platform/contract.ts` evaluates its rules
against candidate source, `src/platform/diagnostics.ts` reads toolchain and profiler output mechanically,
`src/platform/device-lease.ts` serialises device access, and `src/platform/gate.ts` joins them into the gate
that `src/runner/pi.ts` installs on an execution session's file and shell tools.

With a profile bound, an execution session behaves differently in four places:

1. **Writes are checked before the bytes land.** `write` carries its full content; an `edit` is replayed
   against the current file so the contract sees the file the edit would produce. A rejected write never
   touches the work tree, so no compile and no device slot is spent on it. The rejection text names the rule,
   the file and line, the matched evidence, and — for an unknown API symbol — the declared names nearest to
   the one used.
2. **The editable surface is enforced.** Files the profile marks read-only cannot be written at all, and the
   profile may require that one round changes one file. A refused write does not consume the round.
3. **Device commands are serialised.** A shell command matching the profile's device pattern takes an
   exclusive lease first, identified by the full process identity of its holder, and releases it afterwards —
   including when the command throws. A lease whose owner is proven dead on this host and boot is reclaimed;
   an owner whose state cannot be established keeps the device.
4. **Shell output is read mechanically.** Failure classes, nearest declared signatures and one deterministic
   bottleneck label are appended *after* the original output, which is never rewritten or summarised. When the
   counters do not satisfy any label, the appended line says `inconclusive` instead of naming a bottleneck.

Every decision is appended to `<persistDir>/<sessionId>.platform.jsonl`: rejected writes with their findings,
accepted writes that carried warnings, refused second files, device leases with the time spent waiting, and
diagnoses with their classes. That file is what makes "how much device budget was never spent, and why"
answerable after a run.

## Binding a profile

The runner reads `PRE_RSI_PLATFORM_PROFILE`, an absolute path to the profile, in the harness process only.
Without it, nothing in this document applies and execution sessions behave as before. A model-facing shell is
spawned with a rebuilt environment, so a candidate can neither read the path nor repoint it, and the profile
itself lives outside the work root.

## Profile shape

```json
{
  "version": 1,
  "id": "device-a",
  "chip": "<exact chip revision>",
  "toolchain": "<exact toolchain version>",
  "capacities": {
    "unified_buffer_bytes": {
      "value": 196352, "unit": "byte",
      "probe": { "command": "<command run on the device>", "capturedAt": "<ISO timestamp>",
                 "outputPath": "<host file holding the raw output>" }
    }
  },
  "editableSurface": { "allow": ["^kernel/[^/]+\\.cpp$"], "readOnly": ["^verify/", "^host/"],
                       "singleFilePerTurn": true },
  "symbols": { "namespaces": ["DeviceApi::"], "names": ["DataCopy", "DataCopyPad"],
               "provenance": { "command": "<signature extraction command>", "capturedAt": "...",
                               "outputPath": "..." } },
  "rules": [ /* see below */ ],
  "diagnostics": [ { "id": "missing-symbol", "pattern": "no member named '([A-Za-z_]\\w*)'",
                     "class": "syntax", "routeSymbols": true, "hint": "..." } ],
  "metrics": [ { "name": "mte2_ratio", "pattern": "mte2_ratio[^0-9]*([0-9.]+)" } ],
  "bottleneck": { "labels": [ { "id": "transfer",
      "when": [ { "metric": "mte2_ratio", "op": ">=", "value": 0.5 } ],
      "actions": ["alignment", "coalescing", "double-buffer", "copy-compute-overlap"] } ] },
  "timing": { "protocolVersion": "device-a-timing-1", "warmup": 3, "repeats": 100,
              "latencySource": "step_trace.csv:computing", "metricSource": "kernel_details.csv",
              "minRuntimeMs": 15 },
  "precision": { "dtypes": [ { "name": "fp16", "mantissaBits": 10 } ], "maxRelaxation": 10 },
  "cases": { "alignmentBytes": 512, "table": [ { "id": "c1", "elements": 1000000,
              "innermostBytes": 1009, "dims": 2, "range": "large-asymmetric" } ] },
  "deviceSerialization": { "leaseFile": "<host path>", "commandPattern": "device-run|device-profile",
                           "timeoutMs": 3600000 }
}
```

Only `version`, `id`, `chip`, `toolchain` and `capacities` are required; every other section is optional and
is enforced only when present.

### Rules

A rule has an `id`, a `purpose` (`correctness`, `bandwidth`, `performance`, `integrity`), a `severity`
(`reject` or `warn`), an `appliesTo` path pattern, a `message` and an optional `suggest`. Five kinds exist:

| kind | fields | fires when |
|---|---|---|
| `forbid` | `pattern` | the pattern matches anywhere in the file |
| `require` | `pattern` | the pattern matches nowhere in the file |
| `forbidWithin` | `region`, `pattern` | the pattern matches inside a region match |
| `requireWithin` | `region`, `pattern` | a region match contains no pattern match |
| `pairing` | `open`, `close` | the two patterns match a different number of times |
| `budget` | `capacity`, `allocation`, optional `multiplier` | summed allocations, times the multiplier, exceed the probed capacity |

`purpose` is not decoration. An alignment constraint that exists for correctness and one that exists for peak
bandwidth are different rules with different severities, and merging them produces either a compile failure
explained as a bandwidth problem or a bandwidth problem treated as a hard constraint.

## What the loader refuses

A profile is rejected outright, before any session starts, when:

- a capacity has no probe receipt — a constant nobody measured on this machine is not evidence;
- a pattern is not a valid regular expression, or a metric pattern has no capture group;
- a budget rule names a capacity, or a bottleneck label names a metric, that the profile does not define;
- `timing.latencySource` equals `timing.metricSource` — one protocol produces one latency number, and a
  profiling pass measures different work than the timing pass;
- `precision.maxRelaxation` exceeds 10× the dtype tolerance, or a dtype is given a tolerance directly instead
  of its mantissa width (`platformTolerance` derives the relative tolerance as `2^-mantissaBits`);
- the declared case table has fewer than four cases, leaves less than half of them unaligned, spans fewer than
  three element-count magnitudes, covers fewer than two ranks, or fewer than three value ranges.

The case axes are checked at load time because a case set that is all powers of two and all the same rank
lets a tail-block bug and a shape-specialised implementation pass every case.

## Deliberate limits

- Rules are text-level, not an AST or a type checker. They catch contract violations, not algorithmic errors.
- The gate sees file writes and shell output. Work a command does internally is invisible to it; integrity
  rules on the binding layer and the evaluator's own checks remain necessary.
- One file per round applies to the file tools. A shell command can still change files; that is a deliberate
  escape hatch for builds and generated artefacts.
- The harness ships no profile for any particular chip. Writing one — including probing the capacities and
  extracting the legal API surface from the installed headers — is operator work, and the numbers in it must
  come from the machine the workflow will actually run on.
