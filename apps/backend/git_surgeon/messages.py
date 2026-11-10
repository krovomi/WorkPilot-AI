"""Messages written by the configured model, any provider (``core.oneshot``).

The model only words subjects: the plan, the grouping and the replay stay
algorithmic. It sees the old messages, the paths and the line counts of each
commit, quoted as data (S2), never the code. An answer is kept only when it is
one line of at most 100 characters that follows the project's convention;
otherwise the rule-made message stays, so a run without a model, or offline
without a local one, gives a whole plan too.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable

from .commits import Commit
from .conventions import MAX_SUBJECT, Convention, conforms
from .planner import Planned

logger = logging.getLogger(__name__)

MAX_STEPS = 40
_SYSTEM = (
    "You write git commit subject lines. For each step you get the old commit "
    "messages, the files and the line counts. Answer with one JSON object mapping "
    "each step id to one subject line of at most 100 characters, in the convention "
    "given, describing what the change does. No body, no code, no quotes around it."
)


def _ask(prompt: str, project_dir: str | None) -> str:
    from core.oneshot import oneshot_completion

    return asyncio.run(
        oneshot_completion(
            prompt, system_prompt=_SYSTEM, project_dir=project_dir, max_turns=1
        )
    )


def _answer(text: str) -> dict[str, object]:
    match = re.search(r"\{.*\}", text or "", re.S)
    if not match:
        return {}
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _convention_text(convention: Convention) -> str:
    if convention.kind == "gitmoji":
        return "gitmoji: an emoji code such as :bug: then a capitalised summary"
    if convention.kind == "custom":
        return f"must match the regular expression {convention.pattern}"
    return "Conventional Commits: type(scope): summary, type one of feat fix docs refactor perf test build ci chore"


def reword(
    steps: list[Planned],
    commits: list[Commit],
    convention: Convention,
    project_dir: str | None = None,
    ask: Callable[[str, str | None], str] | None = None,
) -> int:
    """Replace the subject of rewritten steps with the model's; how many were kept."""
    from security.untrusted import quote_untrusted

    by_sha = {c.sha: c for c in commits}
    wanted = [s for s in steps if s.kind != "keep"][:MAX_STEPS]
    if not wanted:
        return 0
    data = {
        s.id: {
            "messages": [
                by_sha[sha].message[:500] for sha in s.sources if sha in by_sha
            ],
            "files": (
                s.paths or [f.path for sha in s.sources for f in by_sha[sha].files]
            )[:30],
            "lines": sum(by_sha[sha].lines for sha in s.sources if sha in by_sha),
        }
        for s in wanted
    }
    prompt = (
        f"Convention: {_convention_text(convention)}\n\n"
        + quote_untrusted(
            json.dumps(data, ensure_ascii=False, indent=1),
            kind="file_content",
            source="git history",
        )
        + "\n\nAnswer with the JSON object only."
    )
    try:
        answer = _answer((ask or _ask)(prompt, project_dir))
    except (RuntimeError, OSError, ValueError, ImportError) as exc:
        logger.info("No model for commit messages: %s", type(exc).__name__)
        return 0
    kept = 0
    for step in wanted:
        line = answer.get(step.id)
        if not isinstance(line, str):
            continue
        line = line.strip().strip("\"'`").strip()
        if (
            "\n" in line
            or not line
            or len(line) > MAX_SUBJECT
            or not conforms(line, convention)
        ):
            continue
        rest = step.message.split("\n", 1)
        step.message = line + ("\n" + rest[1] if len(rest) > 1 else "")
        step.conforms = True
        kept += 1
    return kept
