"""Replay a recorded session through the production code, without a model.

Lot 8 of the context harness (``docs/architecture/context-harness.md``). A
scenario is a session as a model drove it: the tools it called, with which
arguments, what its commands printed. The model is the only part not run.
Everything WorkPilot does between two of its answers is the production code,
called in the order a WorkPilot loop calls it (``core/agent_clients/openai.py``
is the reference; the loops themselves are not driven, lot 1b-ii rewrites
them):

1. the system prompt, from ``system_prompt_segments`` assembled by
   ``harness.domain.layout``, and the tool definitions of the agent type;
2. the first message: the task block every subtask leads with (the coder's
   ``_coding_task_segments``, handed in by the caller), then the subtask;
3. each turn: every tool runs in ``ToolExecutor`` on a project written from
   the scenario, so reads and searches page at the source. A command is not
   run: its recorded output goes through ``_fit_output`` and spills to a file
   like a real one. Each result is then cut by ``truncate_tool_result``, the
   turn goes to the no-progress rule (``harness.domain.progress``), and the
   history to ``compact_messages``, which clears in batches;
4. each request: what every cache shape would serve
   (``harness.domain.evals.PromptCache``), written in that shape's usage
   format and read back by the production reader into a ``UsageLedger``. The
   window is the payable one (``context_mgmt.windows.effective_window``).

A third-party loop (Claude Agent SDK, Codex, OpenCode, Antigravity) runs its
own tools and its own clearing; it is measured by the same ledger, and its
prompt is the same system and task block, which this replay covers.

**Scenario** (``<id>.json``, UTF-8)::

    {
      "format": 1,
      "id": "<the file's stem>",
      "why_this_is_here": "<what the scenario guards, in a sentence or two>",
      "model": "<model id: sizes the payable window>",
      "agent_type": "coder",
      "tool_use_hint": true,
      "effort": "<the effort preamble of the task block>",
      "files": {"<path in the project>": <text>},
      "sessions": [
        {"subtask": <text>,
         "turns": [
           {"text": "<what the model wrote>",
            "calls": [
              {"tool": "read_file", "arguments": {"path": "src/app.py"}},
              {"tool": "run_command", "arguments": {"command": "pytest -q"},
               "output": <text>}]},
           {"text": "<a turn without calls ends the session>"}]}]
    }

A ``<text>`` is a string, or a list of strings and ``{"repeat": n, "line":
"... {n} ..."}`` parts: the line n times, ``{n}`` numbered from 1, each
followed by a newline. A 3,000-line build log stays a few lines of fixture.
A call that carries an ``output`` is not run: ``run_command`` must carry one.
An argument ``"$spill.path"`` or ``"$spill.offset"`` is the file and the
offset named by the last excerpt of a spilled output, as the model reads them.
Each session is a subtask: a new client, a new ledger, the same task.

**Cache profiles** (``profiles.json``): ``{"<name>": {"cache": "token_prefix" |
"blocks" | "none", "min_tokens": n, "step_tokens": n, "usage_format":
"chat_completion" | "split_cache"}}``; the shape is a capability, the format
the one its providers report usage in.

**Baseline** (``<id>.baseline.json``): ``{"scenario": id, "metrics": {...}}``,
the numbers ``replay`` returned when they were last accepted;
``harness.domain.evals.regressions`` compares.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from harness.domain.evals import (
    CachedInput,
    CacheModel,
    CacheShape,
    PromptCache,
    SentRequest,
    prefix_breaks,
    shared_chars,
    tokens,
    tool_result_share,
)
from harness.domain.layout import Segment, Stability, assemble, shared_prefix
from harness.domain.ledger import UsageLedger
from harness.domain.progress import PROGRESS_NUDGE, ProgressTracker, turn_fingerprint
from harness.domain.usage import CallUsage, from_chat_completion, from_split_cache

FORMAT = 1
SPILL_PATH = "$spill.path"
SPILL_OFFSET = "$spill.offset"
# Where the request names the project: replaced, so that a number measured in
# one temporary directory is the number measured in any other.
PROJECT_MARK = "<project>"

# The gap line of ``harness.domain.paging.spill_excerpt``.
_SPILL_GAP = re.compile(r"read_file (?P<path>\S+) with offset=(?P<offset>\d+)\]")

TaskSegments = Callable[[Path, Path, str], list[Segment]]


@dataclass(frozen=True)
class Call:
    tool: str
    arguments: dict[str, Any]
    output: str | None = None  # recorded: the call is not run


@dataclass(frozen=True)
class Turn:
    text: str
    calls: tuple[Call, ...]


@dataclass(frozen=True)
class Session:
    subtask: str
    turns: tuple[Turn, ...]


@dataclass(frozen=True)
class Scenario:
    id: str
    why: str
    model: str
    agent_type: str
    tool_use_hint: bool
    effort: str
    files: dict[str, str]
    sessions: tuple[Session, ...]


@dataclass(frozen=True)
class Profile:
    """A cache shape, and the usage format its providers report it in."""

    cache: CacheModel
    usage_format: str


@dataclass
class Replay:
    """What a replay measured, and what its checks need besides."""

    metrics: dict[str, Any]
    tool_result_cap: int
    largest_tool_result: int
    announced_window: int
    # Every tool call: name, arguments as run, result before the client's cut.
    tool_calls: list[tuple[str, dict[str, Any], str]] = field(default_factory=list)


def _text(spec: Any) -> str:
    if isinstance(spec, str):
        return spec
    if not isinstance(spec, list):
        raise ValueError(f"a text is a string or a list of parts, not {spec!r}")
    parts: list[str] = []
    for part in spec:
        if isinstance(part, str):
            parts.append(part)
        elif isinstance(part, dict) and set(part) == {"repeat", "line"}:
            line = str(part["line"])
            parts.extend(
                line.replace("{n}", str(n)) + "\n"
                for n in range(1, int(part["repeat"]) + 1)
            )
        else:
            raise ValueError(f"a text part is a string or {{repeat, line}}: {part!r}")
    return "".join(parts)


def _call(raw: Mapping[str, Any]) -> Call:
    tool = str(raw["tool"])
    output = _text(raw["output"]) if "output" in raw else None
    if tool == "run_command" and output is None:
        raise ValueError("a recorded run_command carries its output: it is never run")
    return Call(tool, dict(raw.get("arguments") or {}), output)


def load_scenario(path: Path) -> Scenario:
    """A scenario file, checked for shape."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("format") != FORMAT:
        raise ValueError(
            f"{path.name}: format {raw.get('format')!r}, expected {FORMAT}"
        )
    if raw.get("id") != path.stem:
        raise ValueError(f"{path.name}: id {raw.get('id')!r} is not the file's stem")
    sessions = tuple(
        Session(
            _text(session["subtask"]),
            tuple(
                Turn(
                    str(turn.get("text", "")),
                    tuple(_call(call) for call in turn.get("calls", [])),
                )
                for turn in session["turns"]
            ),
        )
        for session in raw["sessions"]
    )
    if not sessions or not all(session.turns for session in sessions):
        raise ValueError(f"{path.name}: a scenario has sessions, a session has turns")
    return Scenario(
        id=raw["id"],
        why=str(raw.get("why_this_is_here", "")),
        model=str(raw["model"]),
        agent_type=str(raw.get("agent_type", "coder")),
        tool_use_hint=bool(raw.get("tool_use_hint", False)),
        effort=str(raw.get("effort", "")),
        files={name: _text(text) for name, text in sorted(raw["files"].items())},
        sessions=sessions,
    )


