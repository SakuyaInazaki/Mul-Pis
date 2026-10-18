#!/usr/bin/env python3
"""Task-contract local evaluator. Python stdlib only; not an OS sandbox.

The host selects the contract module, never the candidate. SPEC supplies exact
cases, API/import policy, tolerance and timing. reference, invoke, synchronize,
and baseline functions are task code. Workers exchange JSON and do not share a
Python interpreter with the independent reference or the controller.
"""
import ast
import contextlib
import copy
import datetime
import hashlib
import importlib
import importlib.util
import inspect
import json
import math
import os
import pathlib
import selectors
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import traceback

WORKER_OPTIONS = None


class WorkerFailure(RuntimeError):
    pass


class MeasurementWorkerFailure(WorkerFailure):
    def __init__(self, role, message):
        super().__init__(message)
        self.role = role


TIMING_EXECUTION = "interleaved-persistent-v2"
# Frozen measurement protocol floors. These are host code, not task
# configuration: a contract may be stricter but never looser.
MINIMUM_WARMUP = 10
MINIMUM_REPEATS = 30
MINIMUM_SAMPLE_SECONDS_FLOOR = 1e-4
REPORTED_DISPERSION_LIMIT = 0.05
REPORTED_ERRORS = 32
# Decision thresholds. Each default is the published value; a contract may
# override it through SPEC.decisionPolicy, but `TIGHTER` says which direction
# counts as stricter, and an override in the other direction is refused. A
# number that needs recalibrating for real hardware belongs in a reviewed
# change to this table, not in a task's own configuration.
DECISION_DEFAULTS = {
    "determinismRepeats": 3,
    "toleranceMagnitudeRatio": 10.0,
    "referenceErrorRatioLimit": 10.0,
    "minimumImprovementFloor": 0.002,
    "minimumImprovementDispersionFactor": 0.85,
    "endToEndNoiseMargin": 1.03,
    "confirmRatio": 1 / 3,
    "confirmAgreement": 0.10,
    "quarantineRatio": 0.1,
}
TIGHTER = {
    "determinismRepeats": "higher",
    "toleranceMagnitudeRatio": "higher",
    "referenceErrorRatioLimit": "lower",
    "minimumImprovementFloor": "higher",
    "minimumImprovementDispersionFactor": "higher",
    "endToEndNoiseMargin": "lower",
    "confirmRatio": "higher",
    "confirmAgreement": "lower",
    "quarantineRatio": "higher",
}


# Published fault taxonomy for scoring the checks themselves. The reported
# escape rates differ by an order of magnitude between these families, so a
# single overall number hides exactly the part that matters.
FAULT_FAMILIES = ("arithmetic", "precision", "synchronization", "boundary", "control")


def decision_policy(spec):
    """Effective thresholds for this contract, defaults included."""
    declared = spec.get("decisionPolicy", {})
    return {name: declared.get(name, default) for name, default in DECISION_DEFAULTS.items()}


