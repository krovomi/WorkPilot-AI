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
- ``targeted``: a small code change (at most ``TARGETED_MAX_CODE_FILES`` code
  files and ``TARGETED_MAX_CHANGED_LINES`` changed lines in them, text files
  aside) in a language whose test convention is known (Python,
  TypeScript/JavaScript and their frameworks, .NET/Blazor, the JVM, Go, Rust,
  PHP, Swift, Dart/Flutter, Ruby, Elixir, C/C++), where every changed code
  file has a test the naming conventions point to (`foundation.touched_tests`,
  `foundation.test_conventions`).
  The reviewer runs only those tests, measures the coverage of the touched
  files, and gets no subagent roster. Any doubt keeps the full review: a file
  of another type, a generated file, a deleted file, a security-sensitive
  path (``security/``, ``server/auth*``, CI), a dependency manifest or tool
  configuration, a changed file with no test.
- ``full``: anything else, including every case where the change set cannot
  be read. Unknown is never light, and never targeted.

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
import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from .test_conventions import inline_marker
from .touched_tests import is_mappable, map_tests

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


#: Above these, a code change gets the full review rather than the targeted
#: one. Counted on code files only: text files changed alongside are free.
TARGETED_MAX_CODE_FILES = 3
TARGETED_MAX_CHANGED_LINES = 150

#: The kill switch of the targeted tier alone.
TARGETED_QA_ENV = "WORKPILOT_QA_TARGETED"

#: Directories whose content is generated or vendored: never targeted.
_GENERATED_DIRS = frozenset(
    {
        "dist",
        "build",
        "out",
        "coverage",
        "node_modules",
        "vendor",
        "generated",
        "__generated__",
        ".agents",
    }
)
_GENERATED_SUFFIXES = (
    ".min.js",
    ".d.ts",
    "_pb2.py",
    "_pb2_grpc.py",
    ".generated.ts",
    ".generated.js",
    ".gen.ts",
    ".g.ts",
    # .NET designers and source generators
    ".designer.cs",
    ".designer.vb",
    ".g.cs",
    ".g.i.cs",
    ".generated.cs",
    # Go, Dart, Swift, Kotlin code generators (protobuf, mockgen, freezed...)
    ".pb.go",
    "_generated.go",
    "_gen.go",
    "_mock.go",
    ".g.dart",
    ".freezed.dart",
    ".pb.dart",
    ".mocks.dart",
    ".pb.swift",
    ".grpc.swift",
)
#: Header markers of a generated file, read from its first lines.
GENERATED_MARKERS = ("@generated", "do not edit", "auto-generated", "autogenerated")

#: Code files that configure a whole tool or the dependencies, not a feature:
#: a change there can move every test, so the touched tests do not cover it.
_PROJECT_WIDE_NAMES = frozenset(
    {
        "conftest.py",
        "setup.py",
        "noxfile.py",
        "tasks.py",
        "manage.py",
        # .NET host and assembly-wide files
        "program.cs",
        "startup.cs",
        "globalusings.cs",
        "assemblyinfo.cs",
        "_imports.razor",
        # build scripts and manifests written in the language itself
        "build.rs",
        "package.swift",
        "mix.exs",
        "config.exs",
        "runtime.exs",
        "testhelper.php",
        "bootstrap.php",
        "spec_helper.rb",
        "rails_helper.rb",
        "test_helper.rb",
        "test_helper.exs",
    }
)

#: The targeted prompt puts the touched files and their tests in commands for
#: the reviewer to run: a path from the target repository with a space, `;`,
#: `$` or a quote in it is data that would become shell syntax, so such a
#: change keeps the full review (security rule S2: closed list, in code).
_SAFE_PATH = re.compile(r"[A-Za-z0-9_./@+-]+")

#: Dependency manifests that look like text but a package manager reads.
_MANIFEST_PREFIXES = ("requirements", "constraints")