def load_profiles(path: Path) -> dict[str, Profile]:
    """The cache shapes a replay is measured under."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    profiles: dict[str, Profile] = {}
    for name, entry in sorted(raw.items()):
        if entry["usage_format"] not in _USAGE_FORMATS:
            raise ValueError(f"{name}: unknown usage format {entry['usage_format']!r}")
        profiles[name] = Profile(
            CacheModel(
                CacheShape(entry["cache"]),
                min_tokens=int(entry.get("min_tokens", 1024)),
                step_tokens=int(entry.get("step_tokens", 1)),
            ),
            entry["usage_format"],
        )
    return profiles


def materialize(scenario: Scenario, root: Path) -> tuple[Path, Path]:
    """Write the scenario's project under ``root``: its project and spec directories."""
    project = (root / "project").resolve()
    spec = project / ".workpilot" / "specs" / f"001-{scenario.id}"
    spec.mkdir(parents=True, exist_ok=True)
    for name, text in scenario.files.items():
        target = (project / name).resolve()
        if not target.is_relative_to(project):
            raise ValueError(f"{name}: a scenario file stays in its project")
        target.parent.mkdir(parents=True, exist_ok=True)
        # newline="": the bytes are the fixture's, on every platform.
        target.write_text(text, encoding="utf-8", newline="")
    return project, spec


