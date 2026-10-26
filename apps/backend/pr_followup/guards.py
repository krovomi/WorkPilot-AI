"""What a fix commit may not do to get the CI green.

The cheapest way to turn a red check green is to stop running the test, or to
change the pipeline that runs it. Both read as success on the forge and are
the false positive this feature exists to avoid. The fix commits are checked
here, on the diff, before anything is pushed; a commit that does either is
undone and the loop stops for a person.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from workflows.hard_gates import is_test_file

# Added lines that switch a test off, by stack.
_SKIP_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "pytest skip",
        re.compile(r"@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.skip\("),
    ),
    (
        "unittest skip",
        re.compile(r"@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b"),
    ),
    (
        "JS test skipped or focused",
        re.compile(r"\b(?:it|test|describe)\.(?:skip|only|todo)\s*\("),
    ),
    ("JS test disabled", re.compile(r"(?<![\w.])x(?:it|test|describe)\s*\(")),
    (
        ".NET test skipped",
        re.compile(r"\[(?:Fact|Theory|SkippableFact)\s*\([^)]*\bSkip\s*="),
    ),
    (".NET test ignored", re.compile(r"\[\s*Ignore(?:Attribute)?\b")),
    ("JVM test disabled", re.compile(r"@(?:Disabled|Ignore)\b")),
    ("Go test skipped", re.compile(r"\bt\.Skip(?:Now|f)?\(")),
    ("Rust test ignored", re.compile(r"#\[ignore\b")),
)

# Pipeline definitions: changing them is a person's decision, not a fix.
_CI_FILES = re.compile(
    r"(?:^|/)(?:\.github/workflows/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml"
    r"|\.azure-pipelines/.+\.ya?ml|\.circleci/config\.ya?ml|Jenkinsfile|bitbucket-pipelines\.ya?ml)$"
)


@dataclass(frozen=True)
class Violation:
    path: str
    rule: str
    line: str = ""

    def describe(self) -> str:
        where = f"{self.path}: " if self.path else ""
        return f"{where}{self.rule}" + (
            f" ({self.line.strip()[:120]})" if self.line else ""
        )


def check_fix_diff(name_status: str, unified_diff: str) -> list[Violation]:
    """Violations in a fix range.

    `name_status` is `git diff --name-status <before>..HEAD`, `unified_diff`
    is `git diff --unified=0 <before>..HEAD`. Only added lines are read: a fix
    that removes a skip is welcome.
    """
    found: list[Violation] = []
    for raw in name_status.splitlines():
        parts = raw.split("\t")
        if len(parts) < 2:
            continue
        status, path = parts[0].strip(), parts[-1].strip()
        if status.startswith("D") and is_test_file(path):
            found.append(Violation(path, "test file deleted"))
        if _CI_FILES.search(path.replace("\\", "/")):
            found.append(Violation(path, "CI pipeline definition changed"))
        if status.startswith("R") and len(parts) == 3:
            old = parts[1].strip()
            if is_test_file(old) and not is_test_file(path):
                found.append(
                    Violation(old, f"test file renamed out of the test suite to {path}")
                )

    current = ""
    for line in unified_diff.splitlines():
        if line.startswith("+++ "):
            target = line[4:].strip()
            current = target[2:] if target.startswith("b/") else target
            continue
        if not line.startswith("+") or line.startswith("+++"):
            continue
        added = line[1:]
        for rule, pattern in _SKIP_PATTERNS:
            if pattern.search(added):
                found.append(Violation(current, rule, added))
                break
    return found