def is_text_only_path(path: str) -> bool:
    """True when nothing builds, runs or parses the file at ``path``."""
    name = PurePosixPath(path.replace("\\", "/")).name.lower()
    if not name:
        return False
    if name.startswith(_MANIFEST_PREFIXES) and name.endswith(".txt"):
        return False  # requirements.txt, constraints-dev.txt: pip reads them
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


def targeted_qa_enabled() -> bool:
    """False when the project turned the targeted review off."""
    return os.environ.get(TARGETED_QA_ENV, "1").strip().lower() not in (
        "0",
        "false",
        "off",
        "no",
    )


def targeted_blocker(path: str) -> str | None:
    """Why the code file ``path`` keeps the full review, or None.

    Decided from the name only; `change_scope` adds what needs the disk
    (deleted, generated header).
    """
    p = PurePosixPath(path.replace("\\", "/"))
    name = p.name.lower()
    parts = [part.lower() for part in p.parts]
    if not is_mappable(path):
        return f"{path}: file type the targeted review does not map"
    if "security" in parts[:-1]:
        return f"{path}: security-sensitive path"
    for i, part in enumerate(parts[:-1]):
        if part == "server" and parts[i + 1].startswith("auth"):
            return f"{path}: security-sensitive path"
    if ".github" in parts or ".circleci" in parts or ".gitlab" in parts:
        return f"{path}: CI configuration"
    if set(parts[:-1]) & _GENERATED_DIRS or name.endswith(_GENERATED_SUFFIXES):
        return f"{path}: generated file"
    if name in _PROJECT_WIDE_NAMES or ".config." in name or name.startswith("."):
        return f"{path}: tool or dependency configuration"
    return None


@dataclass(frozen=True)
class ChangeScope:
    """The change set of a task and the review it calls for."""

    level: str  # "light" | "targeted" | "full"
    reason: str
    files: tuple[str, ...] = field(default_factory=tuple)
    changed_lines: int = 0
    base: str = ""
    #: Whether a file a program reads changed. Unknown is True.
    touches_code: bool = True
    #: Targeted only: every test the touched code files map to, and the map
    #: itself as (changed file, its tests) pairs.
    tests: tuple[str, ...] = field(default_factory=tuple)
    test_map: tuple[tuple[str, tuple[str, ...]], ...] = field(default_factory=tuple)

    @property
    def is_light(self) -> bool:
        return self.level == "light"

    @property
    def is_targeted(self) -> bool:
        return self.level == "targeted"

    @property
    def is_full(self) -> bool:
        return self.level == "full"

    @property
    def code_files(self) -> tuple[str, ...]:
        return tuple(f for f in self.files if not is_text_only_path(f))


def _targeted(
    code: list[str],
    code_lines: int,
    repo_files: list[str] | None,
    doubtful: dict[str, str],
    inline: frozenset[str] = frozenset(),
) -> tuple[tuple[tuple[str, tuple[str, ...]], ...], str]:
    """The (changed file, tests) map of a targeted review, or why not."""
    if not targeted_qa_enabled():
        return (), f"{TARGETED_QA_ENV}=0"
    if repo_files is None:
        return (), "repository file list unknown"
    if len(code) > TARGETED_MAX_CODE_FILES:
        return (), f"{len(code)} code files > {TARGETED_MAX_CODE_FILES}"
    if code_lines > TARGETED_MAX_CHANGED_LINES:
        return (), f"{code_lines} changed code lines > {TARGETED_MAX_CHANGED_LINES}"
    for path in code:
        why = doubtful.get(path) or targeted_blocker(path)
        if why:
            return (), why
    mapping, unmapped = map_tests(code, repo_files, inline)
    if unmapped:
        return (), f"no test found for {unmapped[0]}"
    for path in (*code, *(t for tests in mapping.values() for t in tests)):
        if not _SAFE_PATH.fullmatch(path):
            return (), f"{path!r}: characters a command line would interpret"
    return tuple((src, mapping[src]) for src in code), ""