# -- usage formats ------------------------------------------------------------
# What a cache shape's providers report, built from the cache's numbers and
# read back by the production reader: the ledger sees what a client records.


def _as_chat_completion(cached: CachedInput, output: int) -> dict[str, Any]:
    usage: dict[str, Any] = {
        "prompt_tokens": cached.prompt,
        "completion_tokens": output,
    }
    if cached.cache_read is not None:
        usage["prompt_tokens_details"] = {"cached_tokens": cached.cache_read}
    return usage


def _as_split_cache(cached: CachedInput, output: int) -> dict[str, Any]:
    read = cached.cache_read or 0
    write = cached.cache_write or 0
    usage: dict[str, Any] = {
        "input_tokens": max(0, cached.prompt - read - write),
        "output_tokens": output,
    }
    if cached.cache_read is not None:
        usage["cache_read_input_tokens"] = cached.cache_read
    if cached.cache_write is not None:
        usage["cache_creation_input_tokens"] = cached.cache_write
    return usage


_USAGE_FORMATS: dict[
    str,
    tuple[
        Callable[[CachedInput, int], dict[str, Any]],
        Callable[[Mapping[str, Any]], CallUsage | None],
    ],
] = {
    "chat_completion": (_as_chat_completion, from_chat_completion),
    "split_cache": (_as_split_cache, from_split_cache),
}


# -- the replay ---------------------------------------------------------------


def _block(message: Mapping[str, Any]) -> str:
    """One message as a cache sees it: who speaks, what they say, what they call."""
    head = message["role"]
    if message.get("tool_call_id"):
        head += f" {message['tool_call_id']}"
    block = f"{head}\n{message.get('content') or ''}"
    if message.get("tool_calls"):
        block += "\n" + json.dumps(message["tool_calls"], sort_keys=True)
    return block


def _resolve(arguments: Mapping[str, Any], spill: Mapping[str, str]) -> dict[str, Any]:
    resolved: dict[str, Any] = {}
    for name, value in arguments.items():
        if value in (SPILL_PATH, SPILL_OFFSET):
            if not spill:
                raise ValueError(f"{value} names a spilled output, and none was")
            value = spill["path"] if value == SPILL_PATH else int(spill["offset"])
        resolved[name] = value
    return resolved


@dataclass
class _Run:
    """A replay in progress: the requests sent and what happened between them."""

    project: str
    requests: list[SentRequest] = field(default_factory=list)
    outputs: list[int] = field(default_factory=list)
    session_starts: list[tuple[tuple[str, ...], int]] = field(default_factory=list)
    interned: dict[str, str] = field(default_factory=dict)
    tool_calls: list[tuple[str, dict[str, Any], str]] = field(default_factory=list)
    spilled: int = 0
    clearings: int = 0
    nudged_at: int | None = None
    stopped_at: int | None = None

    def norm(self, text: str) -> str:
        return text.replace(self.project, PROJECT_MARK)

    def send(
        self, head: str, messages: list[dict[str, Any]], session: int, cleared: bool
    ) -> SentRequest:
        """Record the request ``messages`` make, after the tool definitions ``head``."""
        blocks = [head] + [self.norm(_block(message)) for message in messages]
        # One object per distinct block: two requests then compare by identity.
        blocks = [self.interned.setdefault(block, block) for block in blocks]
        tool_chars = sum(
            len(block)
            for block, message in zip(blocks[1:], messages)
            if message["role"] == "tool"
        )
        request = SentRequest(tuple(blocks), tool_chars, session, cleared)
        self.requests.append(request)
        return request