def load(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(sys.stderr):
        spec.loader.exec_module(module)
    return module


def finite_tree(value, where="output"):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    if isinstance(value, (list, tuple)):
        return [finite_tree(item, f"{where}[{i}]") for i, item in enumerate(value)]
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        return {k: finite_tree(v, f"{where}.{k}") for k, v in value.items()}
    raise ValueError(f"{where}: expected finite JSON numbers/booleans or a nested array/object; normalize explicitly")


def compare(actual, expected, atol, rtol):
    """Locatable witness without handing back reference values.

    Errors carry position, contract category and error magnitudes, plus the
    index range of every mismatching leaf per list depth. Expected and actual
    numbers stay out of the diagnostic: the candidate-writing context must not
    learn the reference outputs (input-blind generation), and published
    ablations put the value of per-element numeric diffs near zero anyway.
    """
    errors = []
    max_abs = max_rel = 0.0
    count = mismatches = total = 0
    box = {}

    def mark(location, indices, entry):
        nonlocal total
        total += 1
        for depth, index in enumerate(indices):
            low, high = box.get(depth, (index, index))
            box[depth] = (min(low, index), max(high, index))
        if len(errors) < REPORTED_ERRORS:
            errors.append({"location": location, **entry})

    def visit(a, b, location, indices):
        nonlocal max_abs, max_rel, count, mismatches
        if isinstance(b, dict):
            if not isinstance(a, dict) or set(a) != set(b):
                mark(location, indices, {"kind": "keys", "expectedKeys": sorted(b),
                                         "actualKeys": sorted(a) if isinstance(a, dict) else type(a).__name__})
                return
            for key in b:
                visit(a[key], b[key], f"{location}.{key}", indices)
        elif isinstance(b, list):
            if not isinstance(a, list) or len(a) != len(b):
                mark(location, indices, {"kind": "shape", "expectedLength": len(b),
                                         "actualLength": len(a) if isinstance(a, list) else type(a).__name__})
                return
            for i, item in enumerate(b):
                visit(a[i], item, f"{location}[{i}]", indices + (i,))
        else:
            count += 1
            if isinstance(a, (list, dict)) or isinstance(a, bool) != isinstance(b, bool):
                mismatches += 1
                mark(location, indices, {"kind": "type", "actualType": type(a).__name__})
                return
            if isinstance(b, bool):
                if a is not b:
                    mismatches += 1
                    mark(location, indices, {"kind": "boolean"})
                return
            difference = abs(a - b)
            relative = difference / abs(b) if b else (0.0 if difference == 0 else None)
            max_abs = max(max_abs, difference)
            if relative is not None:
                max_rel = max(max_rel, relative)
            if difference > atol + rtol * abs(b):
                mismatches += 1
                mark(location, indices, {"kind": "numerical", "absoluteError": difference, "relativeError": relative})

    visit(actual, expected, "output", ())
    return {"passed": not total, "maxAbs": max_abs, "maxRelFinite": max_rel,
            "elements": count, "mismatches": mismatches,
            "mismatchRatio": mismatches / count if count else None,
            "boundingBox": [{"depth": depth, "firstIndex": low, "lastIndex": high}
                            for depth, (low, high) in sorted(box.items())],
            "errors": errors, "omittedErrors": total - len(errors)}


def leaf_magnitude(value):
    """Mean |leaf| of the reference tree, for the tolerance-hole self-check."""
    total = count = 0.0

    def visit(item):
        nonlocal total, count
        if isinstance(item, bool):
            return
        if isinstance(item, (int, float)):
            total += abs(item)
            count += 1
        elif isinstance(item, list):
            for entry in item:
                visit(entry)
        elif isinstance(item, dict):
            for entry in item.values():
                visit(entry)

    visit(value)
    return total / count if count else None


# Fixed value-only transforms. Shape, integers, booleans and exact zeros are
# preserved so sparse/triangular structure survives; only the magnitudes and
# signs that a uniformly positive declared input never exercises change.
PERTURBATIONS = (("d1-original", 1.0), ("d2-large", 3.0), ("d3-near-zero", 0.01), ("d4-sign", -1.0))


def scale_floats(value, factor):
    if isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if value == 0.0 else value * factor
    if isinstance(value, list):
        return [scale_floats(item, factor) for item in value]
    if isinstance(value, dict):
        return {key: scale_floats(item, factor) for key, item in value.items()}
    return value


def case_variants(case):
    """The declared case plus its value-only hidden variants, same shape.

    A transform that leaves this particular input unchanged (an all-integer or
    all-zero input, say) is marked instead of being run again: repeating an
    identical check is not extra coverage.
    """
    declared = json.dumps(case["input"], sort_keys=True)
    variants = [{"variantId": name, "case": {**case, "input": scale_floats(case["input"], factor)}}
                for name, factor in PERTURBATIONS]
    variants[0]["case"] = copy.deepcopy(case)
    for variant in variants[1:]:
        variant["duplicate"] = json.dumps(variant["case"]["input"], sort_keys=True) == declared
    return variants


def dispersion(values):
    mean = statistics.fmean(values)
    return statistics.pstdev(values) / mean if mean > 0 else None


def kendall_tau_b(first, second):
    """Rank agreement between two per-round orderings of the same roles."""
    concordant = discordant = tied_first = tied_second = 0
    for i in range(len(first)):
        for j in range(i + 1, len(first)):
            a, b = first[i] - first[j], second[i] - second[j]
            if a == 0 and b == 0:
                continue
            if a == 0:
                tied_first += 1
            elif b == 0:
                tied_second += 1
            elif (a > 0) == (b > 0):
                concordant += 1
            else:
                discordant += 1
    denominator = math.sqrt((concordant + discordant + tied_first) * (concordant + discordant + tied_second))
    return (concordant - discordant) / denominator if denominator else None


def validate(contract):
    spec = contract.SPEC
    if not isinstance(spec, dict) or not isinstance(spec.get("protocolId"), str) or not spec["protocolId"] or len(spec["protocolId"]) > 160 or "\0" in spec["protocolId"]:
        raise ValueError("SPEC.protocolId is required")
    cases = spec.get("cases")
    if not isinstance(cases, list) or not cases or any(not isinstance(c, dict) or not isinstance(c.get("id"), str) or not c["id"] or len(c["id"]) > 80 or "\0" in c["id"] for c in cases):
        raise ValueError("SPEC.cases must be explicit nonempty JSON case descriptors with unique ids")
    if len({c["id"] for c in cases}) != len(cases):
        raise ValueError("case ids must be unique")
    if any("input" not in case for case in cases):
        raise ValueError("every case must carry an explicit input so the host can derive its value-only variants")
    for case in cases:
        if case.get("scope") not in ("kernel", "end-to-end"):
            raise ValueError(f"case {case['id']} must declare scope kernel or end-to-end")
        if case.get("set", "iteration") not in ("iteration", "certification"):
            raise ValueError(f"case {case['id']} set must be iteration or certification")
        if case.get("bitExact") is not None and case["bitExact"] not in getattr(contract, "baselines", {}):
            raise ValueError(f"case {case['id']} bitExact must name one of the declared baselines")
        if not isinstance(case.get("axes"), dict) or not case["axes"] or \
                any(not isinstance(k, str) or not k or not isinstance(v, (str, int, float, bool)) for k, v in case["axes"].items()):
            raise ValueError(f"case {case['id']} must declare non-empty scalar coverage axes (shape, dtype, boundary class, ...)")
        if case.get("oracle", "deterministic") not in ("deterministic", "matched-ratio"):
            raise ValueError(f"case {case['id']} oracle must be deterministic or matched-ratio; sampling oracles are not implemented here")
        if case.get("oracle") == "matched-ratio" and (type(case.get("matchedRatio")) not in (int, float) or
                                                      not 0 < case["matchedRatio"] <= 1):
            raise ValueError(f"case {case['id']} matched-ratio oracle needs an explicit matchedRatio in (0, 1]")
    iteration = [case for case in cases if case.get("set", "iteration") == "iteration"]
    if not any(case["scope"] == "end-to-end" for case in iteration):
        raise ValueError("at least one iteration case must measure the end-to-end scope; isolated kernel timing alone cannot accept a candidate")
    if not any(case.get("set") == "certification" for case in cases):
        raise ValueError("at least one case must be reserved for certification; the set the candidate iterates on cannot also certify it")
    if len({json.dumps(case["axes"], sort_keys=True) for case in cases}) < 2:
        raise ValueError("SPEC.cases must cover at least two distinct declared axis combinations")
    json.dumps(cases, allow_nan=False)
    if not isinstance(spec.get("kernelSymbol"), str) or not spec["kernelSymbol"].isidentifier():
        raise ValueError("SPEC.kernelSymbol must identify the candidate function to replace for no-op detection")
    if not isinstance(spec.get("allowedImports"), list) or not all(isinstance(v, str) and v for v in spec["allowedImports"]):
        raise ValueError("SPEC.allowedImports must explicitly list allowed module names")
    if not isinstance(spec.get("apiTargets"), list) or not all(isinstance(v, str) and "." in v for v in spec["apiTargets"]):
        raise ValueError("SPEC.apiTargets must explicitly list environment module API names (possibly empty)")
    if not isinstance(spec.get("forbiddenRuntimeTargets"), list) or \
            not all(isinstance(v, str) and "." in v for v in spec["forbiddenRuntimeTargets"]):
        raise ValueError("SPEC.forbiddenRuntimeTargets must list the library entry points the candidate replaces (possibly empty)")
    for name in ("reference", "invoke", "synchronize", "noop"):
        if not callable(getattr(contract, name, None)):
            raise ValueError(f"contract must provide {name}")
    if not isinstance(getattr(contract, "baselines", None), dict) or not contract.baselines or any(not isinstance(k, str) or not k or len(k) > 128 or "\0" in k or not callable(v) for k, v in contract.baselines.items()):
        raise ValueError("contract.baselines must provide named actual callable baselines")
    tiers = spec.get("baselineTiers")
    if not isinstance(tiers, dict) or set(tiers) != set(contract.baselines) or \
            any(value not in ("naive", "expert", "library", "compiler") for value in tiers.values()):
        raise ValueError("SPEC.baselineTiers must grade every named baseline as naive, expert, library or compiler")
    if len(set(tiers.values())) < 2:
        raise ValueError("every speedup needs two denominators: declare baselines of at least two distinct tiers")
    environment = spec.get("measurementEnvironment")
    if not isinstance(environment, dict) or \
            any(not isinstance(environment.get(name), str) or not environment[name].strip() or len(environment[name]) > 64
                for name in ("environmentId", "clockPolicy", "precision")) or \
            environment.get("cacheState") not in ("cold", "warm"):
        raise ValueError("SPEC.measurementEnvironment must declare environmentId, clockPolicy, precision and cacheState; "
                         "numbers from different environments or precision policies are not comparable")
    timing = spec.get("timing", {})
    if type(timing.get("warmup")) is not int or timing["warmup"] < MINIMUM_WARMUP or \
            type(timing.get("repeats")) is not int or timing["repeats"] < MINIMUM_REPEATS:
        raise ValueError(f"frozen timing protocol floor: warmup >= {MINIMUM_WARMUP} and repeats >= {MINIMUM_REPEATS}")
    if type(timing.get("minimumSampleSeconds")) not in (int, float) or \
            not math.isfinite(timing["minimumSampleSeconds"]) or timing["minimumSampleSeconds"] < MINIMUM_SAMPLE_SECONDS_FLOOR:
        raise ValueError(f"task must declare timing.minimumSampleSeconds >= {MINIMUM_SAMPLE_SECONDS_FLOOR}; "
                         "shorter work cannot decide between candidates")
    declared = spec.get("decisionPolicy", {})
    if not isinstance(declared, dict) or any(name not in DECISION_DEFAULTS for name in declared):
        raise ValueError(f"SPEC.decisionPolicy may only override {sorted(DECISION_DEFAULTS)}")
    for name, value in declared.items():
        default = DECISION_DEFAULTS[name]
        if type(value) is not type(default) and not (isinstance(value, (int, float)) and isinstance(default, float)):
            raise ValueError(f"decisionPolicy.{name} must have the same type as its default")
        if not math.isfinite(value) or (value < default if TIGHTER[name] == "higher" else value > default):
            raise ValueError(f"decisionPolicy.{name}={value} is looser than the published default {default}; "
                             "a task may tighten a threshold, never relax it")
    if type(spec.get("workerTimeoutSeconds")) not in (int, float) or not math.isfinite(spec["workerTimeoutSeconds"]) or spec["workerTimeoutSeconds"] <= 0:
        raise ValueError("task must explicitly choose a positive workerTimeoutSeconds for each execution")
    if type(spec.get("workerOutputBytes")) is not int or spec["workerOutputBytes"] < 1:
        raise ValueError("task must explicitly choose a positive workerOutputBytes for each worker output")
    tolerance = spec.get("tolerance", {})
    mode = tolerance.get("mode")
    if mode not in ("fixed", "reference-repeat", "reference-error"):
        raise ValueError("tolerance mode must be fixed, reference-repeat or reference-error")
    for name in (["atol", "rtol"] if mode == "fixed" else ["rtol", "sigmaMultiplier"]):
        if type(tolerance.get(name)) not in (int, float) or not math.isfinite(tolerance[name]) or tolerance[name] < 0:
            raise ValueError(f"explicit finite nonnegative tolerance.{name} is required")
    if mode != "fixed" and (type(tolerance.get("repeats")) is not int or tolerance["repeats"] < 2):
        raise ValueError("reference calibration requires at least two actual reference observations")
    if mode == "reference-error" and not callable(getattr(contract, "golden", None)):
        raise ValueError("reference-error calibration requires an independent task golden function")
    if hasattr(contract, "compile_candidate") or hasattr(contract, "bind_compiled"):
        if not callable(getattr(contract, "compile_candidate", None)) or not callable(getattr(contract, "bind_compiled", None)):
            raise ValueError("native contract requires both compile_candidate(source_path, build_dir) and bind_compiled(candidate, build_dir)")
    mutants = getattr(contract, "MUTANTS", {})
    if not isinstance(mutants, dict) or any(not isinstance(name, str) or not name or not isinstance(item, dict) or
                                            not isinstance(item.get("source"), str) or not item["source"] or
                                            item.get("family") not in FAULT_FAMILIES
                                            for name, item in mutants.items()):
        raise ValueError(f"contract.MUTANTS must map fault names to {{family, source}} with family in {sorted(FAULT_FAMILIES)}")
    if hasattr(contract, "validate_parameters") and not callable(contract.validate_parameters):
        raise ValueError("contract validate_parameters must be callable when supplied")
    if hasattr(contract, "classify_candidate_call") and not callable(contract.classify_candidate_call):
        raise ValueError("contract classify_candidate_call must be callable when supplied")
    return spec


def validate_task_parameters(contract, parameters):
    """Only an explicit trusted contract verdict can reject a parameter tuple."""
    if not isinstance(parameters, dict):
        return {"valid": False, "reason": "config.parameters must be a JSON object"}
    hook = getattr(contract, "validate_parameters", None)
    if hook is None:
        return {"valid": True, "reason": "no task parameter constraint hook was supplied"}
    verdict = hook(copy.deepcopy(parameters))
    if type(verdict) is bool:
        return {"valid": verdict, "reason": "task validate_parameters returned true" if verdict else
                "task validate_parameters returned false"}
    if isinstance(verdict, dict) and type(verdict.get("valid")) is bool and \
            (verdict.get("reason") is None or isinstance(verdict["reason"], str)):
        reason = verdict.get("reason") or ("task validate_parameters returned true" if verdict["valid"] else
                                           "task validate_parameters returned false")
        return {"valid": verdict["valid"], "reason": reason}
    raise ValueError("task validate_parameters must return bool or {valid: bool, reason?: str}")


def worker_environment(scratch):
    """One host-selected base for compile, correctness and measured workers."""
    return {**WORKER_OPTIONS["workerEnvironment"], "HOME": scratch, "TMPDIR": scratch}


def bind_controller_environment():
    # Contract import and case discovery must see the same selected device and
    # thread variables as their independently executed worker functions.
    selected = worker_environment(WORKER_OPTIONS["scratchRoot"])
    os.environ.clear()
    os.environ.update(selected)


def api_contract(source, contract):
    tree = ast.parse(source)
    allowed = contract.SPEC["allowedImports"]
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for name in node.names:
                if not any(name.name == v or name.name.startswith(v + ".") for v in allowed):
                    raise ValueError(f"import outside task allowlist: {name.name} at line {node.lineno}")
                aliases[name.asname or name.name.split(".")[0]] = name.name if name.asname else name.name.split(".")[0]
        elif isinstance(node, ast.ImportFrom):
            if node.level or not any(node.module == v or (node.module or "").startswith(v + ".") for v in allowed):
                raise ValueError(f"import outside task allowlist: {node.module} at line {node.lineno}")
            for name in node.names:
                if name.name == "*":
                    raise ValueError("star imports cannot be mechanically API-bound")
                aliases[name.asname or name.name] = node.module + "." + name.name
    signatures = {}
    for target in contract.SPEC["apiTargets"]:
        pieces = target.split(".")
        resolved = None
        for i in range(len(pieces) - 1, 0, -1):
            try:
                resolved = importlib.import_module(".".join(pieces[:i]))
            except ModuleNotFoundError:
                continue
            for attribute in pieces[i:]:
                resolved = getattr(resolved, attribute)
            break
        if resolved is None or not callable(resolved):
            raise ValueError(f"declared API is unavailable in this environment: {target}")
        try:
            signatures[target] = inspect.signature(resolved)
        except (ValueError, TypeError):
            signatures[target] = None

    def qualified(node):
        if isinstance(node, ast.Name):
            return aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            prefix = qualified(node.value)
            return prefix + "." + node.attr if prefix else None
        return None

    # A small, explicit candidate-source boundary, not a Python sandbox. Deny
    # these capabilities even when first saved under another name. Trusted task
    # functions (including native compile/bind) are outside this candidate AST.
    forbidden = {"__import__", "eval", "exec", "compile", "open", "input", "globals", "locals", "vars", "dir",
                 "getattr", "setattr", "delattr", "hasattr", "breakpoint", "help"}
    file_or_reflection = {"read", "read_text", "read_bytes", "readlines", "readline", "write", "write_text", "write_bytes",
                          "load_module", "exec_module", "import_module", "getsource", "getfile", "currentframe", "stack",
                          "f_globals", "f_locals", "f_back", "tb_frame", "gi_frame", "cr_frame"}
    local_calls = {node.name for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    numeric_builtins = {"abs", "all", "any", "bool", "complex", "dict", "divmod", "enumerate", "filter", "float", "frozenset",
                        "int", "isinstance", "issubclass", "iter", "len", "list", "map", "max", "min", "next", "pow", "range",
                        "reversed", "round", "set", "slice", "sorted", "sum", "tuple", "zip", "bytes", "bytearray", "memoryview",
                        "Exception", "RuntimeError", "ValueError", "TypeError", "AssertionError", "NotImplementedError"}
    # Deliberately conservative across scopes: no data-flow claim that a
    # reassigned/argument-bound name still denotes the original callable.
    assigned = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del))}
    parameters = {node.arg for node in ast.walk(tree) if isinstance(node, ast.arg)}
    rebound = assigned | parameters
    calls, runtime_checks, unresolved = [], [], []

    def classify_unresolved(target, syntax_node, usage, reason):
        diagnostic = {"api": qualified(target) or ast.unparse(target), "line": syntax_node.lineno,
                      "column": syntax_node.col_offset, "usage": usage, "reason": reason}
        classifier = getattr(contract, "classify_candidate_call", None)
        if classifier is None:
            unresolved.append(diagnostic)
            return
        try:
            verdict = classifier(source, syntax_node, usage)
        except Exception as error:
            unresolved.append({**diagnostic, "hostClassifierError": f"{type(error).__name__}: {error}"})
            return
        if not isinstance(verdict, dict) or type(verdict.get("allowed")) is not bool or \
                not isinstance(verdict.get("reason"), str) or not verdict["reason"].strip():
            unresolved.append({**diagnostic, "hostClassifierError": "classifier must return {allowed: bool, reason: nonempty string}"})
            return
        if verdict["allowed"]:
            runtime_checks.append({**diagnostic, "hostReason": verdict["reason"],
                                   "resolution": "host-classified call shape requires isolated runtime validation"})
        else:
            unresolved.append({**diagnostic, "hostReason": verdict["reason"]})

    def check_call(target, args, keywords, line, syntax_node=None, usage="call"):
        syntax_node = syntax_node or target
        name = qualified(target)
        root = target
        while isinstance(root, ast.Attribute):
            root = root.value
        if isinstance(root, ast.Name) and root.id in rebound:
            if isinstance(target, ast.Attribute) and root.id not in aliases:
                classify_unresolved(target, syntax_node, usage,
                                    "object method root is locally bound; static API identity unavailable")
            else:
                unresolved.append({"api": name or ast.unparse(target), "line": line,
                                   "reason": "callable binding is reassigned or shadowed by an argument"})
            return
        if name not in signatures:
            if isinstance(target, ast.Name) and target.id not in aliases and target.id in local_calls | numeric_builtins:
                return
            reason = "call target is dynamic or outside task-declared mechanically resolvable APIs"
            if isinstance(target, (ast.Subscript, ast.Call)):
                classify_unresolved(target, syntax_node, usage, reason)
            else:
                unresolved.append({"api": name or ast.unparse(target), "line": line, "reason": reason})
            return
        signature = signatures[name]
        if signature is None or any(isinstance(a, ast.Starred) for a in args) or any(k.arg is None for k in keywords):
            runtime_checks.append({"api": name, "line": line,
                                   "reason": "environment signature unavailable" if signature is None else "dynamic argument expansion",
                                   "resolution": "task-declared API call requires isolated runtime validation"})
        else:
            try:
                signature.bind(*[object() for _ in args], **{k.arg: object() for k in keywords})
            except TypeError as error:
                raise ValueError(f"{name}{signature} at line {line}: {error}") from error
            calls.append({"api": name, "signature": str(signature), "line": line})

    def check_callback(target, arity, line):
        # A lambda's explicit calls are visited by the same AST walk below.
        if not isinstance(target, ast.Lambda):
            check_call(target, [ast.Constant(None) for _ in range(arity)], [], line, target, "callback")

    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            resolved = aliases.get(node.id, node.id)
            if node.id in forbidden or node.id.startswith("__") or resolved.split(".")[-1] in forbidden | file_or_reflection or resolved.startswith(("sys.", "inspect.", "builtins.", "importlib.")):
                raise ValueError(f"candidate capability is forbidden: {resolved} at line {node.lineno}")
        if isinstance(node, ast.Attribute):
            name = qualified(node)
            if node.attr in forbidden | file_or_reflection or node.attr.startswith("__") or (name and name.startswith(("sys.", "inspect.", "builtins.", "importlib."))):
                raise ValueError(f"candidate capability is forbidden: {name or node.attr} at line {node.lineno}")
        if isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del)):
            # Stateless candidate-source contract: do not infer whether an
            # object aliases an imported module. Tensor/array indexing remains
            # separate from direct attribute mutation.
            raise ValueError(f"candidate capability is forbidden: attribute mutation at line {node.lineno}")
        if isinstance(node, ast.Subscript) and isinstance(node.ctx, (ast.Store, ast.Del)):
            root = node.value
            while isinstance(root, (ast.Attribute, ast.Subscript)):
                root = root.value
            if isinstance(root, ast.Name) and root.id in aliases:
                raise ValueError(f"candidate cannot mutate imported module/API {root.id} at line {node.lineno}")
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)) and node.id in aliases:
            unresolved.append({"api": aliases[node.id], "line": node.lineno, "reason": "imported API binding is reassigned"})
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for decorator in node.decorator_list:
                # A decorator factory's returned callable is not identified by
                # checking the factory signature. Keep that uncertainty visible.
                check_callback(decorator, 1, decorator.lineno)
        if isinstance(node, ast.ClassDef):
            for keyword in node.keywords:
                if keyword.arg == "metaclass":
                    check_call(keyword.value, [ast.Constant(None)] * 3,
                               [k for k in node.keywords if k.arg != "metaclass"], node.lineno, keyword.value, "metaclass")
        if not isinstance(node, ast.Call):
            continue
        check_call(node.func, node.args, node.keywords, node.lineno, node)
        if isinstance(node.func, ast.Name) and node.func.id not in aliases and node.func.id not in rebound:
            builtin = node.func.id
            if builtin in ("map", "filter") and node.args:
                callback = node.args[0]
                if not (builtin == "filter" and isinstance(callback, ast.Constant) and callback.value is None):
                    check_callback(callback, len(node.args) - 1 if builtin == "map" else 1, node.lineno)
            if builtin == "iter" and len(node.args) == 2:
                check_callback(node.args[0], 0, node.lineno)
            if builtin in ("sorted", "min", "max"):
                for keyword in node.keywords:
                    if keyword.arg == "key" and not (isinstance(keyword.value, ast.Constant) and keyword.value.value is None):
                        check_callback(keyword.value, 1, node.lineno)
    return {"checkedCalls": calls, "runtimeChecks": runtime_checks, "unresolvedCalls": unresolved,
            "inconclusive": bool(unresolved),
            "limitation": "Candidate AST capability checks and task-selected real environment signatures only. Declared calls with unavailable signatures, dynamic arguments, or task-classified call shapes require isolated compile/correctness validation; unresolved targets still require task-contract clarification. This is not arbitrary Python/native isolation or proof of device kernel participation."}