def classify(
    files: list[str] | None,
    changed_lines: int,
    *,
    base: str = "",
    code_lines: int | None = None,
    repo_files: list[str] | None = None,
    doubtful: dict[str, str] | None = None,
    inline_tests: frozenset[str] = frozenset(),
) -> ChangeScope:
    """The review a change set calls for. ``files=None`` means unknown.

    ``code_lines`` is the share of ``changed_lines`` in code files (all of it
    when not given), ``repo_files`` the repository's file list the tests are
    looked up in (None: unknown, never targeted), ``doubtful`` the changed
    files the disk showed to be deleted or generated, with the reason,
    ``inline_tests`` the changed files the disk showed holding their own
    tests (a Rust ``#[cfg(test)]`` module).
    """
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
        lines = changed_lines if code_lines is None else code_lines
        test_map, why_not = _targeted(
            code, lines, repo_files, doubtful or {}, inline_tests
        )
        if test_map:
            tests = tuple(sorted({t for _, ts in test_map for t in ts}))
            return ChangeScope(
                "targeted",
                f"{len(code)} code file(s), {lines} changed code lines, "
                f"{len(tests)} mapped test file(s)",
                kept,
                changed_lines,
                base,
                tests=tests,
                test_map=test_map,
            )
        return ChangeScope(
            "full",
            f"{len(code)} file(s) a program reads (e.g. {code[0]}); "
            f"not targeted: {why_not}",
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


def _generated_header(project_dir, path: str) -> bool:
    """True when the first lines of ``path`` say it is generated."""
    try:
        with open(
            os.path.join(project_dir, path), encoding="utf-8", errors="replace"
        ) as fh:
            head = fh.read(2_000).lower()
    except OSError:
        return True  # unreadable: doubt
    return any(marker in head for marker in GENERATED_MARKERS)


def _inline_test_files(project_dir, code: list[str]) -> frozenset[str]:
    """The changed files that hold their own tests (Rust ``#[cfg(test)]``)."""
    found = set()
    for path in code:
        marker = inline_marker(path)
        if not marker:
            continue
        try:
            with open(
                os.path.join(project_dir, path), encoding="utf-8", errors="replace"
            ) as fh:
                if marker in fh.read(1_000_000):
                    found.add(path)
        except OSError:
            continue  # unreadable: no inline tests, the file needs another
    return frozenset(found)


def _doubtful_code_files(project_dir, code: list[str]) -> dict[str, str]:
    """The changed code files the disk shows to be deleted or generated."""
    doubtful: dict[str, str] = {}
    for path in code:
        if not os.path.isfile(os.path.join(project_dir, path)):
            doubtful[path] = f"{path}: deleted or renamed"
        elif _generated_header(project_dir, path):
            doubtful[path] = f"{path}: generated file"
    return doubtful


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
    code_lines = 0
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
        if not is_text_only_path(path):
            code_lines += int(added) + int(deleted)
    new_files: list[str] = []
    for path in untracked.stdout.splitlines():
        path = path.strip()
        if path and not path.startswith(_IGNORED_PREFIXES):
            files.append(path)
            new_files.append(path)
            count = _untracked_lines(project_dir, path)
            lines += count
            if not is_text_only_path(path):
                code_lines += count
    code = sorted(
        {f for f in files if not f.startswith(_IGNORED_PREFIXES)}
        - {f for f in files if is_text_only_path(f)}
    )
    repo_files: list[str] | None = None
    doubtful: dict[str, str] = {}
    inline: frozenset[str] = frozenset()
    if code and len(code) <= TARGETED_MAX_CODE_FILES:
        # Only a change small enough to be targeted pays for the file list.
        tracked = run_git(["ls-files"], cwd=project_dir, timeout=30)
        if tracked.returncode == 0:
            repo_files = [*tracked.stdout.splitlines(), *new_files]
        doubtful = _doubtful_code_files(project_dir, code)
        inline = _inline_test_files(project_dir, code)
    return classify(
        files,
        lines,
        base=base,
        code_lines=code_lines,
        repo_files=repo_files,
        doubtful=doubtful,
        inline_tests=inline,
    )


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
