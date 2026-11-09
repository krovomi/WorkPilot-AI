"""What a write changes, beyond its text: tests removed, dependencies added.

Guardrail rules can judge the *meaning* of a change, not only its path or a
regex on the new text (#377). Every stack the board supports is covered: a
test is a ``def test_`` in Python, an ``it(...)`` in TypeScript, a ``[Fact]``
in C#, a ``@Test`` in Java or Kotlin, a ``func TestX`` in Go, a ``#[test]`` in
Rust, and so on; a dependency is an entry of the manifest of that stack
(``package.json``, ``*.csproj``, ``pom.xml``, ``go.mod``, ``Cargo.toml``…).

A language this module does not know is never judged here: the textual
conditions of the rule (path, regex) still apply to it.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import PurePosixPath

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

_JS_TEST = re.compile(
    r"""\b(?:it|test|describe|context)(?:\.(?:only|skip|todo|concurrent|each\([^)]*\)))?\s*\(\s*(['"`])(.+?)\1"""
)
_TEST_PATTERNS: dict[str, tuple[re.Pattern[str], ...]] = {
    "python": (
        re.compile(r"^\s*(?:async\s+)?def\s+(test\w*)\s*\(", re.MULTILINE),
        re.compile(r"^\s*class\s+(Test\w*)\b", re.MULTILINE),
    ),
    "javascript": (_JS_TEST,),
    "csharp": (
        re.compile(
            r"\[\s*(?:Fact|Theory|Test|TestMethod|TestCase|DataTestMethod)\b[^\]]*\]"
            r"(?:\s*\[[^\]]*\])*\s*(?:public|private|internal|protected)?\s*(?:static\s+)?"
            r"(?:async\s+)?(?:Task|ValueTask|void)\s+(\w+)\s*\("
        ),
    ),
    "jvm": (
        re.compile(
            r"@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b(?:\([^)]*\))?"
            r"(?:\s*@\w+(?:\([^)]*\))?)*\s*(?:(?:public|private|protected|internal|open|override|suspend)\s+)*"
            r"(?:fun|void)\s+(`[^`]+`|\w+)\s*\("
        ),
    ),
    "go": (
        re.compile(r"^func\s+((?:Test|Benchmark|Fuzz|Example)\w*)\s*\(", re.MULTILINE),
    ),
    "rust": (
        re.compile(
            r"#\[(?:\w+::)?test\b[^\]]*\](?:\s*#\[[^\]]*\])*\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)"
        ),
    ),
    "php": (
        re.compile(r"function\s+(test\w*)\s*\("),
        re.compile(r"(?:@test\b|#\[Test\])[\s\S]{0,200}?function\s+(\w+)\s*\("),
        re.compile(r"""\b(?:it|test)\(\s*(['"])(.+?)\1"""),
    ),
    "ruby": (
        re.compile(r"^\s*def\s+(test_\w+)", re.MULTILINE),
        re.compile(r"""^\s*(?:it|test|scenario)\s+(['"])(.+?)\1""", re.MULTILINE),
    ),
    "swift": (
        re.compile(r"func\s+(test\w*)\s*\("),
        re.compile(r"@Test(?:\([^)]*\))?\s*(?:@\w+\s*)*func\s+(\w+)\s*\("),
    ),
    "dart": (re.compile(r"""\b(?:test|testWidgets|group)\s*\(\s*(['"])(.+?)\1"""),),
    "elixir": (re.compile(r"""^\s*test\s+(['"])(.+?)\1""", re.MULTILINE),),
}
_LANGUAGE_BY_SUFFIX = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "javascript",
    ".tsx": "javascript",
    ".mts": "javascript",
    ".cts": "javascript",
    ".vue": "javascript",
    ".svelte": "javascript",
    ".cs": "csharp",
    ".fs": "csharp",
    ".vb": "csharp",
    ".java": "jvm",
    ".kt": "jvm",
    ".kts": "jvm",
    ".groovy": "jvm",
    ".scala": "jvm",
    ".go": "go",
    ".rs": "rust",
    ".php": "php",
    ".rb": "ruby",
    ".swift": "swift",
    ".dart": "dart",
    ".ex": "elixir",
    ".exs": "elixir",
}

# A path that holds tests, whatever the stack: removing the file removes them.
_TEST_PATH = re.compile(
    r"(?:^|/)(?:tests?|__tests__|specs?|e2e|[\w.-]*[._-](?:tests?|specs?)|test_[\w-]+"
    r"|[\w-]+_(?:test|spec)|[\w-]+\.(?:test|spec)|[\w.-]*(?:Tests?|Specs?))(?:/|\.\w+$)"
)


def language_of(path: str) -> str | None:
    return _LANGUAGE_BY_SUFFIX.get(PurePosixPath(path).suffix.lower())


def defined_tests(path: str, text: str) -> list[str]:
    """The tests ``text`` defines, in order, for the language of ``path``."""
    language = language_of(path)
    if language is None or not text:
        return []
    names: list[str] = []
    for pattern in _TEST_PATTERNS[language]:
        for match in pattern.finditer(text):
            names.append(match.group(match.lastindex or 0))
    return names


def removed_tests(path: str, before: str, after: str) -> list[str]:
    """Tests of ``before`` that ``after`` no longer has (a renamed test counts as removed)."""
    remaining = list(defined_tests(path, after))
    removed = []
    for name in defined_tests(path, before):
        if name in remaining:
            remaining.remove(name)
        else:
            removed.append(name)
    return removed


def is_test_path(path: str) -> bool:
    return bool(_TEST_PATH.search(path.replace("\\", "/")))


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------


def _json_keys(text: str, sections: tuple[str, ...]) -> set[str]:
    try:
        data = json.loads(text) if text.strip() else {}
    except ValueError:
        return set()
    found: set[str] = set()
    if isinstance(data, dict):
        for section in sections:
            block = data.get(section)
            if isinstance(block, dict):
                found.update(str(k) for k in block)
    return found


def _requirement_names(lines: list[str]) -> set[str]:
    names = set()
    for line in lines:
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        match = re.match(r"([A-Za-z0-9][A-Za-z0-9._-]*)", line)
        if match:
            names.add(match.group(1).lower().replace("_", "-"))
    return names


def _toml(text: str) -> dict:
    try:
        return tomllib.loads(text) if text.strip() else {}
    except tomllib.TOMLDecodeError:
        return {}


def _pyproject(text: str) -> set[str]:
    data = _toml(text)
    project = data.get("project") or {}
    names = _requirement_names(
        [d for d in project.get("dependencies") or [] if isinstance(d, str)]
    )
    for group in (project.get("optional-dependencies") or {}).values():
        if isinstance(group, list):
            names |= _requirement_names([d for d in group if isinstance(d, str)])
    poetry = (data.get("tool") or {}).get("poetry") or {}
    for section in ("dependencies", "dev-dependencies"):
        block = poetry.get(section)
        if isinstance(block, dict):
            names |= {k.lower() for k in block if k.lower() != "python"}
    return names


def _cargo(text: str) -> set[str]:
    data = _toml(text)
    names: set[str] = set()
    for section in ("dependencies", "dev-dependencies", "build-dependencies"):
        block = data.get(section)
        if isinstance(block, dict):
            names.update(block)
    workspace = (data.get("workspace") or {}).get("dependencies")
    if isinstance(workspace, dict):
        names.update(workspace)
    return names


def _yaml_keys(text: str, sections: tuple[str, ...]) -> set[str]:
    try:
        import yaml

        data = yaml.safe_load(text) if text.strip() else {}
    except Exception:  # noqa: BLE001 - an unreadable manifest has no dependency to compare
        return set()
    names: set[str] = set()
    if isinstance(data, dict):
        for section in sections:
            block = data.get(section)
            if isinstance(block, dict):
                names.update(str(k) for k in block)
    return names


def _regex_set(pattern: str, flags: int = 0):
    compiled = re.compile(pattern, flags)
    return lambda text: {m.group(1) for m in compiled.finditer(text)}


_MAVEN_DEP = re.compile(r"<dependency>(.*?)</dependency>", re.DOTALL)


def _maven(text: str) -> set[str]:
    names = set()
    for block in _MAVEN_DEP.findall(text):
        group = re.search(r"<groupId>\s*([^<\s]+)", block)
        artifact = re.search(r"<artifactId>\s*([^<\s]+)", block)
        if artifact:
            names.add(f"{group.group(1) if group else ''}:{artifact.group(1)}")
    return names


_GO_MOD = re.compile(
    r"^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}/[^\s]+)\s+v[0-9]", re.MULTILINE
)
_MANIFESTS: list[tuple[re.Pattern[str], object]] = [
    (
        re.compile(r"(?:^|/)package\.json$"),
        lambda t: _json_keys(
            t,
            (
                "dependencies",
                "devDependencies",
                "peerDependencies",
                "optionalDependencies",
            ),
        ),
    ),
    (
        re.compile(r"(?:^|/)composer\.json$"),
        lambda t: _json_keys(t, ("require", "require-dev")),
    ),
    (
        re.compile(r"(?:^|/)[^/]*requirements[^/]*\.(?:txt|in)$"),
        lambda t: _requirement_names(t.splitlines()),
    ),
    (re.compile(r"(?:^|/)pyproject\.toml$"), _pyproject),
    (re.compile(r"(?:^|/)Cargo\.toml$"), _cargo),
    (
        re.compile(r"(?:^|/)go\.mod$"),
        lambda t: {m.group(1) for m in _GO_MOD.finditer(t)},
    ),
    (
        re.compile(
            r"\.(?:cs|fs|vb)proj$|(?:^|/)Directory\.Packages\.props$|(?:^|/)packages\.config$"
        ),
        _regex_set(
            r"""<(?:PackageReference|PackageVersion|package)\b[^>]*?\b(?:Include|id)\s*=\s*["']([^"']+)""",
            re.IGNORECASE,
        ),
    ),
    (re.compile(r"(?:^|/)pom\.xml$"), _maven),
    (
        re.compile(r"(?:^|/)build\.gradle(?:\.kts)?$|(?:^|/)libs\.versions\.toml$"),
        _regex_set(
            r"""\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|kapt|ksp|annotationProcessor|classpath)\s*\(?\s*["']([^"':]+:[^"':]+)"""
        ),
    ),
    (
        re.compile(r"(?:^|/)Gemfile$"),
        _regex_set(r"""^\s*gem\s+["']([^"']+)""", re.MULTILINE),
    ),
    (
        re.compile(r"(?:^|/)pubspec\.yaml$"),
        lambda t: _yaml_keys(t, ("dependencies", "dev_dependencies")),
    ),
    (
        re.compile(r"(?:^|/)Package\.swift$"),
        _regex_set(
            r"""\.package\(\s*(?:name:\s*"[^"]*",\s*)?(?:url|path|id):\s*"([^"]+)\""""
        ),
    ),
    (re.compile(r"(?:^|/)mix\.exs$"), _regex_set(r"\{\s*:(\w+)\s*,")),
]


def is_manifest(path: str) -> bool:
    return any(pattern.search(path.replace("\\", "/")) for pattern, _ in _MANIFESTS)


def dependencies(path: str, text: str) -> set[str] | None:
    """The dependencies a manifest declares, or ``None`` if ``path`` is no manifest."""
    norm = path.replace("\\", "/")
    for pattern, extract in _MANIFESTS:
        if pattern.search(norm):
            found = extract(text)  # type: ignore[operator]
            return {re.sub(r"\s+", "", name) for name in found}
    return None


def added_dependencies(path: str, before: str, after: str) -> list[str]:
    new = dependencies(path, after)
    if new is None:
        return []
    old = dependencies(path, before) or set()
    return sorted(new - old)