async def _result(executor: Any, call: Call, arguments: dict[str, Any]) -> str:
    """The tool's result as the loop receives it, before the client's cut."""
    try:
        if call.output is not None:
            # What `_run_command` does with a command's output once it has run.
            result = executor._fit_output(call.output)
        else:
            result = await executor.execute(call.tool, arguments)
    except Exception as error:  # noqa: BLE001 - the loops hand the error to the model
        return f"Tool error: {error}"
    return str(result) if result is not None else ""


async def _run_sessions(
    scenario: Scenario, project_dir: Path, spec_dir: Path, task_segments: TaskSegments
) -> _Run:
    from core.llm_optimization import (
        compact_messages,
        system_prompt_segments,
        truncate_tool_result,
    )
    from core.runtimes.tool_executor import ToolExecutor, get_tool_definitions

    run = _Run(project=str(project_dir))
    executor = ToolExecutor(
        str(project_dir), spec_dir=spec_dir, agent_type=scenario.agent_type
    )
    head = run.norm(
        json.dumps(get_tool_definitions(scenario.agent_type, spec_dir), sort_keys=True)
    )
    for number, session in enumerate(scenario.sessions, start=1):
        # Each subtask is a new client: its system prompt is built again.
        system = assemble(
            system_prompt_segments(project_dir, tool_use_hint=scenario.tool_use_hint)
        )
        segments = [
            *task_segments(project_dir, spec_dir, scenario.effort),
            Segment("subtask", session.subtask, Stability.SESSION),
        ]
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": assemble(segments)},
        ]
        # What every subtask of the task should send identically.
        stable = (
            len(head)
            + len(run.norm(_block(messages[0])))
            + len("user\n")
            + len(run.norm(shared_prefix(segments, up_to=Stability.TASK)))
        )
        tracker = ProgressTracker()
        spill: dict[str, str] = {}
        cleared = False
        for turn_number, turn in enumerate(session.turns, start=1):
            request = run.send(head, messages, number, cleared)
            if turn_number == 1:
                run.session_starts.append((request.blocks, stable))
            cleared = False
            answer = len(turn.text) + sum(
                len(call.tool) + len(json.dumps(call.arguments, sort_keys=True))
                for call in turn.calls
            )
            run.outputs.append(tokens(answer))
            if not turn.calls:
                break
            ids = [f"call_{number}_{turn_number}_{n}" for n in range(len(turn.calls))]
            assistant: dict[str, Any] = {"role": "assistant"}
            if turn.text:
                assistant["content"] = turn.text
            assistant["tool_calls"] = [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": call.tool,
                        "arguments": json.dumps(call.arguments, sort_keys=True),
                    },
                }
                for call_id, call in zip(ids, turn.calls)
            ]
            messages.append(assistant)
            turn_calls: list[tuple[str, Any, str]] = []
            for call_id, call in zip(ids, turn.calls):
                arguments = _resolve(call.arguments, spill)
                result = await _result(executor, call, arguments)
                if call.output is not None and result != call.output:
                    # `_fit_output` changes an output only to spill it.
                    run.spilled += 1
                    if found := _SPILL_GAP.search(result):
                        spill = found.groupdict()
                run.tool_calls.append((call.tool, arguments, result))
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": truncate_tool_result(result),
                    }
                )
                turn_calls.append((call.tool, arguments, result))
            verdict = tracker.observe(turn_fingerprint(turn_calls))
            if verdict == "nudge":
                messages.append({"role": "user", "content": PROGRESS_NUDGE})
                if run.nudged_at is None:
                    run.nudged_at = turn_number
            elif verdict == "stop":
                if run.stopped_at is None:
                    run.stopped_at = turn_number
                break
            if compact_messages(messages):
                run.clearings += 1
                cleared = True
    return run


