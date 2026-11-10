"""Where the risk of a repository sits, read from git and the source (#349).

A *hot spot* is a source file a newcomer should approach with care, and the
tour says why in numbers, never in adjectives:

- **churn**: commits that touched it over the last year (``git log``), and
  how many people made them;
- **complexity**: decision points (``if``, loops, ``case``, ``catch``,
  ``&&``/``||``…) counted the same way in every language;
- **danger zone**: what the path or the code is about: security
  (authentication, tokens, crypto, permissions), billing (payments, invoices),
  migrations (schema changes) or infrastructure (CI, containers, IaC);
- **tested**: whether a test file names it, by the conventions of each stack.

No model is called. A repository without git history still gets the
complexity, danger and test columns.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from foundation.git_executable import run_git

from .messages import Text, text

__all__ = [
    "DANGER_KINDS",
    "Hotspot",
    "analyse_hotspots",
    "complexity_of",
    "danger_of",
    "git_churn",
]

DANGER_KINDS = ("security", "billing", "migrations", "infrastructure")

_DANGER_PATHS: dict[str, re.Pattern[str]] = {
    "security": re.compile(
        r"(?:^|[/_.\-])(?:auth\w*|login|logout|sessions?|tokens?|jwt|oauth\w*|sso|saml|crypto\w*|"
        r"encrypt\w*|secrets?|passwords?|permissions?|acl|rbac|policy|policies|guards?|security|csrf|"
        r"identity)(?:[/_.\-]|$)",
        re.I,
    ),
    "billing": re.compile(
        r"(?:^|[/_.\-])(?:billing|payments?|invoices?|stripe|paypal|checkout|subscriptions?|"
        r"pricing|prices?|charges?|refunds?|wallet|ledger)(?:[/_.\-]|$)",
        re.I,
    ),
    "migrations": re.compile(
        r"(?:^|/)(?:migrations?|migrate|alembic|flyway|liquibase|db/migrate|Migrations|schema)(?:/|$)",
        re.I,
    ),
    "infrastructure": re.compile(
        r"(?:^|/)(?:\.github/workflows|\.gitlab-ci|azure-pipelines|Jenkinsfile|Dockerfile|"
        r"docker-compose|terraform|helm|k8s|kubernetes|ansible|infra|deploy)",
        re.I,
    ),
}
# Code that handles a secret or money, whatever the file is called.
_DANGER_CODE: dict[str, re.Pattern[str]] = {
    "security": re.compile(
        r"\b(?:bcrypt|argon2|pbkdf2|jwt\.(?:sign|verify|decode)|hashlib|createHmac|"
        r"SecretKey|AuthorizeAttribute|\[Authorize|@PreAuthorize|password_hash)\b"
    ),
    "billing": re.compile(
        r"\b(?:stripe\.|Stripe\w*Service|PaymentIntent|braintree|adyen|mollie)\b"
    ),
}

_BRANCHES = re.compile(
    r"\b(?:if|elif|elsif|for|foreach|while|case|catch|except|when|guard|unless|until|match)\b|&&|\|\||\?\?|\?(?=[^?.:]*:)"
)
_COMMENT = re.compile(r"//[^\n]*|#[^\n]*|/\*.*?\*/|\"\"\".*?\"\"\"", re.S)

_TEST_NAME = re.compile(
    r"^(?:test_(?P<a>.+)|(?P<b>.+?)(?:[._-](?:test|spec)|Tests?|Spec|_test))$", re.I
)


@dataclass
class Hotspot:
    path: str
    churn: int = 0
    """Commits that touched the file over the period read."""
    authors: int = 0
    complexity: int = 0
    lines: int = 0
    danger: list[str] = field(default_factory=list)
    tested: bool = False
    risk: int = 0
    """0-100, relative to the other files of the same repository."""
    reasons: list[Text] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "churn": self.churn,
            "authors": self.authors,
            "complexity": self.complexity,
            "lines": self.lines,
            "danger": list(self.danger),
            "tested": self.tested,
            "risk": self.risk,
            "reasons": [r.to_dict() for r in self.reasons],
        }


def git_churn(
    root: object, days: int = 365, max_commits: int = 3000
) -> dict[str, tuple[int, int]]:
    """``{path: (commits, authors)}`` over the last ``days``; empty without git history."""
    result = run_git(
        ["log", f"--since={int(days)}.days", "--no-merges", "--no-renames", "--name-only",
         "--format=@@%ae", f"-n{int(max_commits)}"],
        cwd=root,
        timeout=30,
    )  # fmt: skip
    if result.returncode != 0:
        return {}
    commits: Counter[str] = Counter()
    people: dict[str, set[str]] = {}
    author = ""
    for line in result.stdout.splitlines():
        if line.startswith("@@"):
            author = line[2:].strip().lower()
            continue
        path = line.strip()
        if path:
            commits[path] += 1
            people.setdefault(path, set()).add(author)
    return {path: (count, len(people.get(path, ()))) for path, count in commits.items()}


def complexity_of(source: str) -> int:
    """Decision points in ``source``, comments left out."""
    return len(_BRANCHES.findall(_COMMENT.sub(" ", source)))


def danger_of(path: str, source: str = "") -> list[str]:
    """The danger zones ``path`` belongs to, by its path then by its code."""
    found = [kind for kind, pattern in _DANGER_PATHS.items() if pattern.search(path)]
    for kind, pattern in _DANGER_CODE.items():
        if kind not in found and source and pattern.search(source):
            found.append(kind)
    return [kind for kind in DANGER_KINDS if kind in found]


def _tested_stems(files: list[str]) -> set[str]:
    stems: set[str] = set()
    for file in files:
        name = PurePosixPath(file).stem
        name = re.sub(r"\.(?:test|spec)$", "", name, flags=re.I)
        match = _TEST_NAME.match(name)
        if match:
            stems.add((match.group("a") or match.group("b") or "").lower())
        elif (
            "/tests/" in f"/{file}"
            or "/__tests__/" in f"/{file}"
            or "/test/" in f"/{file}"
        ):
            stems.add(name.lower())
    return stems


def _is_test(path: str) -> bool:
    lowered = f"/{path.lower()}"
    return bool(
        re.search(r"/(?:tests?|__tests__|spec|e2e)/", lowered)
        or _TEST_NAME.match(
            re.sub(r"\.(?:test|spec)$", "", PurePosixPath(path).stem, flags=re.I)
        )
    )


def _scaled(value: int, top: int) -> float:
    return value / top if top else 0.0


def analyse_hotspots(
    root: object,
    code_files: list[str],
    read: object,
    limit: int = 15,
    churn: dict[str, tuple[int, int]] | None = None,
) -> list[Hotspot]:
    """The ``limit`` riskiest source files: churn, complexity, danger zone, no test."""
    churn = git_churn(root) if churn is None else churn
    tests = [f for f in code_files if _is_test(f)]
    tested = _tested_stems(tests)
    spots: list[Hotspot] = []
    for path in code_files:
        if path in tests:
            continue
        source = read(path)  # type: ignore[operator]
        commits, authors = churn.get(path, (0, 0))
        stem = PurePosixPath(path).stem.lower()
        spots.append(
            Hotspot(
                path=path,
                churn=commits,
                authors=authors,
                complexity=complexity_of(source),
                lines=source.count("\n")
                + (1 if source and not source.endswith("\n") else 0),
                danger=danger_of(path, source),
                tested=stem in tested,
            )
        )
    if not spots:
        return []
    top_churn = max(s.churn for s in spots)
    top_complexity = max(s.complexity for s in spots)
    for spot in spots:
        score = (
            0.4 * _scaled(spot.churn, top_churn)
            + 0.3 * _scaled(spot.complexity, top_complexity)
            + (0.2 if spot.danger else 0.0)
            + (0.1 if not spot.tested else 0.0)
        )
        spot.risk = round(100 * score)
        if spot.churn:
            spot.reasons.append(
                text("story.reason.churn", count=spot.churn, authors=spot.authors)
            )
        if spot.complexity:
            spot.reasons.append(text("story.reason.complexity", count=spot.complexity))
        for kind in spot.danger:
            spot.reasons.append(text(f"story.danger.{kind}"))
        if not spot.tested:
            spot.reasons.append(text("story.reason.untested"))
    spots.sort(key=lambda s: (-s.risk, -s.churn, s.path))
    return [s for s in spots if s.risk > 10][:limit]
