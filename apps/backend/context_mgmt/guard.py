"""The context guard of one agent session.

``agents/session._run_agent_client_session`` drives it at three points:

1. ``pre_session(entries)`` before the conversation log is replayed: the
   cheapest place to act, since nothing has been sent yet. A replay that would
   already fill the window past the threshold is cleared (new subtask) or
   compacted (same subtask) first.
2. ``observe(message)`` after every streamed message: measures the fill,
   emits ``CONTEXT_USAGE``, starts the background handoff past the threshold
   and records any manual request from the task panel.
3. ``decision_at_safe_point()`` then says whether to stop the session now —
   only between tool calls, never with one in flight. The caller applies it
   with ``apply(decision)`` and returns ``"context_reset"``; the build loop
   then rebuilds its client like after a hot swap.

Everything here is best-effort: a failure means "no context management for
this session", never a failed session.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from .capabilities import context_capabilities
from .decide import (
    Decision,
    Situation,
    decide,
    recommended_action,
    should_prepare_handoff,
)
from .handoff import (
    HandoffPreparer,
    compose_handoff,
    deterministic_handoff,
    summarize_conversation,
)
from .marker import consume_context_action, read_context_action, request_targets
from .policy import load_context_policy
from .windows import resolve_context_window

logger = logging.getLogger(__name__)

CHARS_PER_TOKEN = 4
EMIT_MIN_POINTS = 2.0
EMIT_MIN_SECONDS = 10.0
STATE_FILE = "state.json"


def _entry_chars(entry: dict[str, Any]) -> int:
    total = 0
    for block in entry.get("content") or []:
        for key in ("text", "result_content"):
            value = block.get(key)
            if value:
                total += len(value) if isinstance(value, str) else len(str(value))
        if block.get("tool_input"):
            total += len(json.dumps(block["tool_input"], default=str))
    return total


def _tool_output_ratio(entries: list[dict[str, Any]]) -> float:
    tool = total = 0
    for entry in entries:
        for block in entry.get("content") or []:
            size = len(str(block.get("result_content") or block.get("text") or ""))
            total += size
            if block.get("type") == "tool_result":
                tool += size
    return tool / total if total else 0.0


class ContextGuard:
    def __init__(
        self,
        *,
        spec_dir: Path,
        project_dir: Path,
        phase: str,
        subtask_id: str | None,
        client: Any,
        provider: str,
        model: str,
        emitter: Any = None,
    ) -> None:
        self.spec_dir = Path(spec_dir)
        self.project_dir = Path(project_dir)
        self.phase = phase
        self.subtask_id = subtask_id
        self.client = client
        self.provider = provider
        self.model = model
        self.emitter = emitter
        self.caps = context_capabilities(provider)
        self.window = resolve_context_window(
            model, getattr(client, "context_window_tokens", None)
        )
        self.base_chars = 0
        self.stream_chars = 0
        self.percent = 0.0
        self.used_tokens = 0
        self.source = "estimated"
        self._pending_tools: set[str] = set()
        self._manual: str | None = None
        self._last_emit = (-100.0, 0.0)
        self.preparer = HandoffPreparer()
        # Measure and emit only: for sessions whose caller cannot rebuild its
        # client (QA passes, which start fresh anyway), or whose resets stopped
        # helping (``reset_limit``).
        self.monitor_only = False
        # Set by ``pre_session`` when nothing is replayed. The first fill such
        # a thread measures is the least a reset could bring it back to.
        self._fresh = False
        self.floor_pct: float | None = None

    # ── state ────────────────────────────────────────────────────────────
    @property
    def policy(self):
        return load_context_policy(self.spec_dir)

    def _state_path(self) -> Path:
        return self.spec_dir / "context" / STATE_FILE

    def _compactions(self) -> int:
        try:
            state = json.loads(self._state_path().read_text(encoding="utf-8"))
            return int(state.get("compactions", {}).get(self.subtask_id or "-", 0))
        except (OSError, ValueError, TypeError, AttributeError):
            return 0

    def _record_action(self, action: str) -> None:
        path = self._state_path()
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
        if not isinstance(state, dict):
            state = {}
        counts = state.setdefault("compactions", {})
        key = self.subtask_id or "-"
        counts[key] = counts.get(key, 0) + 1 if action == "compact" else 0
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(state), encoding="utf-8")
        except OSError:
            # The count only steers "auto" towards a clear; losing it costs at
            # most one extra compaction.
            pass

    def _situation(
        self, entries: list[dict[str, Any]] | None = None, **kw
    ) -> Situation:
        return Situation(
            compactions_in_subtask=self._compactions(),
            tool_output_ratio=_tool_output_ratio(entries) if entries else 0.0,
            floor_pct=self.floor_pct or 0.0,
            **kw,
        )

    # ── measurement ──────────────────────────────────────────────────────
    def _measure(self) -> None:
        reported = getattr(self.client, "last_context_tokens", None)
        window = getattr(self.client, "context_window_tokens", None)
        if isinstance(window, int) and window > 0:
            self.window = window
        if isinstance(reported, int) and reported > 0:
            self.used_tokens = reported
            self.source = getattr(self.client, "context_usage_source", None) or (
                self.caps.usage if self.caps.usage != "estimated" else "reported"
            )
        else:
            self.used_tokens = (self.base_chars + self.stream_chars) // CHARS_PER_TOKEN
            self.source = "estimated"
        self.percent = min(100.0, 100.0 * self.used_tokens / max(self.window, 1))

    def emit_usage(self, force: bool = False) -> None:
        if self.emitter is None:
            return
        last_pct, last_at = self._last_emit
        now = time.monotonic()
        if not force and (
            abs(self.percent - last_pct) < EMIT_MIN_POINTS
            and now - last_at < EMIT_MIN_SECONDS
        ):
            return
        self._last_emit = (self.percent, now)
        policy = self.policy
        # The cache as the client measured it, call by call (harness.domain):
        # None while nothing reported a cache, which the gauge shows as such.
        ledger = getattr(self.client, "usage_ledger", None)
        cache = ledger.summary() if ledger is not None else {}
        try:
            self.emitter.emit(
                "CONTEXT_USAGE",
                {
                    "phase": self.phase,
                    "subtaskId": self.subtask_id,
                    "provider": self.provider,
                    "model": self.model,
                    "usedTokens": self.used_tokens,
                    "windowTokens": self.window,
                    "percent": round(self.percent, 1),
                    "source": self.source,
                    "thresholdPct": policy.threshold_pct,
                    "mode": policy.mode,
                    "handoffState": self.preparer.state,
                    "recommended": recommended_action(self._situation()),
                    "compactSupport": self.caps.compact,
                    "cacheHitRatio": cache.get("cacheHitRatio"),
                    "prefixRewrites": cache.get("prefixRewrites", 0),
                },
            )
        except Exception:  # noqa: BLE001 - the gauge is a mirror
            pass

    def _emit_applied(
        self, decision: Decision, before: float, after: float | None
    ) -> None:
        if self.emitter is not None:
            try:
                self.emitter.emit(
                    "CONTEXT_ACTION_APPLIED",
                    {
                        "action": decision.action,
                        "trigger": decision.trigger,
                        "phase": self.phase,
                        "subtaskId": self.subtask_id,
                        "provider": self.provider,
                        "native": decision.action == "compact"
                        and self.caps.native_compact,
                        "beforePct": round(before, 1),
                        "afterPct": None if after is None else round(after, 1),
                        "reason": decision.reason,
                    },
                )
            except Exception:  # noqa: BLE001
                pass
        try:
            from task_logger import get_task_logger

            task_logger = get_task_logger(self.spec_dir)
            if task_logger:
                verb = (
                    "New thread" if decision.action == "clear" else "Context compacted"
                )
                task_logger.log_info(
                    f"🧠 {verb} ({decision.trigger}) at {before:.0f}% — {decision.reason}"
                )
        except Exception:  # noqa: BLE001
            pass

    def report_start(self, prompt: str) -> None:
        """First reading of a session that replays nothing: its prompt alone."""
        self.base_chars = len(prompt)
        self._measure()
        self.emit_usage(force=True)

    def _pct_for_chars(self, chars: int) -> float:
        return min(100.0, 100.0 * (chars // CHARS_PER_TOKEN) / max(self.window, 1))

    # ── 1. before the replay ─────────────────────────────────────────────
    async def pre_session(
        self, entries: list[dict[str, Any]], message: str
    ) -> list[dict[str, Any]]:
        """Return the entries to replay, after any action taken now."""
        replay_chars = sum(_entry_chars(e) for e in entries)
        self.base_chars = replay_chars + len(message)
        self._measure()
        if self.monitor_only or not entries:
            # Nothing to act on, or not allowed to: a request with nothing to
            # replay is left for the running session.
            self._fresh = not entries
            self.emit_usage(force=True)
            return entries
        manual = consume_context_action(self.spec_dir, self.phase, self.subtask_id)
        decision = decide(
            self.percent,
            self.policy,
            self._situation(entries, at_task_boundary=self._is_task_boundary(entries)),
            # Nothing runs in the background before a session: the handoff
            # used here is the deterministic one, available now.
            handoff_ready=True,
            # The replay is WorkPilot's own log: native compaction cannot
            # shrink it, so it is always emulated at this point.
            native_compact=False,
            manual=manual.action if manual else None,
        )
        if decision is None:
            self.emit_usage(force=True)
            return entries
        before = self.percent
        if decision.action == "clear":
            entries = await self._clear(entries, summary=None)
        else:
            summary = await self._summary(entries)
            entries = self._compact(entries, summary)
        self.base_chars = sum(_entry_chars(e) for e in entries) + len(message)
        self._measure()
        self._fresh = not entries
        self._emit_applied(decision, before, self.percent)
        self.emit_usage(force=True)
        return entries

    def _is_task_boundary(self, entries: list[dict[str, Any]]) -> bool:
        for entry in reversed(entries):
            sid = entry.get("subtask_id")
            entry_phase = entry.get("phase")
            if entry_phase and entry_phase != self.phase:
                return True
            if sid:
                return sid != self.subtask_id
        return False

    # ── 2. during the session ────────────────────────────────────────────
    def observe(self, message: Any) -> None:
        for block in getattr(message, "content", None) or []:
            kind = getattr(
                getattr(block, "type", None), "value", getattr(block, "type", None)
            )
            if kind == "tool_use" and getattr(block, "tool_id", None):
                self._pending_tools.add(block.tool_id)
            elif kind == "tool_result":
                self._pending_tools.discard(getattr(block, "tool_use_id", None))
            for attr in ("text", "result_content"):
                value = getattr(block, attr, None)
                if value:
                    self.stream_chars += (
                        len(value) if isinstance(value, str) else len(str(value))
                    )
        raw = getattr(message, "raw", None)
        if getattr(raw, "subtype", None) == "compact_boundary":
            # The provider compacted natively, mid-turn.
            before = self.percent
            self._measure()
            self._emit_applied(
                Decision("compact", "auto", "native compaction"), before, None
            )
        self._measure()
        if self._fresh and self.floor_pct is None:
            self.floor_pct = self.percent
        if not self.monitor_only:
            self._watch_for_actions()
        self.emit_usage()

    def _watch_for_actions(self) -> None:
        if self._manual is None:
            request = read_context_action(self.spec_dir)
            if request_targets(request, self.phase, self.subtask_id):
                self._manual = request.action
        policy = self.policy
        if should_prepare_handoff(self.percent, policy) and not (
            self.caps.native_compact and policy.mode in ("auto", "compact")
        ):
            self.preparer.start(self._summary_from_log)

    def decision_at_safe_point(self) -> Decision | None:
        if self._pending_tools or self.monitor_only:
            return None
        return decide(
            self.percent,
            self.policy,
            self._situation(),
            handoff_ready=self.preparer.ready,
            native_compact=self.caps.native_compact,
            manual=self._manual,
        )

    async def apply(self, decision: Decision) -> None:
        """Apply ``decision`` to what the next session will replay."""
        if decision.trigger == "manual":
            consume_context_action(self.spec_dir, self.phase, self.subtask_id)
        entries = self._own_entries()
        before = self.percent
        if decision.action == "clear":
            entries = await self._clear(entries, summary=self.preparer.summary())
        else:
            summary = self.preparer.summary() or await self._summary(entries)
            entries = self._compact(entries, summary)
        self.preparer.cancel()
        after = self._pct_for_chars(sum(_entry_chars(e) for e in entries))
        if decision.action == "clear":
            after = self._pct_for_chars(len(self._pending_handoff_text()))
        self._emit_applied(decision, before, after)

    # ── actions ──────────────────────────────────────────────────────────
    def _own_entries(self) -> list[dict[str, Any]]:
        try:
            from core.conversation_log import read_log

            return read_log(self.spec_dir, self.provider, self.model)
        except Exception:  # noqa: BLE001
            return []

    async def _summary_from_log(self) -> str | None:
        return await self._summary(self._own_entries())

    async def _summary(self, entries: list[dict[str, Any]]) -> str | None:
        phase_entries = [
            e for e in entries if (e.get("phase") or self.phase) == self.phase
        ]
        return await summarize_conversation(
            phase_entries or entries,
            project_dir=self.project_dir,
            spec_dir=self.spec_dir,
            provider=self._provider_key(),
            model=self.model,
        )

    def _provider_key(self) -> str | None:
        # create_agent_client takes the task's provider name, not the client's.
        return {"openai-codex-cli": "openai"}.get(self.provider, self.provider)

    async def _clear(
        self, entries: list[dict[str, Any]], summary: str | None
    ) -> list[dict[str, Any]]:
        from .actions import apply_clear

        handoff = compose_handoff(
            deterministic_handoff(
                self.spec_dir, self.project_dir, self.phase, self.subtask_id, entries
            ),
            summary,
        )
        apply_clear(self.spec_dir, handoff)
        self._record_action("clear")
        return []

    def _compact(
        self, entries: list[dict[str, Any]], summary: str | None
    ) -> list[dict[str, Any]]:
        from .actions import apply_compact

        text = summary or deterministic_handoff(
            self.spec_dir, self.project_dir, self.phase, self.subtask_id, entries
        )
        apply_compact(
            self.spec_dir,
            provider=self.provider,
            model=self.model,
            phase=self.phase,
            summary=text,
            subtask_id=self.subtask_id,
        )
        self._record_action("compact")
        return self._own_entries()

    def _pending_handoff_text(self) -> str:
        from .handoff import HANDOFF_DIR, PENDING_FILE

        try:
            return (self.spec_dir / HANDOFF_DIR / PENDING_FILE).read_text("utf-8")
        except OSError:
            return ""
