"""What a flaky test's own code says about why it is flaky (#351).

The analyzer reads the error messages of the failing runs. This module reads
the test itself, on every stack, without a model:

- **verdict** from the failure rate: above 0.8 the test almost always fails,
  which is more likely a real bug than a flaky test; from 0.2 it is confirmed
  flaky; below, it fails rarely;
- **where the test is**: its file and line, found from the name the report
  gives it (``tests.test_x::test_y[1]``, ``Shop.Tests.CartTests.Adds``,
  ``src/cart.test.ts::Cart > adds``, ``com.shop.CartTest::adds``,
  ``TestCart``…);
- **causes read in its body**: a sleep or a timeout, the clock or a random
  value, a call to the network, a fixed port, a temporary file or a database,
  global state or environment written by the test, threads or parallel tasks,
  a setup without its teardown. Each cause comes with the lines that show it;
- **stack** of the test, so the quarantine and the fix can be worded in its
  framework's own terms.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from suite_runner.names import parse_test_name

__all__ = [
    "CAUSE_ORDER",
    "SourceCause",
    "TestLocation",
    "locate_test",
    "parse_test_name",
    "source_causes",
    "stack_of",
    "find_test_files",
    "verdict",
]

LIKELY_BUG = 0.8
CONFIRMED = 0.2


def verdict(rate: float) -> str:
    """``likely_bug``, ``flaky`` or ``rare``, from the failure rate."""
    if rate > LIKELY_BUG:
        return "likely_bug"
    if rate >= CONFIRMED:
        return "flaky"
    return "rare"


# --- where the test is ---------------------------------------------------------

_TEST_FILE = re.compile(
    r"(?:^|/)(?:tests?|__tests__|spec|specs|e2e|src/test)/|(?:^|/)test_[^/]+\.py$|_test\.(?:py|go|exs?)$|"
    r"[._-](?:test|spec)s?\.[cm]?[jt]sx?$|(?:Tests?|Spec|IT)\.(?:cs|fs|vb|java|kt|scala|swift|php)$|_spec\.rb$",
    re.I,
)
_SOURCE_EXT = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cs", ".fs", ".vb", ".java", ".kt", ".scala",
    ".go", ".rs", ".rb", ".php", ".swift", ".dart", ".ex", ".exs",
}  # fmt: skip
_SKIP_DIRS = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    "bin",
    "obj",
    "dist",
    "build",
    "target",
    ".workpilot",
}
_MAX_FILES = 5000
_MAX_READ = 400_000
_MAX_BODY_LINES = 160


def find_test_files(root: Path) -> list[str]:
    """The test files of the project (relative, POSIX), vendored folders left out."""
    found: list[str] = []
    stack = [root]
    while stack and len(found) < _MAX_FILES:
        folder = stack.pop()
        try:
            entries = sorted(folder.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_dir():
                if entry.name not in _SKIP_DIRS:
                    stack.append(entry)
                continue
            if entry.suffix.lower() in _SOURCE_EXT:
                relative = entry.relative_to(root).as_posix()
                if _TEST_FILE.search(relative) or entry.name.startswith("test_"):
                    found.append(relative)
    return sorted(found)


@dataclass(frozen=True)
class TestLocation:
    __test__ = False  # not a pytest class

    path: str
    line: int
    body: str
    """The test's own lines, from its definition."""
    source: str
    """The whole file, for what lives around the test (setup, teardown)."""


def _definition(leaf: str) -> re.Pattern[str]:
    if re.fullmatch(r"[\w$]+", leaf):
        name = re.escape(leaf)
        return re.compile(
            rf"(?:\b(?:def|func|fun|fn|sub|function)\s+(?:\([^)]*\)\s*)?{name}\s*[(<\[]"
            rf"|\b{name}\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\{{"
            rf"|\b(?:void|Task|async\s+Task|IEnumerator|ValueTask)\s+{name}\s*\("
            rf"|\b(?:it|test|specify)\s*\(\s*['\"`]{name}['\"`])",
            re.M,
        )
    title = re.escape(leaf)
    return re.compile(
        rf"\b(?:it|test|specify|scenario|describe|context)(?:\.\w+)*\s*\(\s*['\"`]{title}['\"`]",
        re.M,
    )