def resolve_target(target):
    """Locate a dotted environment attribute as (owner, name, value)."""
    pieces = target.split(".")
    for i in range(len(pieces) - 1, 0, -1):
        try:
            owner = importlib.import_module(".".join(pieces[:i]))
        except ModuleNotFoundError:
            continue
        for attribute in pieces[i:-1]:
            owner = getattr(owner, attribute)
        return owner, pieces[-1], getattr(owner, pieces[-1])
    raise ValueError(f"declared target is unavailable in this environment: {target}")


def install_call_counters(targets):
    """Count calls to the library entry points the candidate must replace."""
    counts = {}
    for target in targets:
        owner, name, original = resolve_target(target)
        counts[target] = 0

        def wrapper(*args, _target=target, _original=original, **kwargs):
            counts[_target] += 1
            return _original(*args, **kwargs)

        setattr(owner, name, wrapper)
    return counts


def worker(contract_path, source_path, role, request):
    if not hasattr(worker, "cache"):
        contract = load(contract_path, "trusted_operator_contract")
        spec = validate(contract)
        # A trusted prepare must return fresh or fully reset input for every
        # invocation, including persistent-worker rounds. Its work happens
        # before the timer; copying the descriptor alone cannot reset a cached
        # device buffer returned by a task-specific prepare implementation.
        prepare = getattr(contract, "prepare", lambda descriptor: copy.deepcopy(descriptor["input"]))
        normalize = getattr(contract, "normalize", lambda output: output)
        synchronize, clock = contract.synchronize, time.perf_counter_ns
        invoke_candidate, noop = contract.invoke, contract.noop
        if role == "goal":
            if not callable(getattr(contract, "verify_goal", None)):
                raise ValueError("host contract has no verify_goal; goal verification is unconfigured")
            invoke = None
        elif role in ("candidate", "noop", "instrumented"):
            if role == "instrumented":
                worker.counters = install_call_counters(spec["forbiddenRuntimeTargets"])
            candidate = load(source_path, "candidate_operator")
            if callable(getattr(contract, "compile_candidate", None)):
                build_dir = request.get("compiledBuildDir")
                if not isinstance(build_dir, str) or not pathlib.Path(build_dir).is_dir():
                    raise ValueError("native candidate requires the host-frozen compile artifacts; no recompilation or Python fallback")
                contract.bind_compiled(candidate, build_dir)
            kernel = getattr(candidate, spec["kernelSymbol"])
            if not callable(kernel):
                raise ValueError("declared kernelSymbol is not callable")
            if role == "noop":
                setattr(candidate, spec["kernelSymbol"], noop)
            invoke = lambda data: invoke_candidate(candidate, data)
        elif role == "reference":
            invoke = contract.reference
        elif role == "golden":
            invoke = contract.golden
        elif role.startswith("baseline:"):
            invoke = contract.baselines[role.removeprefix("baseline:")]
        elif role == "compile":
            invoke = None
        else:
            raise ValueError("unknown worker role")
        worker.cache = (contract, spec, prepare, normalize, synchronize, clock, invoke)
    contract, spec, prepare, normalize, synchronize, clock, invoke = worker.cache
    if role == "goal":
        criteria, observations = request.get("criteria"), request.get("observations")
        if not isinstance(criteria, list) or not criteria or any(not isinstance(item, str) or not item for item in criteria) or not isinstance(observations, list):
            raise ValueError("goal verification requires original criteria and verified observations")
        return {"goalChecks": contract.verify_goal(criteria, observations)}
    if role == "compile":
        # The trusted task chooses its real compiler/API and flags. The candidate
        # cannot select commands; this call has the same bounded worker lifetime.
        return {"nativeCompilation": contract.compile_candidate(source_path, str(pathlib.Path.cwd()))}
    case = request["case"]
    if request.get("warmupOnly"):
        for _ in range(spec["timing"]["warmup"]):
            data = prepare(copy.deepcopy(case))
            synchronize()
            finite_tree(normalize(invoke(data)))
            synchronize()
        return {"ready": True}
    outputs, samples = [], []
    measuring = request.get("measure", False)
    repeats = request.get("repeats", spec["timing"]["repeats"] if measuring else 1)
    warmup = request.get("warmup", spec["timing"]["warmup"] if measuring else 0)
    for index in range(warmup + repeats):
        data = prepare(copy.deepcopy(case))
        synchronize()
        start = clock()
        output = invoke(data)
        synchronize()
        elapsed = (clock() - start) / 1e9
        normalized = finite_tree(normalize(output))
        if not measuring or index >= warmup:
            outputs.append(normalized)
            if measuring:
                samples.append(elapsed)
    if role == "instrumented":
        return {"outputs": outputs, "samplesSeconds": samples, "replacedApiCalls": dict(worker.counters)}
    return {"outputs": outputs, "samplesSeconds": samples}


