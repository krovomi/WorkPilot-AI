"""The PreToolUse hook that cleans a file on its way to disk.

This is the change that reaches every feature at once — the same joint `rtk`
uses, for the same reason. Planner, coder, QA fixer, the spec pipeline, the
GitHub runners, the mobile phases: none of them write a file of their own, they
all go through `core.client.create_client`, and this hook is registered there.
A phase added next month is covered by having been written the normal way.

**Pre**, not **Post**, and that is the whole design. A PostToolUse hook would
have to read the file back, rewrite it, and leave a second mtime behind — which
means a dev server reloading twice, a file watcher firing twice, and a window
between the two writes where the dirty bytes are on disk and a test runner can
read them. Rewriting `updatedInput` means the dirty bytes never exist.

What it will not touch
----------------------
``old_string``
    The one field that must stay exactly as the model sent it. `Edit` finds its
    target by matching `old_string` against the file *as it is on disk*, and a
    file that already carries an invisible character carries it in the match
    too. Cleaning the needle is how a working edit turns into "string not
    found" — and the cleaning still happens, because `new_string` is what
    lands.

``permission``
    Like `rtk_rewrite_hook`, this returns `updatedInput` and nothing else. The
    guardrails hook registered on the same tools decides whether the write may
    happen at all; a second hook that only knows about invisible codepoints
    must not get a vote on that question.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .clean import Cleaning, clean_generated
from .ledger import record

logger = logging.getLogger(__name__)

__all__ = ["CLEANED_TOOLS", "make_watermarks_hook"]

#: The tools that put model-authored text on disk. `NotebookEdit` is in the
#: list because a notebook cell is source too, even though the tool is rarely
#: reached in a WorkPilot build; leaving it out would have been a silent hole
#: the day somebody enables it.
CLEANED_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")


def _clean_field(
    payload: dict[str, Any], key: str, env: dict | None
) -> Cleaning | None:
    """Clean one string field in place. Returns the cleaning when it changed."""
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        return None
    cleaning = clean_generated(value, env=env)
    if not cleaning.changed:
        return None
    payload[key] = cleaning.text
    return cleaning


def _merge(into: dict[str, int], more: dict[str, int]) -> None:
    for label, count in more.items():
        into[label] = into.get(label, 0) + count


def _clean_tool_input(
    tool_name: str, tool_input: dict[str, Any], env: dict | None
) -> tuple[dict[str, Any] | None, Cleaning | None]:
    """Return the updated input and a combined cleaning, or (None, None)."""
    updated = dict(tool_input)
    removed: dict[str, int] = {}
    replaced: dict[str, int] = {}
    changed = False

    if tool_name == "Write":
        cleaning = _clean_field(updated, "content", env)
        if cleaning is not None:
            changed = True
            _merge(removed, cleaning.removed)
            _merge(replaced, cleaning.replaced)

    elif tool_name == "Edit":
        # `new_string` only — see the module docstring on `old_string`.
        cleaning = _clean_field(updated, "new_string", env)
        if cleaning is not None:
            changed = True
            _merge(removed, cleaning.removed)
            _merge(replaced, cleaning.replaced)

    elif tool_name == "MultiEdit":
        edits = updated.get("edits")
        if not isinstance(edits, list):
            return None, None
        rebuilt: list[Any] = []
        for edit in edits:
            if not isinstance(edit, dict):
                rebuilt.append(edit)
                continue
            candidate = dict(edit)
            cleaning = _clean_field(candidate, "new_string", env)
            if cleaning is not None:
                changed = True
                _merge(removed, cleaning.removed)
                _merge(replaced, cleaning.replaced)
            rebuilt.append(candidate)
        if changed:
            updated["edits"] = rebuilt

    elif tool_name == "NotebookEdit":
        cleaning = _clean_field(updated, "new_source", env)
        if cleaning is not None:
            changed = True
            _merge(removed, cleaning.removed)
            _merge(replaced, cleaning.replaced)

    if not changed:
        return None, None
    return updated, Cleaning(text="", changed=True, removed=removed, replaced=replaced)


def make_watermarks_hook(spec_dir: Path | str | None):
    """Bind the spec directory so the ledger has somewhere to go.

    The factory shape is the one `_make_guardrails_hook` already uses in
    `core.client`: the SDK calls hooks with a fixed signature, so anything the
    hook needs about *this build* is closed over rather than passed.
    """

    async def _hook(
        input_data: dict[str, Any],
        tool_use_id: str | None = None,
        context: Any | None = None,
    ) -> dict[str, Any]:
        """Strip invisible watermark carriers, or leave the call alone.

        Returns ``{}`` for everything it does not touch, which is what the SDK
        reads as "no opinion". Never raises: a hook that throws takes the tool
        call with it, and no cosmetic pass is worth a failed build.
        """
        try:
            tool_name = input_data.get("tool_name")
            if tool_name not in CLEANED_TOOLS:
                return {}

            tool_input = input_data.get("tool_input")
            if not isinstance(tool_input, dict):
                # Malformed input is the guardrails hook's to refuse, with its
                # own message. Answering here would race it with a worse one.
                return {}

            updated, cleaning = _clean_tool_input(tool_name, tool_input, None)
            if updated is None or cleaning is None:
                return {}

            file_path = tool_input.get("file_path") or tool_input.get("notebook_path")
            record(
                spec_dir,
                file_path=str(file_path) if file_path else "",
                tool=str(tool_name),
                cleaning=cleaning,
            )
            logger.debug(
                "watermarks: %s %s — %d removed, %d replaced",
                tool_name,
                file_path,
                cleaning.removed_count,
                cleaning.replaced_count,
            )
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "updatedInput": updated,
                }
            }
        except Exception:  # noqa: BLE001 - a cosmetic pass never fails a build
            logger.debug("watermarks hook skipped", exc_info=True)
            return {}

    return _hook
