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
    errors = []
    max_abs = max_rel = 0.0
    count = mismatches = 0

    def visit(a, b, location):
        nonlocal max_abs, max_rel, count, mismatches
        if isinstance(b, dict):
            if not isinstance(a, dict) or set(a) != set(b):
                errors.append({"location": location, "kind": "keys", "expected": list(b), "actual": list(a) if isinstance(a, dict) else type(a).__name__})
                return
            for key in b:
                visit(a[key], b[key], f"{location}.{key}")
        elif isinstance(b, list):
            if not isinstance(a, list) or len(a) != len(b):
                errors.append({"location": location, "kind": "shape", "expected": len(b), "actual": len(a) if isinstance(a, list) else type(a).__name__})
                return
            for i, item in enumerate(b):
                visit(a[i], item, f"{location}[{i}]")
        else:
            count += 1
            if isinstance(a, (list, dict)) or isinstance(a, bool) != isinstance(b, bool):
                mismatches += 1
                errors.append({"location": location, "kind": "type"})
                return
            if isinstance(b, bool):
                if a is not b:
                    mismatches += 1
                    errors.append({"location": location, "kind": "boolean", "actual": a, "expected": b})
                return
            difference = abs(a - b)
            relative = difference / abs(b) if b else (0.0 if difference == 0 else None)
            max_abs = max(max_abs, difference)
            if relative is not None:
                max_rel = max(max_rel, relative)
            if difference > atol + rtol * abs(b):
                mismatches += 1
                errors.append({"location": location, "kind": "numerical", "actual": a, "expected": b, "absoluteError": difference, "relativeError": relative})

    visit(actual, expected, "output")
    return {"passed": not errors, "maxAbs": max_abs, "maxRelFinite": max_rel,
            "elements": count, "mismatches": mismatches, "errors": errors}


def validate(contract):
    spec = contract.SPEC
    if not isinstance(spec, dict) or not isinstance(spec.get("protocolId"), str) or not spec["protocolId"] or len(spec["protocolId"]) > 160 or "\0" in spec["protocolId"]:
        raise ValueError("SPEC.protocolId is required")
    cases = spec.get("cases")
    if not isinstance(cases, list) or not cases or any(not isinstance(c, dict) or not isinstance(c.get("id"), str) or not c["id"] or len(c["id"]) > 80 or "\0" in c["id"] for c in cases):
        raise ValueError("SPEC.cases must be explicit nonempty JSON case descriptors with unique ids")
    if len({c["id"] for c in cases}) != len(cases):
        raise ValueError("case ids must be unique")
    json.dumps(cases, allow_nan=False)
    if not isinstance(spec.get("kernelSymbol"), str) or not spec["kernelSymbol"].isidentifier():
        raise ValueError("SPEC.kernelSymbol must identify the candidate function to replace for no-op detection")
    if not isinstance(spec.get("allowedImports"), list) or not all(isinstance(v, str) and v for v in spec["allowedImports"]):
        raise ValueError("SPEC.allowedImports must explicitly list allowed module names")
    if not isinstance(spec.get("apiTargets"), list) or not all(isinstance(v, str) and "." in v for v in spec["apiTargets"]):
        raise ValueError("SPEC.apiTargets must explicitly list environment module API names (possibly empty)")
    for name in ("reference", "invoke", "synchronize", "noop"):
        if not callable(getattr(contract, name, None)):
            raise ValueError(f"contract must provide {name}")
    if not isinstance(getattr(contract, "baselines", None), dict) or not contract.baselines or any(not isinstance(k, str) or not k or len(k) > 128 or "\0" in k or not callable(v) for k, v in contract.baselines.items()):
        raise ValueError("contract.baselines must provide named actual callable baselines")
    timing = spec.get("timing", {})
    if type(timing.get("warmup")) is not int or timing["warmup"] < 0 or type(timing.get("repeats")) is not int or timing["repeats"] < 1:
        raise ValueError("task must explicitly choose timing warmup >= 0 and repeats >= 1")
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
        elif role in ("candidate", "noop"):
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