def _container_hints(container: str) -> list[str]:
    if not container:
        return []
    if "/" in container or re.search(r"\.[cm]?[jt]sx?$", container):
        return [container.replace("\\", "/")]
    parts = [p for p in container.split(".") if p]
    hints = ["/".join(parts)]
    if parts:
        hints.append(parts[-1])
    if len(parts) >= 2:
        hints.append("/".join(parts[-2:]))
    return hints


def _body(lines: list[str], start: int) -> str:
    """The test from its definition: braces counted, or indentation for Python."""
    first = lines[start]
    if first.rstrip().endswith(":") and not first.lstrip().startswith(("it(", "test(")):
        indent = len(first) - len(first.lstrip())
        end = start + 1
        while end < len(lines) and end - start < _MAX_BODY_LINES:
            line = lines[end]
            if line.strip() and len(line) - len(line.lstrip()) <= indent:
                break
            end += 1
        return "\n".join(lines[start:end])
    depth, opened, end = 0, False, start
    while end < len(lines) and end - start < _MAX_BODY_LINES:
        code = re.sub(r"(['\"`])(?:\\.|(?!\1).)*\1", "", lines[end])
        depth += code.count("{") - code.count("}")
        opened = opened or "{" in code
        end += 1
        if opened and depth <= 0:
            break
    return "\n".join(lines[start:end])


def locate_test(
    root: Path, test_name: str, files: list[str] | None = None
) -> TestLocation | None:
    """The file and line of ``test_name`` in the project, or ``None``."""
    container, leaf = parse_test_name(test_name)
    if not leaf:
        return None
    files = find_test_files(root) if files is None else files
    hints = _container_hints(container)
    pattern = _definition(leaf)

    def rank(path: str) -> int:
        stem = PurePosixPath(path).with_suffix("").as_posix()
        score = 0
        for weight, hint in zip((4, 2, 1), hints, strict=False):
            if hint and (
                stem.endswith(hint) or path.endswith(hint) or f"/{hint}" in f"/{stem}"
            ):
                score = max(score, weight)
        return score

    for path in sorted(files, key=lambda p: (-rank(p), p)):
        target = root / path
        try:
            if target.is_symlink():
                continue
            source = target.read_text(encoding="utf-8", errors="replace")[:_MAX_READ]
        except OSError:
            continue
        if leaf not in source:
            continue
        match = pattern.search(source)
        if not match:
            continue
        lines = source.splitlines()
        start = source.count("\n", 0, match.start())
        return TestLocation(
            path=path, line=start + 1, body=_body(lines, start), source=source
        )
    return None


# --- causes read in the code -----------------------------------------------------

CAUSE_ORDER = (
    "timing",
    "randomness",
    "network",
    "shared_state",
    "test_order",
    "concurrency",
    "resource_leak",
)