def run_worker(contract_path, source_path, role, case, *, timeout, output_bytes, repeats=1, measure=False):
    if not WORKER_OPTIONS:
        raise ValueError("worker write isolation was not bound by the host")
    scratch = tempfile.mkdtemp(prefix=role.replace(":", "-") + "-", dir=WORKER_OPTIONS["scratchRoot"])
    command = WORKER_OPTIONS["commandPrefix"] + [sys.executable, "-I", str(pathlib.Path(__file__).resolve()), "--worker", contract_path, source_path, role]
    log_dir = pathlib.Path(tempfile.mkdtemp(prefix=role.replace(":", "-") + "-", dir=WORKER_OPTIONS["logsRoot"]))
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True, cwd=scratch,
                             env=worker_environment(scratch))
    previous = signal.getsignal(signal.SIGTERM)
    exceeded = timed_out = dangling = False

    def kill_group():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    selector = selectors.DefaultSelector()
    streams = {"stdin": child.stdin, "stdout": child.stdout, "stderr": child.stderr}
    logs = {"stdout": (log_dir / "stdout.json").open("wb"), "stderr": (log_dir / "stderr.txt").open("wb")}
    counts = {"stdout": 0, "stderr": 0}
    payload = json.dumps(case if role == "goal" else {"case": case, "repeats": repeats, "measure": measure,
                          "compiledBuildDir": WORKER_OPTIONS.get("compiledBuildDir")}, allow_nan=False).encode()
    sent = 0
    for name, stream in streams.items():
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_WRITE if name == "stdin" else selectors.EVENT_READ, name)

    def close_channel(stream):
        try:
            selector.unregister(stream)
        except KeyError:
            pass
        stream.close()

    def interrupted(signum, frame):
        kill_group()
        child.wait(timeout=1)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, interrupted)
    try:
        deadline = time.monotonic() + timeout
        drain_deadline = None
        while selector.get_map() or child.poll() is None:
            now = time.monotonic()
            if child.poll() is None and now >= deadline:
                timed_out = True
                kill_group()
                child.wait(timeout=1)
            if child.poll() is not None and drain_deadline is None:
                kill_group()
                drain_deadline = now + 0.25
            if drain_deadline is not None and now >= drain_deadline:
                dangling = bool(selector.get_map())
                break
            for key, _ in selector.select(0.05):
                name, stream = key.data, key.fileobj
                try:
                    if name == "stdin":
                        sent += os.write(stream.fileno(), payload[sent:sent + 65536])
                        if sent == len(payload):
                            close_channel(stream)
                    else:
                        chunk = os.read(stream.fileno(), 65536)
                        if not chunk:
                            close_channel(stream)
                            continue
                        logs[name].write(chunk)
                        counts[name] += len(chunk)
                        if counts[name] > output_bytes:
                            exceeded = True
                            kill_group()
                except BlockingIOError:
                    continue
                except BrokenPipeError:
                    close_channel(stream)
    finally:
        kill_group()
        # No background reader/writer can survive the bounded drain. An escaped
        # descendant retaining a pipe is a failed execution, never a passed one.
        for stream in streams.values():
            if not stream.closed:
                close_channel(stream)
        selector.close()
        for log in logs.values():
            log.close()
        signal.signal(signal.SIGTERM, previous)
    if timed_out:
        raise WorkerFailure(f"{role} worker timed out after task-declared {timeout}s; original process group killed; original stdout/stderr retained at {log_dir}")
    if exceeded:
        raise WorkerFailure(f"{role} worker exceeded task-declared {output_bytes} output bytes; process group killed; raw output retained at {log_dir}")
    if dangling:
        raise WorkerFailure(f"{role} worker output channels remained open after exit; inherited descriptors were closed after bounded drain; execution is not trusted; raw output retained at {log_dir}")
    stderr = (log_dir / "stderr.txt").read_text(errors="replace")
    if child.returncode:
        raise WorkerFailure(f"{role} worker failed ({child.returncode}): {stderr}; original output: {log_dir}")
    try:
        result = json.loads((log_dir / "stdout.json").read_text())
        if not isinstance(result, dict):
            raise ValueError("worker result must be an object")
        if role == "goal":
            if not isinstance(result.get("goalChecks"), dict):
                raise ValueError("verify_goal must return {checks: [...], limitations: [...]} in goalChecks")
            goal_checks = result["goalChecks"]
            if not isinstance(goal_checks.get("checks"), list) or not isinstance(goal_checks.get("limitations"), list):
                raise ValueError("verify_goal must return checks and limitations arrays")
        elif role == "compile":
            native = result.get("nativeCompilation")
            if not isinstance(native, dict) or type(native.get("passed")) is not bool or not isinstance(native.get("diagnostics"), str):
                raise ValueError("compile_candidate must return {passed: bool, diagnostics: str, artifacts?: [scratch-relative file]}")
            artifacts = native.get("artifacts", [])
            if not isinstance(artifacts, list) or any(not isinstance(item, str) or not item for item in artifacts):
                raise ValueError("compiler artifacts must be explicit scratch-relative files")
            if native["passed"] and not artifacts:
                raise ValueError("successful native compilation must produce artifacts for later execution")
            if len(set(artifacts)) != len(artifacts):
                raise ValueError("compiler artifacts must be unique")
            retained = []
            for item in artifacts:
                relative = pathlib.Path(item)
                original = pathlib.Path(scratch) / relative
                if relative.is_absolute() or ".." in relative.parts or original.is_symlink() or not original.is_file() or not original.resolve().is_relative_to(pathlib.Path(scratch).resolve()):
                    raise ValueError("compiler artifact is not a regular file inside its worker scratch")
                target = log_dir / "compilation-artifacts" / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(original, target)
                retained.append(str(target))
            native["retainedArtifacts"] = retained
        else:
            expected = repeats
            outputs = result.get("outputs")
            if not isinstance(outputs, list) or len(outputs) != expected:
                raise ValueError(f"expected exactly {expected} output observations, got {len(outputs) if isinstance(outputs, list) else 'non-list'}")
            # Validate in the parent, independently of worker-side normalization.
            for output in outputs:
                finite_tree(output)
            samples = result.get("samplesSeconds")
            if measure:
                if not isinstance(samples, list) or len(samples) != expected or any(type(value) not in (int, float) or not math.isfinite(value) or value <= 0 for value in samples):
                    result["measurementError"] = f"expected exactly {expected} finite positive timing samples"
                    # Raw bytes stay in stdout.json, including non-finite JSON
                    # extensions. Never propagate those into a trusted receipt.
                    result["samplesSeconds"] = None
            elif samples != []:
                raise ValueError("unmeasured worker returned unexpected timing samples")
    except Exception as error:
        raise WorkerFailure(f"{role} invalid worker result: {error}; original stdout/stderr retained at {log_dir}") from error
    result["workerLogs"] = str(log_dir)
    return result


