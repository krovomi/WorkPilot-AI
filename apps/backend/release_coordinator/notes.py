"""Release notes for the whole train, by rules, optionally summed up by a model.

The rules give the notes on their own: one section per service that changes,
its version jump and its commits sorted into breaking changes, features,
fixes and the rest. When asked, the configured model (``core.oneshot``, any
provider, local with Ollama) adds a short paragraph on top. It reads only the
commit subjects, quoted as data (S2); its answer is kept when it is one plain
paragraph of at most 1,200 characters, otherwise the notes stay as the rules
wrote them.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

MAX_SUMMARY = 1200
_ENTRY = re.compile(r"^- (?P<text>.*) \((?P<type>[a-z]+)\)$")
_SECTIONS = (
    ("breaking", "Breaking changes"),
    ("feat", "Features"),
    ("fix", "Fixes"),
    ("other", "Other changes"),
)
_SYSTEM = (
    "You write the opening paragraph of release notes. You get, per service, its "
    "version change and its commit subjects. Answer with one plain paragraph of at "
    "most 1200 characters saying what this release brings to users. No heading, no "
    "list, no code, nothing that is not in the commits."
)


def _version(value: Any) -> str:
    if isinstance(value, dict):
        text = (
            f"{value.get('major', 0)}.{value.get('minor', 0)}.{value.get('patch', 0)}"
        )
        return text + (f"-{value['prerelease']}" if value.get("prerelease") else "")
    return str(value or "")


def _sort(entries: list[str], breaking: bool) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {key: [] for key, _ in _SECTIONS}
    for entry in entries:
        match = _ENTRY.match(entry)
        text, kind = (
            (match["text"], match["type"]) if match else (entry.lstrip("- "), "other")
        )
        if breaking and ("!" in text or "BREAKING" in text):
            groups["breaking"].append(text)
        elif kind in groups:
            groups[kind].append(text)
        else:
            groups["other"].append(text)
    return groups


def rule_notes(plan: dict[str, Any], title: str) -> str:
    """Markdown notes for the services of ``plan`` that change."""
    lines = [f"# {title}", ""]
    changed = [
        s for s in plan.get("services", []) if s.get("bumpType") not in (None, "none")
    ]
    if not changed:
        return "\n".join([*lines, "No service changes in this release.", ""])
    for service in changed:
        lines.append(
            f"## {service['name']} {_version(service.get('currentVersion'))}"
            f" → {_version(service.get('nextVersion'))} ({service.get('bumpType')})"
        )
        groups = _sort(
            list(service.get("changelogEntries") or []),
            service.get("bumpType") == "major",
        )
        for key, heading in _SECTIONS:
            if groups[key]:
                lines += ["", f"### {heading}", *[f"- {text}" for text in groups[key]]]
        lines.append("")
    return "\n".join(lines)


def _ask(prompt: str, project_dir: str | None) -> str:
    from core.oneshot import oneshot_completion

    return asyncio.run(
        oneshot_completion(
            prompt, system_prompt=_SYSTEM, project_dir=project_dir, max_turns=1
        )
    )


def summary(
    plan: dict[str, Any],
    project_dir: str | None = None,
    ask: Callable[[str, str | None], str] | None = None,
) -> str:
    """The model's paragraph, or "" when there is no model or no usable answer."""
    from security.untrusted import quote_untrusted

    changed = [
        s for s in plan.get("services", []) if s.get("bumpType") not in (None, "none")
    ]
    if not changed:
        return ""
    data = "\n".join(
        f"{s['name']} {_version(s.get('currentVersion'))} -> {_version(s.get('nextVersion'))}:\n"
        + "\n".join(str(e)[:300] for e in (s.get("changelogEntries") or [])[:60])
        for s in changed[:40]
    )
    prompt = quote_untrusted(data, kind="file_content", source="git history") + (
        "\n\nAnswer with the paragraph only."
    )
    try:
        text = (ask or _ask)(prompt, project_dir).strip()
    except (RuntimeError, OSError, ValueError, ImportError) as exc:
        logger.info("No model for release notes: %s", type(exc).__name__)
        return ""
    if (
        not text
        or len(text) > MAX_SUMMARY
        or "\n\n" in text
        or text.startswith(("#", "-", "*", "`"))
    ):
        return ""
    return " ".join(text.split())


def release_notes(
    plan: dict[str, Any],
    title: str,
    *,
    ai: bool = False,
    project_dir: str | None = None,
    ask: Callable[[str, str | None], str] | None = None,
) -> dict[str, object]:
    notes = rule_notes(plan, title)
    paragraph = summary(plan, project_dir, ask) if ai else ""
    if paragraph:
        head, _, rest = notes.partition("\n\n")
        notes = f"{head}\n\n{paragraph}\n\n{rest}"
    return {"markdown": notes, "by": "model" if paragraph else "rules"}


__all__ = ["release_notes", "rule_notes", "summary"]