def correctness(contract_path, source_path, contract, measure=False):
    results = []
    tolerance = contract.SPEC["tolerance"]
    timeout = contract.SPEC["workerTimeoutSeconds"]
    output_bytes = contract.SPEC["workerOutputBytes"]
    for case in contract.SPEC["cases"]:
        row = {"caseId": case["id"], "descriptor": case, "passed": False}
        results.append(row)
        phase = "reference"
        try:
            reference_result = run_worker(contract_path, source_path, "reference", case, timeout=timeout, output_bytes=output_bytes, repeats=tolerance.get("repeats", 1))
            row["referenceLogs"] = reference_result["workerLogs"]
            reference = reference_result["outputs"]
            expected = reference[0]
            if tolerance["mode"] == "reference-error":
                expected = run_worker(contract_path, source_path, "golden", case, timeout=timeout, output_bytes=output_bytes)["outputs"][0]
            errors = [compare(item, expected, 0, 0) for item in reference]
            if any(error["errors"] and any(v["kind"] != "numerical" for v in error["errors"]) for error in errors):
                raise ValueError("reference changed output structure/type during calibration")
            observed = [item["maxAbs"] for item in errors]
            atol = tolerance["atol"] if tolerance["mode"] == "fixed" else max(observed) + tolerance["sigmaMultiplier"] * statistics.pstdev(observed)
            row["calibration"] = {"mode": tolerance["mode"], "atol": atol, "rtol": tolerance["rtol"], "referenceMaxAbsoluteErrors": observed}
            phase = "candidate"
            if measure:
                measured = measure_workers(contract_path, source_path, case, contract,
                                           timeout=timeout, output_bytes=output_bytes)
                actual = measured["candidate"]
                row["measurementOrder"] = measured["order"]
                row["measurementRounds"] = contract.SPEC["timing"]["repeats"]
            else:
                actual = run_worker(contract_path, source_path, "candidate", case, timeout=timeout,
                                    output_bytes=output_bytes)
            row["candidateLogs"] = actual["workerLogs"]
            comparisons = [compare(item, expected, atol, tolerance["rtol"]) for item in actual["outputs"]]
            row["comparisons"] = comparisons
            row["passed"] = all(item["passed"] for item in comparisons)
            row["samplesSeconds"] = actual.get("samplesSeconds")
            row["measurementValid"] = measure and not actual.get("measurementError") and \
                len(actual.get("samplesSeconds", [])) == contract.SPEC["timing"]["repeats"] and all(
                type(value) in (int, float) and math.isfinite(value) and value > 0
                for value in actual.get("samplesSeconds", []))
            if actual.get("measurementError"):
                row["measurementError"] = actual["measurementError"]
            # No-op validity is evaluated across the declared suite. Degenerate
            # cases can legitimately remain unchanged, but the suite must reject.
            if not measure:
                try:
                    noop_result = run_worker(contract_path, source_path, "noop", case, timeout=timeout, output_bytes=output_bytes)
                    row["noopLogs"] = noop_result["workerLogs"]
                    noop = noop_result["outputs"][0]
                    row["noop"] = compare(noop, expected, atol, tolerance["rtol"])
                except Exception as error:
                    row["noop"] = {"passed": None, "inconclusive": True, "error": str(error)}
            else:
                row["baselines"] = {}
                row["baselineValid"] = True
                phase = "baseline"
                for name in contract.baselines:
                    baseline = measured["baseline:" + name]
                    baseline_samples = baseline["samplesSeconds"]
                    checked = [compare(item, expected, atol, tolerance["rtol"]) for item in baseline["outputs"]]
                    measurement_error = baseline.get("measurementError")
                    samples_valid = len(baseline_samples) == contract.SPEC["timing"]["repeats"] and all(
                                        type(value) in (int, float) and math.isfinite(value) and value > 0
                                        for value in baseline_samples)
                    paired_ratios = [candidate / baseline for candidate, baseline in zip(row["samplesSeconds"], baseline_samples)] \
                        if row["measurementValid"] and samples_valid else None
                    if paired_ratios is not None and not all(math.isfinite(value) and value > 0 for value in paired_ratios):
                        paired_ratios = None
                        measurement_error = "paired candidate/baseline ratio is not finite positive"
                    row["baselines"][name] = {"samplesSeconds": baseline_samples, "comparisons": checked,
                                              "workerLogs": baseline["workerLogs"],
                                              "measurementError": measurement_error,
                                              "pairedCandidateToBaselineRatios": paired_ratios}
                    if measurement_error or not samples_valid or not all(item["passed"] for item in checked):
                        row["baselineValid"] = False
        except Exception as error:
            row["error"] = str(error)
            row["failureRole"] = error.role if isinstance(error, MeasurementWorkerFailure) else phase
            if measure:
                row["baselineValid"] = False
                row["measurementValid"] = False
                if isinstance(error, MeasurementWorkerFailure) and error.role.startswith("baseline:"):
                    # The passed predecessor correctness stage is checked again
                    # by the host journal verifier. A failed named baseline is
                    # unavailable performance evidence, not a candidate error.
                    row["passed"] = True
                    row["correctnessFromPreviousStage"] = True
    noop_effective = measure or any(row.get("noop", {}).get("passed") is False and not row["noop"].get("error") for row in results)
    noop_complete = measure or all(type(row.get("noop", {}).get("passed")) is bool for row in results)
    correct = bool(results) and all(row["passed"] for row in results)
    comparable = measure and correct and all(row.get("baselineValid", False) and row.get("measurementValid", False) for row in results)
    return {"cases": results, "noopDetected": None if measure else noop_effective,
            "inconclusive": (correct and (not noop_effective or not noop_complete)) or
                any(row.get("error") and (measure or row.get("failureRole") != "candidate") for row in results) or
                (measure and correct and not comparable),
            "correctnessPassed": correct, "measurementComparable": comparable if measure else None,
            "passed": correct and noop_effective and noop_complete and (not measure or comparable)}


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
                          "workerOutputBytes": spec["workerOutputBytes"]}))
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
    receipt["contractSource"] = pathlib.Path(contract_path).read_text()
    try:
        contract = load(contract_path, "trusted_operator_contract")
        spec = validate(contract)
        if request["protocolId"] != spec["protocolId"] or len(request["sources"]) != 1:
            raise ValueError("protocol mismatch or source count other than one Python module")
        source_path = request["sources"][0]["frozenPath"]
        source = pathlib.Path(source_path).read_text()
        receipt["caseDescriptors"] = spec["cases"]
        receipt["timingProtocol"] = spec["timing"]
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