def measure_workers(contract_path, source_path, case, contract, *, timeout, output_bytes):
    """Serial, round-interleaved samples from persistent independent processes.

    Imports, native binding and task-selected warmup finish for every role
    before the first timing sample. The controller never times its pipe traffic.
    This reduces order drift; it does not establish GPU/CPU exclusivity.
    """
    if not WORKER_OPTIONS:
        raise ValueError("worker write isolation was not bound by the host")
    roles = ["candidate"] + ["baseline:" + name for name in contract.baselines]
    sessions = {}
    order_log = []
    active_role = "measurement-infrastructure"
    selector = selectors.DefaultSelector()
    previous = signal.getsignal(signal.SIGTERM)

    def interrupted(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, interrupted)
    try:
        for role in roles:
            scratch = tempfile.mkdtemp(prefix="measure-" + role.replace(":", "-") + "-", dir=WORKER_OPTIONS["scratchRoot"])
            log_dir = pathlib.Path(tempfile.mkdtemp(prefix="measure-" + role.replace(":", "-") + "-", dir=WORKER_OPTIONS["logsRoot"]))
            command = WORKER_OPTIONS["commandPrefix"] + [sys.executable, "-I", str(pathlib.Path(__file__).resolve()),
                                                           "--worker-loop", contract_path, source_path, role]
            child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     start_new_session=True, cwd=scratch,
                                     env=worker_environment(scratch))
            sessions[role] = {"child": child, "logs": str(log_dir), "stdout": (log_dir / "stdout.jsonl").open("wb"),
                              "stderr": (log_dir / "stderr.txt").open("wb"), "counts": {"stdout": 0, "stderr": 0},
                              "buffer": b"", "outputs": [], "samplesSeconds": []}
            for name in ("stdout", "stderr"):
                stream = getattr(child, name)
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, (role, name))

        def transact(role, request):
            session = sessions[role]
            child = session["child"]
            payload = (json.dumps({"case": case, "compiledBuildDir": WORKER_OPTIONS.get("compiledBuildDir"),
                                   **request}, allow_nan=False) + "\n").encode()
            sent = 0
            os.set_blocking(child.stdin.fileno(), False)
            selector.register(child.stdin, selectors.EVENT_WRITE, (role, "stdin"))
            deadline = time.monotonic() + timeout
            while True:
                if time.monotonic() >= deadline:
                    raise MeasurementWorkerFailure(role, f"{role} measured worker timed out after task-declared {timeout}s; raw streams: {session['logs']}")
                if child.poll() is not None and not session["buffer"].endswith(b"\n"):
                    raise MeasurementWorkerFailure(role, f"{role} measured worker exited ({child.returncode}); raw streams: {session['logs']}")
                for key, _ in selector.select(min(0.05, max(0, deadline - time.monotonic()))):
                    owner, name = key.data
                    stream = key.fileobj
                    if name == "stdin":
                        try:
                            sent += os.write(stream.fileno(), payload[sent:sent + 65536])
                        except BlockingIOError:
                            continue
                        except BrokenPipeError as error:
                            raise MeasurementWorkerFailure(role, f"{role} measured worker closed input; raw streams: {session['logs']}") from error
                        if sent == len(payload):
                            selector.unregister(stream)
                    else:
                        try:
                            chunk = os.read(stream.fileno(), 65536)
                        except BlockingIOError:
                            continue
                        if not chunk:
                            selector.unregister(stream)
                            continue
                        target = sessions[owner]
                        target[name].write(chunk)
                        target[name].flush()
                        target["counts"][name] += len(chunk)
                        if target["counts"][name] > output_bytes:
                            raise MeasurementWorkerFailure(owner, f"{owner} measured worker exceeded task-declared {output_bytes} output bytes; raw streams: {target['logs']}")
                        if name == "stdout":
                            target["buffer"] += chunk
                if b"\n" in session["buffer"]:
                    line, session["buffer"] = session["buffer"].split(b"\n", 1)
                    if session["buffer"]:
                        raise MeasurementWorkerFailure(role, f"{role} measured worker emitted extra output; raw streams: {session['logs']}")
                    try:
                        result = json.loads(line)
                    except (UnicodeError, ValueError) as error:
                        raise MeasurementWorkerFailure(role, f"{role} invalid measured worker JSON; raw streams: {session['logs']}") from error
                    if not isinstance(result, dict):
                        raise MeasurementWorkerFailure(role, f"{role} invalid measured worker object; raw streams: {session['logs']}")
                    return result

        for role in roles:
            active_role = role
            ready = transact(role, {"warmupOnly": True})
            if ready != {"ready": True}:
                raise MeasurementWorkerFailure(role, f"{role} warmup failed; raw streams: {sessions[role]['logs']}")
        for round_index in range(contract.SPEC["timing"]["repeats"]):
            order = roles if round_index % 2 == 0 else list(reversed(roles))
            order_log.append(list(order))
            for role in order:
                active_role = role
                result = transact(role, {"measure": True, "repeats": 1, "warmup": 0})
                outputs = result.get("outputs")
                if not isinstance(outputs, list) or len(outputs) != 1:
                    raise MeasurementWorkerFailure(role, f"{role} expected one measured output; raw streams: {sessions[role]['logs']}")
                finite_tree(outputs[0])
                samples = result.get("samplesSeconds")
                if not isinstance(samples, list) or len(samples) != 1 or type(samples[0]) not in (int, float) or \
                        not math.isfinite(samples[0]) or samples[0] <= 0:
                    sessions[role]["measurementError"] = "expected finite positive timing samples: exactly one per round"
                    sessions[role]["samplesSeconds"].append(None)
                else:
                    sessions[role]["samplesSeconds"].append(samples[0])
                sessions[role]["outputs"].append(outputs[0])
        active_role = "measurement-infrastructure"
        for session in sessions.values():
            session["child"].stdin.close()
        deadline = time.monotonic() + timeout
        while selector.get_map() and time.monotonic() < deadline:
            for key, _ in selector.select(0.05):
                owner, name = key.data
                stream = key.fileobj
                chunk = os.read(stream.fileno(), 65536)
                if not chunk:
                    selector.unregister(stream)
                    continue
                target = sessions[owner]
                target[name].write(chunk)
                target[name].flush()
                target["counts"][name] += len(chunk)
                if target["counts"][name] > output_bytes or name == "stdout":
                    raise MeasurementWorkerFailure(owner, f"{owner} measured worker emitted unexpected or excessive output after final sample; raw streams: {target['logs']}")
        if selector.get_map():
            raise WorkerFailure("measured worker output channels remained open after exit; raw streams retained")
        for role, session in sessions.items():
            if session["child"].wait(timeout=1) != 0:
                raise MeasurementWorkerFailure(role, f"{role} measured worker did not exit cleanly; raw streams: {session['logs']}")
        return {**{role: {"outputs": sessions[role]["outputs"], "samplesSeconds": sessions[role]["samplesSeconds"],
                          "workerLogs": sessions[role]["logs"],
                          "measurementError": sessions[role].get("measurementError")}
                   for role in roles}, "order": order_log}
    except Exception as error:
        if isinstance(error, MeasurementWorkerFailure):
            raise
        raise MeasurementWorkerFailure(active_role, str(error)) from error
    finally:
        for session in sessions.values():
            child = session["child"]
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for session in sessions.values():
            child = session["child"]
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            for stream in (child.stdin, child.stdout, child.stderr, session["stdout"], session["stderr"]):
                if stream and not stream.closed:
                    stream.close()
        selector.close()
        signal.signal(signal.SIGTERM, previous)



def calibrate(contract_path, source_path, contract, case, *, timeout, output_bytes, policy):
    """Per-case tolerance from actual reference observations, plus the two
    self-checks published tolerance work treats as mandatory: a tolerance hole
    (atol large relative to the reference magnitude lets a degenerate output
    through) and, when an independent golden exists, the reference error ratio."""
    tolerance = contract.SPEC["tolerance"]
    reference_result = run_worker(contract_path, source_path, "reference", case, timeout=timeout,
                                  output_bytes=output_bytes, repeats=tolerance.get("repeats", 1))
    reference = reference_result["outputs"]
    expected = reference[0]
    golden = None
    if tolerance["mode"] == "reference-error":
        golden = run_worker(contract_path, source_path, "golden", case, timeout=timeout, output_bytes=output_bytes)["outputs"][0]
        expected = golden
    errors = [compare(item, expected, 0, 0) for item in reference]
    if any(error["errors"] and any(v["kind"] != "numerical" for v in error["errors"]) for error in errors):
        raise ValueError("reference changed output structure/type during calibration")
    observed = [item["maxAbs"] for item in errors]
    atol = tolerance["atol"] if tolerance["mode"] == "fixed" else \
        max(observed) + tolerance["sigmaMultiplier"] * statistics.pstdev(observed)
    magnitude = leaf_magnitude(expected)
    ratio = None if atol <= 0 else (magnitude / atol if magnitude is not None else 0.0)
    calibration = {"mode": tolerance["mode"], "atol": atol, "rtol": tolerance["rtol"],
                   "referenceMaxAbsoluteErrors": observed, "referenceMeanMagnitude": magnitude,
                   "magnitudeToAtol": ratio,
                   # A near-zero reference under an absolute tolerance cannot
                   # separate a real implementation from one that returns zero.
                   "toleranceAdequate": ratio is None or ratio >= policy["toleranceMagnitudeRatio"] or tolerance["rtol"] > 0}
    if golden is not None:
        reference_error = max(observed)
        calibration["goldenReferenceError"] = reference_error
    return {"expected": expected, "calibration": calibration, "logs": reference_result["workerLogs"],
            "goldenExpected": golden, "referenceError": max(observed) if golden is not None else None}


def oracle_verdict(case, comparison):
    """Deterministic elementwise judgement, or a declared matched-ratio for
    low-precision operators whose elementwise equality is not the contract."""
    if case.get("oracle", "deterministic") == "deterministic":
        return comparison["passed"], None
    matched = 1.0 - (comparison["mismatchRatio"] or 0.0)
    return matched >= case["matchedRatio"], matched


def error_ratio(candidate_comparison, reference_error):
    """rho: candidate-versus-golden error over reference-versus-golden error."""
    if reference_error is None or reference_error <= 0:
        return None
    return candidate_comparison["maxAbs"] / reference_error


