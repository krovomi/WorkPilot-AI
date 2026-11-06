"""What a person told the agent while the build was stopped: ``HUMAN_INPUT.md``.

Two ways put instructions there:

- `cli/build_commands.py` writes the file when someone stops a build with
  Ctrl+C and types what the agent should do next;
- `docs/CLI-USAGE.md` documents writing it by hand
  (``echo "…" > specs/001-name/HUMAN_INPUT.md``).

Nothing read it any more once each subtask got its own session (#326 removed
`get_coding_prompt`, its only reader): the person was told "the agent will read
and follow these instructions" and was not heard. This module is the whole
lifecycle, so the writer, the prompt and the orchestrator agree:

- ``write_human_input`` writes **every** copy of the spec directory. The
  worktree copy is the one the coder reads, but `copy_spec_to_worktree`
  replaces it from the project copy when the build resumes: a file written in
  one copy only is either unread or deleted.
- ``read_human_input`` returns the first non-empty copy, so a file written by
  hand in the project copy during a build still reaches the next session.
- ``human_input_section`` is the block `generate_subtask_prompt` puts first.
- ``archive_human_input`` is called by the orchestrator, never the agent, once a
  session that received the text has run. The file becomes
  ``HUMAN_INPUT.<UTC stamp>.md``: an instruction applies once, and its trace
  stays. A copy whose text changed meanwhile (the person wrote again during the
  session) is left alone, so the new text reaches the next session.

Agents may not write the file: its name is in
``security.path_guard.PROTECTED_CONFIG_NAMES``, which the write hook, the
non-SDK tool executor and the Bash validators all read. Without that, an agent
that read planted content could leave a fake "human instruction" for the
session after it (rule S2).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "HUMAN_INPUT_FILE",
    "MAX_HUMAN_INPUT_CHARS",
    "archive_human_input",
    "human_input_section",
    "read_human_input",
    "write_human_input",
]

HUMAN_INPUT_FILE = "HUMAN_INPUT.md"

#: What reaches a prompt. A pasted log of megabytes is not an instruction; the
#: head of it is kept and the cut is said.
MAX_HUMAN_INPUT_CHARS = 20_000


def _copies(spec_dirs: tuple[Path | str | None, ...]) -> list[Path]:
    """The distinct spec directories given, in order, ``None`` skipped."""
    copies: list[Path] = []
    keys: set[Path] = set()
    for spec_dir in spec_dirs:
        if not spec_dir:
            continue
        path = Path(spec_dir)
        try:
            key = path.resolve()
        except (OSError, RuntimeError):
            key = path
        if key not in keys:
            keys.add(key)
            copies.append(path)
    return copies


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning("could not read %s: %s", path, exc)
        return ""


def write_human_input(text: str, *spec_dirs: Path | str | None) -> list[Path]:
    """Write ``text`` into every copy of the spec directory; the files written."""
    written: list[Path] = []
    for spec_dir in _copies(spec_dirs):
        target = spec_dir / HUMAN_INPUT_FILE
        try:
            spec_dir.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(f".{HUMAN_INPUT_FILE}.tmp")
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(target)
            written.append(target)
        except OSError as exc:
            logger.warning("could not write %s: %s", target, exc)
    return written


def read_human_input(*spec_dirs: Path | str | None) -> str:
    """The person's instructions, from the first copy that has some; ``""``."""
    for spec_dir in _copies(spec_dirs):
        text = _read(spec_dir / HUMAN_INPUT_FILE)
        if text:
            return text
    return ""


def human_input_section(text: str) -> str:
    """The prompt block for ``text``; ``""`` when there is nothing to say."""
    text = (text or "").strip()
    if not text:
        return ""
    cut = ""
    if len(text) > MAX_HUMAN_INPUT_CHARS:
        text = text[:MAX_HUMAN_INPUT_CHARS]
        cut = (
            f"\n\n(The instructions were longer; only the first "
            f"{MAX_HUMAN_INPUT_CHARS} characters are shown.)"
        )
    quoted = text.replace("\n", "\n> ")
    return f"""## Instructions from the person

The person stopped the build and wrote these instructions for you:

> {quoted}{cut}

Follow them. Where they contradict the plan or the description above, they win.
"""


def archive_human_input(
    delivered: str,
    *spec_dirs: Path | str | None,
    now: datetime | None = None,
) -> list[Path]:
    """Rename each copy that still holds ``delivered``; the archives written.

    Called by the orchestrator after a session that received ``delivered`` has
    run. Never raises: an archive that fails means the text is delivered once
    more, which is the lesser error.
    """
    delivered = (delivered or "").strip()
    if not delivered:
        return []
    stamp = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    archived: list[Path] = []
    for spec_dir in _copies(spec_dirs):
        source = spec_dir / HUMAN_INPUT_FILE
        if _read(source) != delivered:
            continue
        target = spec_dir / f"HUMAN_INPUT.{stamp}.md"
        n = 1
        while target.exists():
            n += 1
            target = spec_dir / f"HUMAN_INPUT.{stamp}-{n}.md"
        try:
            source.replace(target)
            archived.append(target)
        except OSError as exc:
            logger.warning("could not archive %s: %s", source, exc)
    return archived