def _ledger_metrics(run: _Run, profile: Profile) -> dict[str, float | int | None]:
    """The hit ratio and the rewrites the ledger counts under one cache shape."""
    encode, read = _USAGE_FORMATS[profile.usage_format]
    cache = PromptCache(profile.cache)
    ledger = UsageLedger()
    outside = 0
    session = None
    for request, output in zip(run.requests, run.outputs):
        if request.session != session:
            # A new subtask is a new client, with a ledger of its own.
            ledger.boundary()
            session = request.session
        before = ledger.prefix_rewrites
        ledger.record(read(encode(cache.send(request.blocks), output)))
        if ledger.prefix_rewrites > before and not request.after_clearing:
            outside += 1
    ratio = ledger.cache_hit_ratio()
    return {
        "cache_hit_ratio": None if ratio is None else round(ratio, 4),
        "prefix_rewrites": ledger.prefix_rewrites,
        "prefix_rewrites_outside_clearing": outside,
    }


def _task_prefix_share(starts: Sequence[tuple[tuple[str, ...], int]]) -> float | None:
    """The least share of the task block two successive subtasks sent identically."""
    shares = [
        min(1.0, shared_chars(before, after) / stable)
        for (before, _), (after, stable) in zip(starts, starts[1:])
        if stable
    ]
    return round(min(shares), 4) if shares else None


def replay(
    scenario: Scenario,
    project_dir: Path,
    spec_dir: Path,
    *,
    task_segments: TaskSegments,
    profiles: Mapping[str, Profile],
) -> Replay:
    """Replay ``scenario`` on the project ``materialize`` wrote, and measure it.

    ``task_segments(project_dir, spec_dir, effort)`` builds the task block: the
    coder's ``_coding_task_segments``. Deterministic: the same scenario gives
    the same numbers, on any machine whose environment leaves out what is
    machine-specific (rtk, the shared brain), as the evals pin it.
    """
    from context_mgmt.windows import effective_window, window_from_table
    from core.llm_optimization import tool_result_max_chars

    run = asyncio.run(_run_sessions(scenario, project_dir, spec_dir, task_segments))
    # The prefix table, not the machine's models.dev cache: the same everywhere.
    announced = window_from_table(scenario.model)
    payable = effective_window(scenario.model, announced)
    share = tool_result_share(run.requests)
    peak = max(tokens(request.chars) for request in run.requests)
    metrics: dict[str, Any] = {
        "calls": len(run.requests),
        "prefix_breaks": prefix_breaks(run.requests),
        "task_prefix_share": _task_prefix_share(run.session_starts),
        "tool_result_share": None if share is None else round(share, 4),
        "spilled_outputs": run.spilled,
        "clearings": run.clearings,
        "payable_window_tokens": payable,
        "peak_window_share": round(peak / payable, 4),
        "nudged_at_turn": run.nudged_at,
        "stopped_at_turn": run.stopped_at,
        "profiles": {
            name: _ledger_metrics(run, profile)
            for name, profile in sorted(profiles.items())
        },
    }
    return Replay(
        metrics=metrics,
        tool_result_cap=tool_result_max_chars(),
        largest_tool_result=max(
            (len(result) for _, _, result in run.tool_calls), default=0
        ),
        announced_window=announced,
        tool_calls=run.tool_calls,
    )


def read_baseline(path: Path) -> dict[str, Any]:
    """The accepted numbers of a scenario."""
    return json.loads(path.read_text(encoding="utf-8"))["metrics"]


def write_baseline(path: Path, scenario_id: str, metrics: Mapping[str, Any]) -> None:
    """Accept ``metrics`` as the scenario's baseline. Only ever on purpose."""
    text = json.dumps(
        {"scenario": scenario_id, "metrics": metrics},
        indent=2,
        sort_keys=True,
        ensure_ascii=False,
    )
    path.write_text(text + "\n", encoding="utf-8", newline="\n")