def check_case(contract_path, source_path, contract, case, *, timeout, output_bytes, policy):
    """Correctness for one declared case: hidden value-only variants, a
    validity gate on the known-correct baselines, repeat determinism, no-op
    sensitivity and runtime evidence that the replaced library was not called."""
    row = {"caseId": case["id"], "scope": case["scope"], "axes": case["axes"], "passed": False}
    variants = []
    row["variants"] = variants
    rejected = duplicates = 0
    for variant in case_variants(case):
        entry = {"variantId": variant["variantId"], "accepted": False}
        variants.append(entry)
        if variant.get("duplicate"):
            entry["skipped"] = "this value-only transform leaves the declared input unchanged"
            duplicates += 1
            continue
        try:
            calibrated = calibrate(contract_path, source_path, contract, variant["case"],
                                   timeout=timeout, output_bytes=output_bytes, policy=policy)
        except Exception as error:
            # A transform the reference itself cannot evaluate is not a candidate
            # failure; it is an invalid input and is dropped before judging.
            entry["skipped"] = f"reference could not evaluate this variant: {error}"
            rejected += 1
            continue
        calibration = calibrated["calibration"]
        entry["calibration"] = calibration
        if not calibration["toleranceAdequate"]:
            entry["skipped"] = "declared tolerance cannot separate a degenerate output at this reference magnitude"
            rejected += 1
            continue
        if variant["variantId"] != PERTURBATIONS[0][0]:
            # Validity gate for host-derived inputs only: the declared case is
            # the contract's own reference point, and a named baseline that
            # disagrees there is judged by the measurement stage instead.
            validity, unavailable = {}, {}
            for name in contract.baselines:
                try:
                    observed = run_worker(contract_path, source_path, "baseline:" + name, variant["case"],
                                          timeout=timeout, output_bytes=output_bytes)["outputs"][0]
                except Exception as error:
                    unavailable[name] = str(error)
                    continue
                checked = compare(observed, calibrated["expected"], calibration["atol"], calibration["rtol"])
                validity[name] = oracle_verdict(variant["case"], checked)[0]
            entry["validityGate"] = validity
            if unavailable:
                entry["validityGateUnavailable"] = unavailable
            if validity and not all(validity.values()):
                # A derived input that rejects a known-correct implementation is
                # the input's defect, not the candidate's.
                entry["skipped"] = "variant rejects a known-correct declared baseline"
                rejected += 1
                continue
        entry["accepted"] = True
        candidate_result = run_worker(contract_path, source_path, "candidate", variant["case"],
                                      timeout=timeout, output_bytes=output_bytes, repeats=policy["determinismRepeats"])
        entry["candidateLogs"] = candidate_result["workerLogs"]
        outputs = candidate_result["outputs"]
        entry["determinism"] = {"repeats": len(outputs),
                                "identical": all(item == outputs[0] for item in outputs)}
        comparisons = [compare(item, calibrated["expected"], calibration["atol"], calibration["rtol"]) for item in outputs]
        verdicts = [oracle_verdict(variant["case"], item) for item in comparisons]
        entry["comparisons"] = comparisons
        entry["matchedRatios"] = [item[1] for item in verdicts if item[1] is not None]
        rho = error_ratio(comparisons[0], calibrated["referenceError"])
        if rho is not None:
            entry["referenceErrorRatio"] = rho
        if variant["case"].get("bitExact"):
            # Two paths the task declares equivalent are compared bit for bit:
            # a tolerance can hide a real divergence between them.
            twin = run_worker(contract_path, source_path, "baseline:" + variant["case"]["bitExact"], variant["case"],
                              timeout=timeout, output_bytes=output_bytes)["outputs"][0]
            entry["bitExact"] = {"baseline": variant["case"]["bitExact"], "identical": twin == outputs[0]}
        entry["passed"] = all(item[0] for item in verdicts) and entry["determinism"]["identical"] and \
            (rho is None or rho <= policy["referenceErrorRatioLimit"]) and \
            entry.get("bitExact", {"identical": True})["identical"]
        try:
            noop_result = run_worker(contract_path, source_path, "noop", variant["case"],
                                     timeout=timeout, output_bytes=output_bytes)
            entry["noopLogs"] = noop_result["workerLogs"]
            entry["noop"] = compare(noop_result["outputs"][0], calibrated["expected"], calibration["atol"], calibration["rtol"])
            entry["noopSensitive"] = not oracle_verdict(variant["case"], entry["noop"])[0]
        except Exception as error:
            # An unavailable ghost replay is an unfinished check, never a pass.
            entry["noop"] = {"passed": None, "inconclusive": True, "error": str(error)}
            entry["noopSensitive"] = None
    accepted = [item for item in variants if item["accepted"]]
    row["acceptedVariants"] = len(accepted)
    row["rejectedVariants"] = rejected
    row["duplicateVariants"] = duplicates
    if not accepted:
        row["inconclusive"] = True
        row["error"] = "no declared or hidden variant of this case is decidable"
        row["failureRole"] = "case-validity"
        return row
    instrumented = run_worker(contract_path, source_path, "instrumented", case,
                              timeout=timeout, output_bytes=output_bytes)
    row["replacedApiCalls"] = instrumented["replacedApiCalls"]
    row["instrumentedLogs"] = instrumented["workerLogs"]
    row["replacedApiClean"] = all(count == 0 for count in instrumented["replacedApiCalls"].values())
    # Degenerate cases cannot distinguish a real implementation from a no-op in
    # any accepted variant; they stay recorded but decide nothing.
    row["degenerate"] = not any(item["noopSensitive"] for item in accepted)
    row["noopComplete"] = all(type(item["noopSensitive"]) is bool for item in accepted)
    row["correctnessOnly"] = all(all(verdict["passed"] for verdict in item["comparisons"]) for item in accepted)
    row["passed"] = all(item["passed"] for item in accepted) and row["replacedApiClean"]
    row["calibration"] = accepted[0]["calibration"]
    return row


def paired_decision(case, candidate_samples, baseline_samples, ratios, tier, policy):
    """Variance-adaptive keep threshold with an explicit tie band, plus the
    guardrails that stop a physically implausible ratio from being believed."""
    candidate_median = statistics.median(candidate_samples)
    baseline_median = statistics.median(baseline_samples)
    ratio_median = statistics.median(ratios)
    cv = dispersion(ratios)
    threshold = 1 + max(policy["minimumImprovementFloor"],
                        policy["minimumImprovementDispersionFactor"] * (cv or 0.0))
    decision = {"tier": tier, "candidateMedianSeconds": candidate_median, "baselineMedianSeconds": baseline_median,
                "pairedRatioMedian": ratio_median, "pairedRatioDispersion": cv,
                "candidateDispersion": dispersion(candidate_samples), "baselineDispersion": dispersion(baseline_samples),
                "minimumImprovementThreshold": threshold,
                "dispersionWithinReportedLimit": (dispersion(candidate_samples) or 0.0) <= REPORTED_DISPERSION_LIMIT and
                                                 (dispersion(baseline_samples) or 0.0) <= REPORTED_DISPERSION_LIMIT}
    if ratio_median * threshold <= 1:
        decision["verdict"] = "faster"
    elif ratio_median >= threshold:
        decision["verdict"] = "slower"
    else:
        decision["verdict"] = "tie"
    if ratio_median <= policy["quarantineRatio"]:
        decision["verdict"] = "quarantined"
        decision["reason"] = "ratio implies an implausible speedup; this candidate needs out-of-band review before any claim"
    elif ratio_median <= policy["confirmRatio"]:
        decision["needsConfirmation"] = True
    if case["scope"] == "end-to-end" and decision["verdict"] != "quarantined":
        decision["endToEndAdmissible"] = ratio_median <= policy["endToEndNoiseMargin"]
    return decision


def measure_case(contract_path, source_path, contract, case, *, timeout, output_bytes, policy):
    """Interleaved paired timing for one case, then host decisions on it."""
    spec = contract.SPEC
    row = {"caseId": case["id"], "scope": case["scope"], "axes": case["axes"], "passed": False}
    calibrated = calibrate(contract_path, source_path, contract, case, timeout=timeout,
                           output_bytes=output_bytes, policy=policy)
    calibration = calibrated["calibration"]
    row["calibration"] = calibration
    measured = measure_workers(contract_path, source_path, case, contract, timeout=timeout, output_bytes=output_bytes)
    actual = measured["candidate"]
    row["measurementOrder"] = measured["order"]
    row["measurementRounds"] = spec["timing"]["repeats"]
    row["candidateLogs"] = actual["workerLogs"]
    comparisons = [compare(item, calibrated["expected"], calibration["atol"], calibration["rtol"]) for item in actual["outputs"]]
    row["comparisons"] = comparisons
    row["passed"] = all(oracle_verdict(case, item)[0] for item in comparisons)
    row["samplesSeconds"] = actual["samplesSeconds"]
    valid_samples = lambda values: isinstance(values, list) and len(values) == spec["timing"]["repeats"] and \
        all(type(value) in (int, float) and math.isfinite(value) and value > 0 for value in values)
    row["measurementValid"] = not actual.get("measurementError") and valid_samples(actual["samplesSeconds"])
    if actual.get("measurementError"):
        row["measurementError"] = actual["measurementError"]
    row["baselines"] = {}
    row["baselineValid"] = True
    row["decisions"] = {}
    for name in contract.baselines:
        baseline = measured["baseline:" + name]
        samples = baseline["samplesSeconds"]
        checked = [compare(item, calibrated["expected"], calibration["atol"], calibration["rtol"]) for item in baseline["outputs"]]
        measurement_error = baseline.get("measurementError")
        samples_valid = valid_samples(samples)
        ratios = [candidate / value for candidate, value in zip(row["samplesSeconds"], samples)] \
            if row["measurementValid"] and samples_valid else None
        if ratios is not None and not all(math.isfinite(value) and value > 0 for value in ratios):
            ratios = None
            measurement_error = "paired candidate/baseline ratio is not finite positive"
        row["baselines"][name] = {"samplesSeconds": samples, "comparisons": checked,
                                  "workerLogs": baseline["workerLogs"], "measurementError": measurement_error,
                                  "pairedCandidateToBaselineRatios": ratios}
        if measurement_error or not samples_valid or not all(oracle_verdict(case, item)[0] for item in checked):
            row["baselineValid"] = False
            continue
        if ratios is not None:
            row["decisions"][name] = paired_decision(case, row["samplesSeconds"], samples, ratios,
                                                     spec["baselineTiers"][name], policy)
    if any(decision.get("needsConfirmation") for decision in row["decisions"].values()):
        # A large speedup is remeasured under the same protocol before it is
        # believed; two independent runs must agree closely.
        repeat = measure_workers(contract_path, source_path, case, contract, timeout=timeout, output_bytes=output_bytes)
        row["confirmationOrder"] = repeat["order"]
        for name, decision in row["decisions"].items():
            if not decision.get("needsConfirmation"):
                continue
            samples = repeat["candidate"]["samplesSeconds"]
            baseline_samples = repeat["baseline:" + name]["samplesSeconds"]
            if not (valid_samples(samples) and valid_samples(baseline_samples)):
                decision["confirmed"] = False
                decision["confirmationReason"] = "remeasurement did not produce complete valid samples"
                continue
            repeated = statistics.median([candidate / value for candidate, value in zip(samples, baseline_samples)])
            decision["confirmationRatioMedian"] = repeated
            decision["confirmed"] = abs(repeated - decision["pairedRatioMedian"]) <= \
                policy["confirmAgreement"] * decision["pairedRatioMedian"]
            if not decision["confirmed"]:
                decision["confirmationReason"] = "the two measurement runs disagree beyond the frozen agreement band"
    # Below the declared floor a timing difference is noise; such a case is
    # recorded but never used to choose between candidates.
    medians = [statistics.median(row["samplesSeconds"])] if row["measurementValid"] else []
    medians += [statistics.median(value["samplesSeconds"]) for value in row["baselines"].values()
                if valid_samples(value["samplesSeconds"])]
    row["performanceDecidable"] = bool(medians) and row["measurementValid"] and row["baselineValid"] and \
        min(medians) >= spec["timing"]["minimumSampleSeconds"]
    if medians and min(medians) < spec["timing"]["minimumSampleSeconds"]:
        row["performanceUndecidableReason"] = "shortest measured median is below the declared minimum measurable duration"
    row["orderingStability"] = ordering_stability(row)
    return row


