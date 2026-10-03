"""A skill body specialised for the provider that runs it.

A skill is written once, in `SKILL.md`, and read by every provider WorkPilot
drives. Most of a procedure is the same whoever follows it — *launch the app,
read the errors, fix, launch again* — and a few lines are not: Claude reaches a
browser through the `chrome-devtools` MCP server, an OpenAI or Ollama session
has no MCP at all and drives the same browser through the in-process `verify_*`
tools, and a 7B local model does better with one action per step than with a
paragraph of options. Writing one skill per provider would mean six copies of
the part that does not differ, drifting apart from the first edit.

So a skill may carry overlays beside it:

```
skills/<pack>/<skill>/
  SKILL.md                 the procedure, for everyone
  providers/_sdk.md        the family driven by the Claude Agent SDK
  providers/_executor.md   the family whose tools run in `tool_executor`
  providers/<provider>.md  one provider, on top of its family
```

and `resolve_skill_body` reads them in that order — base, family, provider —
each one specialising the last.

**The family is derived, not declared.** `capabilities/providers.yaml` already
says which client drives a provider: `ClaudeAgentClient` (and every provider
that `degrades_to: claude`, because what actually runs is the SDK) is `_sdk`;
every other adapter executes its tools through `ToolExecutor` and is
`_executor`. A provider added to that file next month gets the right family
without anyone touching a skill.

**A provider with no overlay of its own inherits one.** It follows
`degrades_to` first — `aws` runs on the SDK, so `claude.md` describes it better
than nothing — and then stops at its family. An overlay is never required.

**Merging is by section, never by line.** An overlay's `## Heading` replaces
the base section with the same heading (case and surrounding spaces ignored);
a heading the base does not have is appended in the overlay's order; a section
whose first line is `<!-- append -->` is added to the end of the base section
instead of replacing it. Text before an overlay's first heading is a note to
the reader and is appended after the base preamble. Line-level patching would
leave the surrounding sentence describing a tool it no longer names — the
reason the hermes candidates carry a Portability section instead of a
find-and-replace.

The frontmatter of an overlay is read through `parse_frontmatter`, like every
other frontmatter here, and only for `extends` — a sanity check that the file
belongs to this skill. Nothing in it reaches the body.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from .frontmatter import parse_frontmatter

logger = logging.getLogger(__name__)

__all__ = [
    "OVERLAY_DIRNAME",
    "SDK_FAMILY",
    "EXECUTOR_FAMILY",
    "ResolvedSkill",
    "provider_family",
    "overlay_chain",
    "merge_sections",
    "resolve_skill_body",
    "resolve_skill_file",
]

OVERLAY_DIRNAME = "providers"
SDK_FAMILY = "_sdk"
EXECUTOR_FAMILY = "_executor"

_APPEND_MARKER = "<!-- append -->"
_HEADING = re.compile(r"^##\s+(?P<title>.+?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")

# The client classes that run the Claude Agent SDK. Everything else listed in
# providers.yaml executes its tools in-process through ToolExecutor.
_SDK_ADAPTERS = frozenset({"ClaudeAgentClient"})

# Same spellings `skills_registry.providers` folds, plus the ones the UI uses.
_ALIASES = {
    "anthropic": "claude",
    "claude-code": "claude",
    "lm-studio": "lmstudio",
    "llama-cpp": "local",
    "github-copilot": "copilot",
    "gemini": "google",
}


@dataclass(frozen=True)
class ResolvedSkill:
    """A skill body after its overlays, and which overlays made it."""

    body: str
    meta: dict
    source: Path
    overlays: tuple[str, ...] = field(default_factory=tuple)

    @property
    def specialised(self) -> bool:
        return bool(self.overlays)


def _canonical(provider: str | None) -> str:
    name = (provider or "").strip().lower()
    return _ALIASES.get(name, name)


def provider_family(provider: str | None) -> str:
    """`_sdk` or `_executor` for ``provider``, from the capability matrix.

    An unknown or empty provider is `_sdk`: `create_agent_client` resolves an
    unnamed provider to Claude, so that is what will actually run.
    """
    name = _canonical(provider)
    if not name or name == "claude":
        return SDK_FAMILY
    try:
        from .providers import get_provider_capabilities

        caps = get_provider_capabilities(name)
    except Exception as exc:  # noqa: BLE001 - a missing matrix degrades to SDK
        logger.debug("provider matrix unavailable (%s); assuming SDK", exc)
        return SDK_FAMILY
    if caps.adapter in _SDK_ADAPTERS:
        return SDK_FAMILY
    if not caps.adapter:
        # No adapter: what runs is whatever it degrades to.
        target = caps.degrades_to or "claude"
        return SDK_FAMILY if target == "claude" else provider_family(target)
    return EXECUTOR_FAMILY


def overlay_chain(provider: str | None) -> list[str]:
    """The overlay names to apply, most general first.

    ``aws`` → ``["_sdk", "claude", "aws"]`` (it degrades to claude);
    ``ollama`` → ``["_executor", "ollama"]``; ``None`` → ``["_sdk", "claude"]``.
    Names that have no file are skipped by the caller; listing them costs one
    ``is_file`` each.
    """
    name = _canonical(provider) or "claude"
    chain = [provider_family(name)]
    lineage: list[str] = []
    seen: set[str] = set()
    current: str | None = name
    while current and current not in seen:
        seen.add(current)
        lineage.append(current)
        try:
            from .providers import get_provider_capabilities

            caps = get_provider_capabilities(current)
            current = caps.degrades_to if not caps.adapter else None
        except Exception:  # noqa: BLE001
            current = None
    chain.extend(reversed(lineage))
    return chain


def _split_sections(text: str) -> tuple[str, list[tuple[str, str]]]:
    """``(preamble, [(title, block)])`` — headings inside code fences ignored."""
    preamble: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    in_fence = False
    for line in text.split("\n"):
        if _FENCE.match(line):
            in_fence = not in_fence
        match = None if in_fence else _HEADING.match(line)
        if match:
            sections.append((match.group("title"), [line]))
        elif sections:
            sections[-1][1].append(line)
        else:
            preamble.append(line)
    return "\n".join(preamble), [(t, "\n".join(b)) for t, b in sections]


def _key(title: str) -> str:
    return re.sub(r"\s+", " ", title).strip().lower()


def merge_sections(base: str, overlay: str) -> str:
    """``base`` with ``overlay``'s sections applied (see the module doc)."""
    base_pre, base_secs = _split_sections(base)
    over_pre, over_secs = _split_sections(overlay)

    merged: list[list[str]] = [[t, b] for t, b in base_secs]
    index = {_key(t): i for i, (t, _) in enumerate(base_secs)}

    for title, block in over_secs:
        head, _, rest = block.partition("\n")
        content = rest.lstrip("\n")
        append = content.startswith(_APPEND_MARKER)
        if append:
            content = content[len(_APPEND_MARKER) :].lstrip("\n")
        position = index.get(_key(title))
        if position is None:
            index[_key(title)] = len(merged)
            merged.append([title, f"{head}\n{content}".rstrip()])
        elif append:
            merged[position][1] = (
                f"{merged[position][1].rstrip()}\n\n{content}".rstrip()
            )
        else:
            merged[position][1] = f"{head}\n{content}".rstrip()

    parts = [base_pre.rstrip()]
    if over_pre.strip():
        parts.append(over_pre.strip())
    parts += [block.rstrip() for _, block in merged]
    return "\n\n".join(p for p in parts if p).rstrip() + "\n"


