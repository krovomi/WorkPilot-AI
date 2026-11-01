"""What a task's change set can affect: program behaviour, or only text.

A card that creates `toto.txt` and one that rewrites the payment service went
through the same QA session: start the dev environment, run every test suite
with coverage, grep the whole repository for `eval(` and hard-coded secrets,
look the libraries up in Context7. For the first card all of it measures the
repository, not the change, and the greps alone returned hundreds of
kilobytes of `node_modules` into the reviewer's context.

This module answers the one question that decides how much of that applies,
from git and file names only, so the answer is the same for every provider
and every model:

- ``light``: every changed path is plain text or documentation that no build,
  test runner or interpreter reads (README, notes, `.txt`), and the change is
  small. Tests and coverage cannot have moved, so the reviewer checks the
  change against the spec instead of re-measuring the repository.
- ``light`` too when git shows no change at all: nothing a program reads
  moved, so there is nothing to test. The reviewer checks whether the
  repository already holds what the spec asks (a `tutu.txt` merged by an
  earlier card) or sends the coder back, but it never asks for tests. Sent
  to the full review, an empty change met the coverage gate, and the fixer
  invented test projects to get a number for a task that wrote no code.
- ``full``: anything else, including every case where the change set cannot
  be read. Unknown is never light.

``touches_code`` is the separate, narrower fact the coverage gate needs: did
any file a program reads change. A text-only change too large for the light
review still gets the full review, but no coverage demand: coverage cannot
have moved.

The list of text extensions is deliberately short. JSON, YAML, TOML, XML,
`.env`, `.csproj`, lockfiles and shell scripts are configuration a program
reads, so they keep the full review.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import PurePosixPath

#: Extensions of files nothing executes or parses at build/run time.
TEXT_ONLY_EXTENSIONS = frozenset(
    {".txt", ".md", ".markdown", ".rst", ".adoc", ".asciidoc", ".text"}
)

#: Extension-less names that are documentation by convention.
TEXT_ONLY_NAMES = frozenset(
    {"license", "licence", "notice", "authors", "contributors", "changelog", "readme"}
)

#: Above these, a text-only change is still reviewed in full: a reviewer
#: handed a 2 000-line documentation rewrite inline would read more than the
#: full session costs.
LIGHT_MAX_FILES = 10
LIGHT_MAX_CHANGED_LINES = 400

#: The kill switch, for a project that wants every card reviewed in full.
LIGHT_QA_ENV = "WORKPILOT_QA_LIGHT"

#: The reason of the scope of an empty change set.
NO_CHANGE_REASON = "no file changed"

#: Paths of the pipeline's own bookkeeping, never part of the change set.
_IGNORED_PREFIXES = (".workpilot/", ".auto-claude/")


def is_text_only_path(path: str) -> bool:
    """True when nothing builds, runs or parses the file at ``path``."""
    name = PurePosixPath(path.replace("\\", "/")).name.lower()
    if not name:
        return False
    suffix = PurePosixPath(name).suffix
    if suffix:
        return suffix in TEXT_ONLY_EXTENSIONS
    return name in TEXT_ONLY_NAMES


def light_qa_enabled() -> bool:
    """False when the project turned the light review off."""
    return os.environ.get(LIGHT_QA_ENV, "1").strip().lower() not in (
        "0",
        "false",
        "off",
        "no",
    )


@dataclass(frozen=True)
class ChangeScope:
    """The change set of a task and the review it calls for."""

    level: str  # "light" | "full"
    reason: str
    files: tuple[str, ...] = field(default_factory=tuple)
    changed_lines: int = 0
    base: str = ""
    #: Whether a file a program reads changed. Unknown is True.
    touches_code: bool = True

    @property
    def is_light(self) -> bool:
        return self.level == "light"


def classify(
    files: list[str] | None, changed_lines: int, *, base: str = ""
) -> ChangeScope:
    """The review a change set calls for. ``files=None`` means unknown."""
    if files is None:
        return ChangeScope("full", "change set unknown", base=base)
    kept = tuple(
        sorted({f for f in files if f and not f.startswith(_IGNORED_PREFIXES)})
    )
    code = [f for f in kept if not is_text_only_path(f)]
    if not light_qa_enabled():
        return ChangeScope(
            "full", f"{LIGHT_QA_ENV}=0", kept, changed_lines, base, bool(code)
        )
    if not kept:
        return ChangeScope("light", NO_CHANGE_REASON, base=base, touches_code=False)
    if code:
        return ChangeScope(
            "full",
            f"{len(code)} file(s) a program reads (e.g. {code[0]})",
            kept,
            changed_lines,
            base,
        )
    if len(kept) > LIGHT_MAX_FILES:
        return ChangeScope(
            "full",
            f"{len(kept)} files > {LIGHT_MAX_FILES}",
            kept,
            changed_lines,
            base,
            touches_code=False,
        )
    if changed_lines > LIGHT_MAX_CHANGED_LINES:
        return ChangeScope(
            "full",
            f"{changed_lines} changed lines > {LIGHT_MAX_CHANGED_LINES}",
            kept,
            changed_lines,
            base,
            touches_code=False,
        )
    return ChangeScope(
        "light",
        "text/documentation files only",
        kept,
        changed_lines,
        base,
        touches_code=False,
    )


def _merge_base(project_dir, base_branch: str) -> str | None:
    from .git_executable import run_git

    for ref in (base_branch, f"origin/{base_branch}"):
        result = run_git(["merge-base", ref, "HEAD"], cwd=project_dir, timeout=15)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return None


def _untracked_lines(project_dir, path: str) -> int:
    try:
        with open(
            os.path.join(project_dir, path), encoding="utf-8", errors="replace"
        ) as fh:
            return sum(1 for _ in fh)
    except OSError:
        return LIGHT_MAX_CHANGED_LINES + 1  # unreadable: never light


def change_scope(project_dir, base_branch: str) -> ChangeScope:
    """The change set of the worktree at ``project_dir`` against ``base_branch``.

    Committed and uncommitted changes since the merge base, plus untracked
    files. Any git failure gives ``full``.
    """
    from .git_executable import run_git

    base = _merge_base(project_dir, base_branch)
    if base is None:
        return classify(None, 0)
    diff = run_git(["diff", "--numstat", base], cwd=project_dir, timeout=30)
    untracked = run_git(
        ["ls-files", "--others", "--exclude-standard"], cwd=project_dir, timeout=30
    )
    if diff.returncode != 0 or untracked.returncode != 0:
        return classify(None, 0, base=base)
    files: list[str] = []
    lines = 0
    for row in diff.stdout.splitlines():
        parts = row.split("\t", 2)
        if len(parts) != 3:
            continue
        added, deleted, path = parts
        if " => " in path:
            # A rename: both names count, and binary stats ("-") are not lines.
            files.extend(p.strip("{} ") for p in path.split(" => "))
        else:
            files.append(path)
        if added == "-" or deleted == "-":
            # Binary content is never "text only".
            files.append(path + ".binary")
            continue
        lines += int(added) + int(deleted)
    for path in untracked.stdout.splitlines():
        path = path.strip()
        if path and not path.startswith(_IGNORED_PREFIXES):
            files.append(path)
            lines += _untracked_lines(project_dir, path)
    return classify(files, lines, base=base)


def change_diff(project_dir, scope: ChangeScope, max_chars: int) -> str:
    """The diff of a scope's files against its base, capped at ``max_chars``.

    Untracked files are shown as new files. The cap is marked in the text so
    the reader knows to open the file.
    """
    from .git_executable import run_git

    if not scope.base or not scope.files:
        return ""
    result = run_git(
        ["diff", scope.base, "--", *scope.files], cwd=project_dir, timeout=30
    )
    text = result.stdout if result.returncode == 0 else ""
    tracked = run_git(["ls-files", "--", *scope.files], cwd=project_dir, timeout=30)
    known = set(tracked.stdout.splitlines()) if tracked.returncode == 0 else set()
    for path in scope.files:
        if path in known:
            continue
        try:
            with open(
                os.path.join(project_dir, path), encoding="utf-8", errors="replace"
            ) as fh:
                body = fh.read(max_chars)
        except OSError:
            continue
        added = "".join(f"+{line}\n" for line in body.splitlines())
        text += f"--- /dev/null\n+++ b/{path} (new, untracked)\n{added}"
    if len(text) > max_chars:
        text = (
            text[:max_chars] + "\n[... diff truncated: read the files themselves ...]\n"
        )
    return text