def ordering_stability(row):
    """Per-round rank agreement against the first round, plus the flip rate:
    a candidate whose ordering against a baseline is unstable across rounds has
    not been shown faster, however clean its medians look."""
    names = [name for name, value in row["baselines"].items()
             if value.get("pairedCandidateToBaselineRatios")]
    if not names:
        return None
    rounds = len(row["baselines"][names[0]]["pairedCandidateToBaselineRatios"])
    orders = [[1.0] + [row["baselines"][name]["pairedCandidateToBaselineRatios"][index] for name in names]
              for index in range(rounds)]
    taus = [kendall_tau_b(orders[0], orders[index]) for index in range(1, rounds)]
    flips = sum(1 for index in range(1, rounds) for position in range(1, len(names) + 1)
                if (orders[0][position] < 1) != (orders[index][position] < 1))
    return {"roles": ["candidate"] + names, "rounds": rounds,
            "kendallTauBMedian": statistics.median(taus) if taus and all(value is not None for value in taus) else None,
            "pairwiseFlipRate": flips / ((rounds - 1) * len(names)) if rounds > 1 else None}


def aggregate(results):
    """Report rate, successful-only and whole-set numbers together; ratios use
    the geometric mean and the median, never the arithmetic mean."""
    report = {}
    for name in {name for row in results for name in row.get("decisions", {})}:
        ratios = [row["decisions"][name]["pairedRatioMedian"] for row in results
                  if row.get("performanceDecidable") and name in row.get("decisions", {})]
        faster = [row for row in results if row.get("performanceDecidable") and
                  row.get("decisions", {}).get(name, {}).get("verdict") == "faster"]
        speedups = [1 / value for value in ratios]
        report[name] = {"decidableCases": len(ratios), "declaredCases": len(results),
                        "fasterCases": len(faster),
                        "successRate": len(faster) / len(results) if results else None,
                        "geometricMeanSpeedupAllDecidable":
                            math.exp(statistics.fmean([math.log(value) for value in speedups])) if speedups else None,
                        "medianSpeedupAllDecidable": statistics.median(speedups) if speedups else None,
                        "geometricMeanSpeedupFasterOnly":
                            math.exp(statistics.fmean([math.log(1 / row["decisions"][name]["pairedRatioMedian"])
                                                       for row in faster])) if faster else None}
    return report


def iteration_cases(spec):
    """Cases the candidate's own cascade may use. Certification cases stay out
    of every receipt it can read and are only spent by `--certify`."""
    return [case for case in spec["cases"] if case.get("set", "iteration") == "iteration"]


def task_audit(contract_path, contract):
    """Audit the task itself, not a candidate: a reference whose output is
    constant, nearly zero or insensitive to its input cannot grade anything,
    and a reference that disagrees with its own higher-precision golden is not
    adjudicable. These are properties of the problem, so they are checked once."""
    spec = contract.SPEC
    policy = decision_policy(spec)
    timeout, output_bytes = spec["workerTimeoutSeconds"], spec["workerOutputBytes"]
    rows = []
    for case in spec["cases"]:
        row = {"caseId": case["id"], "set": case.get("set", "iteration")}
        try:
            outputs = {}
            for variant in case_variants(case):
                if variant.get("duplicate"):
                    continue
                try:
                    outputs[variant["variantId"]] = run_worker(contract_path, "", "reference", variant["case"],
                                                               timeout=timeout, output_bytes=output_bytes)["outputs"][0]
                except Exception as error:
                    row.setdefault("unevaluableVariants", {})[variant["variantId"]] = str(error)
            declared = outputs.get(PERTURBATIONS[0][0])
            leaves = []

            def collect(value):
                if isinstance(value, bool):
                    return
                if isinstance(value, (int, float)):
                    leaves.append(float(value))
                elif isinstance(value, list):
                    for item in value:
                        collect(item)
                elif isinstance(value, dict):
                    for item in value.values():
                        collect(item)

            collect(declared)
            row["outputLeaves"] = len(leaves)
            row["outputRange"] = max(leaves) - min(leaves) if leaves else None
            row["outputStdev"] = statistics.pstdev(leaves) if len(leaves) > 1 else 0.0
            row["meanMagnitude"] = statistics.fmean([abs(value) for value in leaves]) if leaves else None
            # Insensitive to its input: every value-only variant reproduces the
            # declared output, so no implementation can be told apart by it.
            row["inputSensitive"] = any(value != declared for key, value in outputs.items() if key != PERTURBATIONS[0][0])
            if callable(getattr(contract, "golden", None)):
                golden = run_worker(contract_path, "", "golden", case, timeout=timeout, output_bytes=output_bytes)["outputs"][0]
                row["referenceVersusGolden"] = compare(declared, golden, 0, 0)["mismatches"]
            row["degenerateByRule"] = [name for name, failed in (
                ("near-constant-output", (row["outputRange"] or 0.0) < 0.01),
                ("near-zero-variance", row["outputStdev"] < 0.01),
                ("insensitive-to-input", not row["inputSensitive"]),
            ) if failed]
        except Exception as error:
            row["error"] = str(error)
        rows.append(row)
    return {"cases": rows, "policy": policy,
            "degenerateCases": [row["caseId"] for row in rows if row.get("degenerateByRule")]}


def correctness(contract_path, source_path, contract, measure=False, cases=None):
    spec = contract.SPEC
    policy = decision_policy(spec)
    timeout = spec["workerTimeoutSeconds"]
    output_bytes = spec["workerOutputBytes"]
    results = []
    for case in (iteration_cases(spec) if cases is None else cases):
        try:
            row = measure_case(contract_path, source_path, contract, case, timeout=timeout, output_bytes=output_bytes, policy=policy) \
                if measure else check_case(contract_path, source_path, contract, case, timeout=timeout, output_bytes=output_bytes, policy=policy)
        except Exception as error:
            row = {"caseId": case["id"], "scope": case["scope"], "axes": case["axes"], "passed": False,
                   "error": str(error),
                   "failureRole": error.role if isinstance(error, MeasurementWorkerFailure) else
                                  ("measurement" if measure else "candidate")}
            if measure:
                row["measurementValid"] = False
                row["baselineValid"] = False
                row["performanceDecidable"] = False
                if isinstance(error, MeasurementWorkerFailure) and error.role.startswith("baseline:"):
                    # A failed named baseline is unavailable performance evidence,
                    # not a candidate error; the passed predecessor correctness
                    # stage is rechecked by the host journal verifier.
                    row["passed"] = True
                    row["correctnessFromPreviousStage"] = True
        results.append(row)
    verdict = (measurement_verdict if measure else correctness_verdict)(results, spec)
    verdict["decisionPolicy"] = policy
    return verdict


def correctness_verdict(results, spec):
    deciding = [row for row in results if not row.get("degenerate", True) and not row.get("inconclusive")]
    failed = [row for row in results if not row["passed"]]
    # A candidate-role failure is a definite failure. Anything the host could
    # not finish checking is inconclusive, and a suite with nothing left that
    # can tell a real implementation from a no-op cannot report success.
    inconclusive = any(row.get("error") and row.get("failureRole") != "candidate" for row in results) or \
        (not failed and (not deciding or any(not row.get("noopComplete", False) for row in results)))
    integrity = {"declaredCases": len(results),
                 "decidingCases": len(deciding),
                 "degenerateCases": sum(1 for row in results if row.get("degenerate")),
                 "rejectedVariants": sum(row.get("rejectedVariants", 0) for row in results),
                 "nondeterministicCases": sum(1 for row in results
                                              if any(not item.get("determinism", {}).get("identical", True)
                                                     for item in row.get("variants", []))),
                 "replacedApiCases": sum(1 for row in results if row.get("replacedApiClean") is False),
                 # The gap between these two is this run's cheating signal.
                 "passedWithFunctionalChecks": not failed and not inconclusive,
                 "passedWithNumericComparisonOnly": all(row.get("correctnessOnly", False) for row in results)}
    return {"cases": results, "integrity": integrity,
            "noopDetected": bool(deciding),
            "inconclusive": inconclusive,
            "correctnessPassed": not failed,
            "measurementComparable": None,
            "passed": not failed and not inconclusive}


def measurement_verdict(results, spec):
    decidable = [row for row in results if row.get("performanceDecidable")]
    correct = bool(results) and all(row["passed"] for row in results)
    end_to_end = [row for row in decidable if row["scope"] == "end-to-end"]
    admissible = bool(end_to_end) and all(decision.get("endToEndAdmissible") is True
                                          for row in end_to_end for decision in row["decisions"].values())
    quarantined = [row["caseId"] for row in decidable
                   for decision in row["decisions"].values() if decision["verdict"] == "quarantined"]
    unconfirmed = [row["caseId"] for row in decidable
                   for decision in row["decisions"].values() if decision.get("confirmed") is False]
    comparable = correct and bool(decidable) and admissible and not quarantined and not unconfirmed and \
        all(row.get("baselineValid") and row.get("measurementValid") for row in decidable)
    reasons = []
    if not decidable:
        reasons.append("no declared case produced a decidable measurement")
    if decidable and not end_to_end:
        reasons.append("no end-to-end case is decidable; isolated kernel timing cannot accept a candidate")
    if end_to_end and not admissible:
        reasons.append("an end-to-end case is slower than its baseline beyond the frozen noise margin")
    if quarantined:
        reasons.append("quarantined implausible speedup: " + ", ".join(sorted(set(quarantined))))
    if unconfirmed:
        reasons.append("large speedup did not reproduce on remeasurement: " + ", ".join(sorted(set(unconfirmed))))
    return {"cases": results, "aggregate": aggregate(results),
            "measurementNotComparable": reasons,
            "noopDetected": None,
            "inconclusive": any(row.get("error") for row in results) or (correct and not comparable),
            "correctnessPassed": correct, "measurementComparable": comparable,
            "passed": correct and comparable}