def _read_overlay(path: Path, skill_name: str) -> str | None:
    try:
        meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.debug("overlay %s unreadable: %s", path, exc)
        return None
    extends = str(meta.get("extends") or "").strip()
    if extends and skill_name and extends != skill_name:
        logger.warning(
            "overlay %s extends %r, not %r; ignored", path, extends, skill_name
        )
        return None
    return body if body.strip() else None


def resolve_skill_body(
    skill_dir: Path, provider: str | None
) -> tuple[str, tuple[str, ...]]:
    """``(body, applied overlay names)`` for the skill in ``skill_dir``.

    Raises ``FileNotFoundError`` when there is no ``SKILL.md``; a missing or
    unreadable overlay is skipped, never fatal.
    """
    resolved = resolve_skill_file(skill_dir / "SKILL.md", provider)
    return resolved.body, resolved.overlays


def resolve_skill_file(skill_md: Path, provider: str | None) -> ResolvedSkill:
    """Same as `resolve_skill_body`, from the SKILL.md path, with its metadata."""
    meta, body = parse_frontmatter(skill_md.read_text(encoding="utf-8"))
    skill_name = str(meta.get("name") or skill_md.parent.name)
    overlay_dir = skill_md.parent / OVERLAY_DIRNAME
    applied: list[str] = []
    if overlay_dir.is_dir():
        for name in overlay_chain(provider):
            path = overlay_dir / f"{name}.md"
            if not path.is_file():
                continue
            overlay = _read_overlay(path, skill_name)
            if overlay is None:
                continue
            body = merge_sections(body, overlay)
            applied.append(name)
    return ResolvedSkill(body=body, meta=meta, source=skill_md, overlays=tuple(applied))