_SIGNALS: dict[str, re.Pattern[str]] = {
    "timing": re.compile(
        r"\b(?:time\.sleep|Thread\.(?:sleep|Sleep)|Task\.Delay|setTimeout|waitForTimeout|usleep|time\.Sleep|"
        r"tokio::time::sleep|thread::sleep|delay|sleep|Awaitility|SpinWait)\s*[(.]|"
        r"\b(?:timeout|Timeout)\s*[:=(]\s*\d{1,4}\b"
    ),
    "randomness": re.compile(
        r"\b(?:Math\.random|random\.\w+|new\s+Random|Random\.Shared|rand::|rand\.\w+|uuid\w*|Guid\.NewGuid|"
        r"UUID\.randomUUID|Date\.now|datetime\.(?:now|utcnow|today)|date\.today|time\.time|DateTime(?:Offset)?\.(?:Now|UtcNow|Today)|"
        r"Local(?:Date|DateTime|Time)\.now|Instant\.now|time\.Now|System\.currentTimeMillis|faker|Faker)\b|new\s+Date\(\s*\)"
    ),
    "network": re.compile(
        r"\b(?:fetch|axios(?:\.\w+)?|requests\.(?:get|post|put|patch|delete)|httpx\.\w+|urlopen|"
        r"http\.(?:Get|Post)|net\.Dial|reqwest::\w+|RestTemplate|WebClient|Net::HTTP|curl_exec|file_get_contents)\s*\(|"
        r"\bnew\s+HttpClient\b|https?://(?!localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(?:com|org))[\w.-]+"
    ),
    "shared_state": re.compile(
        r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b|\b(?:listen|bind|Listen)\s*\(\s*['\"]?:?\d{3,5}\b|"
        r"['\"]/tmp/|\bPath\.GetTempPath\b|\bos\.TempDir\b|\bsqlite3?\.connect\b|\.(?:sqlite|db)['\"]|"
        r"\bDATABASE_URL\b|\bConnectionStrings?\b"
    ),
    "test_order": re.compile(
        r"^\s*global\s+\w|\bprocess\.env\.\w+\s*=(?!=)|\bos\.environ\[[^\]]+\]\s*=(?!=)|\bos\.environ\.(?:update|setdefault)\(|"
        r"\bEnvironment\.SetEnvironmentVariable\b|\bSystem\.setProperty\b|\bos\.Setenv\b|\bstd::env::set_var\b|"
        r"\bstatic\s+(?!readonly|final|void|async|class|func|fun|\w+\s*\()[\w<>\[\],\s]+\s+\w+\s*=",
        re.M,
    ),
    "concurrency": re.compile(
        r"\b(?:threading\.Thread|new\s+Thread|Task\.Run|Parallel\.\w+|Promise\.all|asyncio\.(?:gather|create_task)|"
        r"ExecutorService|CompletableFuture|thread::spawn|tokio::spawn|ThreadPool\w*)\b|\bgo\s+func\b"
    ),
}

_PAIRS = (
    (re.compile(r"\bbefore(?:All|Each)\s*\("), re.compile(r"\bafter(?:All|Each)\s*\(")),
    (re.compile(r"\bdef\s+setUp(?:Class)?\s*\("), re.compile(r"\bdef\s+tearDown(?:Class)?\s*\(")),
    (re.compile(r"\[(?:OneTime)?SetUp\]|\[TestInitialize\]|\[ClassInitialize\]"),
     re.compile(r"\[(?:OneTime)?TearDown\]|\[TestCleanup\]|\[ClassCleanup\]|IDisposable|IAsyncLifetime")),
    (re.compile(r"@Before(?:All|Each)?\b"), re.compile(r"@After(?:All|Each)?\b")),
    (re.compile(r"\bsetup_(?:method|class|module|function)\s*\("), re.compile(r"\bteardown_(?:method|class|module|function)\s*\(")),
)  # fmt: skip


@dataclass
class SourceCause:
    cause: str
    evidence: list[dict[str, Any]] = field(default_factory=list)
    """``{"line": n, "text": "…"}``: the lines that show it, three at most."""

    def to_dict(self) -> dict[str, Any]:
        return {"cause": self.cause, "evidence": self.evidence}


def _strip_comment(line: str) -> str:
    return re.sub(r"(?:^|\s)(?://|#(?!\[)).*$", "", line)


def source_causes(location: TestLocation) -> list[SourceCause]:
    """The causes the test's body shows, most evident first."""
    found: dict[str, SourceCause] = {}
    for offset, raw in enumerate(location.body.splitlines()):
        line = _strip_comment(raw)
        if not line.strip():
            continue
        for cause, pattern in _SIGNALS.items():
            if pattern.search(line):
                entry = found.setdefault(cause, SourceCause(cause))
                if len(entry.evidence) < 3:
                    entry.evidence.append(
                        {"line": location.line + offset, "text": raw.strip()[:160]}
                    )
    source = location.source
    for setup, teardown in _PAIRS:
        match = setup.search(source)
        if match and not teardown.search(source):
            line = source.count("\n", 0, match.start()) + 1
            text = source.splitlines()[line - 1].strip()[:160]
            found["resource_leak"] = SourceCause(
                "resource_leak", [{"line": line, "text": text}]
            )
            break
    order = {cause: index for index, cause in enumerate(CAUSE_ORDER)}
    return sorted(
        found.values(), key=lambda c: (-len(c.evidence), order.get(c.cause, 99))
    )


# --- the stack of a test ---------------------------------------------------------

_STACKS = {
    ".py": "pytest",
    ".cs": "dotnet", ".fs": "dotnet", ".vb": "dotnet",
    ".java": "jvm", ".kt": "jvm", ".scala": "jvm",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".dart": "dart",
    ".ex": "elixir", ".exs": "elixir",
}  # fmt: skip


def stack_of(path: str, commands: list[str]) -> str:
    """The test framework family of ``path``: ``vitest`` or ``jest`` for JS by the project's commands."""
    suffix = PurePosixPath(path).suffix.lower()
    if suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
        if "vitest" in commands:
            return "vitest"
        return "jest" if "jest" in commands else "js"
    return _STACKS.get(suffix, "other")