def main():
    global WORKER_OPTIONS
    if sys.argv[1] == "--worker-loop":
        for line in sys.stdin:
            payload = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = worker(sys.argv[2], sys.argv[3], sys.argv[4], payload)
            print(json.dumps(result, allow_nan=False), flush=True)
        return
    if sys.argv[1] == "--worker":
        payload = json.loads(pathlib.Path(sys.argv[6]).read_text()) if len(sys.argv) > 6 and sys.argv[5] == "--worker-input" else json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            result = worker(sys.argv[2], sys.argv[3], sys.argv[4], payload)
        print(json.dumps(result, allow_nan=False))
        return
    if sys.argv[1] == "--goal-capability":
        contract = load(str(pathlib.Path(sys.argv[2]).resolve()), "trusted_operator_contract")
        spec = validate(contract)
        value = getattr(contract, "verify_goal", None)
        if value is not None and not callable(value):
            raise ValueError("host contract verify_goal must be callable")
        print(json.dumps({"configured": callable(value), "workerTimeoutSeconds": spec["workerTimeoutSeconds"],
                          "workerOutputBytes": spec["workerOutputBytes"],
                          "measurementEnvironment": spec["measurementEnvironment"]}))
        return
    if sys.argv[1] == "--case-input":
        # The host needs the exact declared input to profile one case, but that
        # input must never travel through a receipt the candidate context reads.
        contract = load(str(pathlib.Path(sys.argv[2]).resolve()), "trusted_operator_contract")
        spec = validate(contract)
        selected = [case for case in iteration_cases(spec) if case["id"] == sys.argv[3]]
        if len(selected) != 1:
            raise ValueError("host profiler case is absent from the task contract")
        payload = json.dumps({"case": selected[0], "measure": True,
                              "compiledBuildDir": sys.argv[5] or None}, allow_nan=False)
        pathlib.Path(sys.argv[4]).write_text(payload)
        print(json.dumps({"caseId": selected[0]["id"], "scope": selected[0]["scope"],
                          "bytes": len(payload.encode())}))
        return
    if sys.argv[1] == "--mutation-report":
        # Score the checker itself: every declared fault must be rejected by the
        # same cascade a candidate goes through. An undetected mutant is a hole
        # in these checks, not a property of any candidate.
        contract_path = str(pathlib.Path(sys.argv[2]).resolve())
        WORKER_OPTIONS = json.loads(pathlib.Path(sys.argv[3]).read_text())
        bind_controller_environment()
        contract = load(contract_path, "trusted_operator_contract")
        validate(contract)
        mutants = getattr(contract, "MUTANTS", {})
        results = []
        for name, item in mutants.items():
            source = item["source"]
            mutant_dir = tempfile.mkdtemp(prefix="mutant-", dir=WORKER_OPTIONS["scratchRoot"])
            mutant_path = str(pathlib.Path(mutant_dir) / "candidate.py")
            pathlib.Path(mutant_path).write_text(source)
            entry = {"name": name, "family": item["family"]}
            try:
                entry["static"] = not api_contract(source, contract)["inconclusive"]
            except Exception as error:
                entry["static"] = False
                entry["staticRejection"] = str(error)
            if entry["static"]:
                verdict = correctness(contract_path, mutant_path, contract, cases=contract.SPEC["cases"])
                entry["correctnessPassed"] = verdict["passed"]
                entry["inconclusive"] = verdict["inconclusive"]
                entry["integrity"] = verdict["integrity"]
            entry["detected"] = not entry["static"] or not entry["correctnessPassed"]
            results.append(entry)
        detected = sum(1 for item in results if item["detected"])
        families = {}
        for family in FAULT_FAMILIES:
            planted = [item for item in results if item["family"] == family]
            if planted:
                families[family] = {"declared": len(planted),
                                    "detected": sum(1 for item in planted if item["detected"]),
                                    "escapeRate": sum(1 for item in planted if not item["detected"]) / len(planted)}
        print(json.dumps({"version": 1, "kind": "local-operator-mutation-report",
                          "protocolId": contract.SPEC["protocolId"], "mutants": results,
                          "declared": len(results), "detected": detected,
                          "detectionRate": detected / len(results) if results else None,
                          "families": families,
                          "taskAudit": task_audit(contract_path, contract),
                          "limitation": "Detection rate is measured only against the faults this contract declares; "
                                        "it is not an estimate of the escape rate for faults nobody wrote down."},
                         allow_nan=False))
        return
    if sys.argv[1] == "--certify":
        # The certification set is spent once, by the host, on an already
        # accepted candidate. Its results never travel back into iteration.
        contract_path = str(pathlib.Path(sys.argv[2]).resolve())
        WORKER_OPTIONS = json.loads(pathlib.Path(sys.argv[3]).read_text())
        bind_controller_environment()
        contract = load(contract_path, "trusted_operator_contract")
        spec = validate(contract)
        source_path = str(pathlib.Path(sys.argv[4]).resolve())
        verdict = correctness(contract_path, source_path, contract, cases=spec["cases"])
        decidable = [row for row in verdict["cases"] if not row.get("inconclusive")]
        passed = [row for row in decidable if row["passed"]]
        print(json.dumps({"version": 1, "kind": "local-operator-certification",
                          "protocolId": spec["protocolId"],
                          "iterationCases": len(iteration_cases(spec)),
                          "certificationCases": sum(1 for case in spec["cases"] if case.get("set") == "certification"),
                          "cases": [{"caseId": row["caseId"], "set": next(case.get("set", "iteration")
                                                                          for case in spec["cases"] if case["id"] == row["caseId"]),
                                     "scope": row["scope"], "passed": row["passed"],
                                     "degenerate": row.get("degenerate"), "inconclusive": bool(row.get("inconclusive"))}
                                    for row in verdict["cases"]],
                          # Conditional on the case being decidable at all: a case whose
                          # own reference or baselines cannot judge it says nothing here.
                          "decidableCases": len(decidable), "passedCases": len(passed),
                          "conditionalCorrectness": len(passed) / len(decidable) if decidable else None,
                          "passed": bool(decidable) and len(passed) == len(decidable),
                          "limitation": "Full-coverage revalidation of one already accepted candidate. It does not "
                                        "re-time anything and makes no performance claim."},
                         allow_nan=False))
        return
    if sys.argv[1] == "--verify-goal":
        contract_path = str(pathlib.Path(sys.argv[2]).resolve())
        WORKER_OPTIONS = json.loads(pathlib.Path(sys.argv[3]).read_text())
        bind_controller_environment()
        request = json.loads(pathlib.Path(sys.argv[4]).read_text())
        contract = load(contract_path, "trusted_operator_contract")
        spec = validate(contract)
        if not callable(getattr(contract, "verify_goal", None)):
            raise ValueError("host contract has no verify_goal; goal verification is unconfigured")
        result = run_worker(contract_path, "", "goal", request, timeout=spec["workerTimeoutSeconds"],
                            output_bytes=spec["workerOutputBytes"])
        print(json.dumps(result["goalChecks"], allow_nan=False))
        return
    contract_path = str(pathlib.Path(sys.argv[1]).resolve())
    WORKER_OPTIONS = json.loads(pathlib.Path(sys.argv[2]).read_text())
    bind_controller_environment()
    request = json.loads(sys.stdin.readline())
    stage = request["stage"]["id"]
    receipt = {"version": 1, "kind": "local-operator-evaluation", "identity": request["identity"],
               "protocolId": request["protocolId"], "stage": stage, "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "contractPath": contract_path, "passed": False}
    # The contract's bytes bind the receipt, but its text must not travel in one:
    # it holds the declared inputs, the reference implementation and the
    # certification set the candidate is never allowed to see.
    receipt["contractSha256"] = hashlib.sha256(pathlib.Path(contract_path).read_bytes()).hexdigest()
    try:
        contract = load(contract_path, "trusted_operator_contract")
        spec = validate(contract)
        if request["protocolId"] != spec["protocolId"] or len(request["sources"]) != 1:
            raise ValueError("protocol mismatch or source count other than one Python module")
        source_path = request["sources"][0]["frozenPath"]
        source = pathlib.Path(source_path).read_text()
        # Input-blind receipts: the candidate context may learn which cases
        # exist and what they cover, never their values or the reference output.
        receipt["caseSummaries"] = [{"id": case["id"], "scope": case["scope"], "axes": case["axes"],
                                     "oracle": case.get("oracle", "deterministic")} for case in iteration_cases(spec)]
        receipt["certificationCases"] = sum(1 for case in spec["cases"] if case.get("set") == "certification")
        receipt["timingProtocol"] = spec["timing"]
        receipt["measurementEnvironment"] = spec["measurementEnvironment"]
        receipt["baselineTiers"] = spec["baselineTiers"]
        receipt["hiddenVariants"] = [name for name, _ in PERTURBATIONS]
        if stage == "measurement":
            receipt["timingExecution"] = TIMING_EXECUTION
        receipt["compilationScope"] = "task-native-and-python" if callable(getattr(contract, "compile_candidate", None)) else "python-only"
        if WORKER_OPTIONS.get("compiledBuildDir"):
            receipt["compiledBuildDir"] = WORKER_OPTIONS["compiledBuildDir"]
        if stage == "contract":
            try:
                parameters = request.get("config", {}).get("parameters", {})
                receipt["parameterValidation"] = validate_task_parameters(contract, parameters)
            except Exception:
                receipt["inconclusive"] = True
                raise
            if receipt["parameterValidation"]["valid"]:
                receipt["api"] = api_contract(source, contract)
                receipt["inconclusive"] = receipt["api"]["inconclusive"]
                receipt["passed"] = not receipt["inconclusive"]
        elif stage == "compile":
            compile(source, source_path, "exec")
            if callable(getattr(contract, "compile_candidate", None)):
                try:
                    compiled = run_worker(contract_path, source_path, "compile", None,
                                          timeout=spec["workerTimeoutSeconds"], output_bytes=spec["workerOutputBytes"])
                    receipt["nativeCompilation"] = compiled["nativeCompilation"]
                    receipt["compilerLogs"] = compiled["workerLogs"]
                    receipt["passed"] = compiled["nativeCompilation"]["passed"]
                except WorkerFailure:
                    receipt["inconclusive"] = True
                    raise
            else:
                receipt["passed"] = True
        elif stage in ("correctness", "measurement"):
            receipt.update(correctness(contract_path, source_path, contract, stage == "measurement"))
        else:
            raise ValueError("unknown stage")
    except Exception as error:
        receipt["error"] = str(error)
        receipt["traceback"] = traceback.format_exc()
    output = pathlib.Path(request["outputDir"]) / "evaluation.json"
    output.write_text(json.dumps(receipt, allow_nan=False, indent=2) + "\n")
    print(json.dumps({"version": 1, "kind": "result", "status": "passed" if receipt["passed"] else "failed",
                      "performedChecks": request["stage"]["checks"], "receiptPaths": ["evaluation.json"],
                      "evaluationReceiptPaths": ["evaluation.json"], "summary": f"{stage}: {'passed' if receipt['passed'] else 'failed'}; exact task contract and raw diagnostics retained"}))


if __name__ == "__main__":
    main()
