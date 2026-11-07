"""Reading a failed pipeline: which tests, which compiler errors.

The parsers live here and nowhere else. The incident model
(`self_healing/incident_responder/cicd_mode.py`), the attachment reader
(`docintel/diagnostics.py`) and the verify loop (`verify/errors.py`) read a CI
log, or the OCR of a screenshot of one, with the same functions: a code one of
them knows is a code they all know, and the day a toolchain changes its output
there is one table to fix.

Pure text in, dataclasses out: in `foundation` so that none of those readers
has to import another to share the table (N8 A1, F131).
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

MAX_BUILD_ERRORS = 50


@dataclass
class BuildError:
    """One compiler, restore or packaging error, as the tool printed it."""

    #: ``csc``, ``nuget``, ``msbuild``, ``dotnet-sdk``, ``tsc``, ``npm``,
    #: ``pnpm``, ``rustc``, ``javac``, ``kotlinc``, ``maven``, ``go``,
    #: ``mypy``, ``pytest``.
    tool: str
    #: The tool's own code (``CS0103``, ``NU1101``, ``TS2345``, ``E0425``,
    #: ``ERESOLVE``), or "" when the tool has none (javac, go).
    code: str
    message: str = ""
    file: str = ""
    line: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


#: Code prefix -> tool. Order matters: `NETSDK` before `NU`, `MSB` before `CS`.
_CODE_TOOLS = (
    ("NETSDK", "dotnet-sdk"),
    ("MSB", "msbuild"),
    ("NU", "nuget"),
    ("CS", "csc"),
    ("BC", "vbc"),
    ("FS", "fsc"),
    ("TS", "tsc"),
    ("CA", "analyzer"),
    ("IDE", "analyzer"),
    ("SA", "analyzer"),
)
_CODE = r"(?:NETSDK|MSB|NU|CS|BC|FS|TS|CA|IDE|SA)\d{3,5}"

# `src/Api/Program.cs(12,5): error CS0103: The name 'x' does not exist [Api.csproj]`
# `src/app.ts(12,5): error TS2345: …` — MSBuild's canonical format, which tsc shares.
_CANONICAL = re.compile(
    rf"^\s*(?:\d+>)?(?P<file>[^\s(][^(]*?)\((?P<line>\d+)(?:,\d+)*\)\s*:\s*"
    rf"(?:fatal\s+)?error\s+(?P<code>{_CODE})\s*:\s*(?P<msg>.*?)(?:\s+\[[^\]]+\])?\s*$"
)
# `error NU1101: Unable to find package X` / `MSBUILD : error MSB1009: …`
_BARE_CODE = re.compile(
    rf"(?:^|\s|:)(?:fatal\s+)?error\s+(?P<code>{_CODE})\s*:\s*(?P<msg>.*?)(?:\s+\[[^\]]+\])?\s*$"
)
# `src/app.ts:12:5 - error TS2345: …` (tsc --pretty)
_TSC_PRETTY = re.compile(
    r"^\s*(?P<file>\S+?):(?P<line>\d+):\d+\s+-\s+error\s+(?P<code>TS\d+):\s*(?P<msg>.*)$"
)
_NPM_CODE = re.compile(r"^\s*npm\s+(?:ERR!|error)\s+code\s+(?P<code>E[A-Z0-9_]+)\s*$")
_NPM_MSG = re.compile(r"^\s*npm\s+(?:ERR!|error)\s+(?!code\b)(?P<msg>\S.*)$")
_PNPM = re.compile(r"^\s*(?:\S+\s+)?(?P<code>ERR_PNPM_[A-Z0-9_]+)\s*(?P<msg>.*)$")
_RUSTC = re.compile(r"^\s*error\[(?P<code>E\d{4})\]:\s*(?P<msg>.*)$")
_RUST_AT = re.compile(r"^\s*-->\s*(?P<file>\S+?):(?P<line>\d+)(?::\d+)?\s*$")
_JAVAC = re.compile(r"^\s*(?P<file>\S+\.java):(?P<line>\d+):\s*error:\s*(?P<msg>.*)$")
_MAVEN = re.compile(
    r"^\s*\[ERROR\]\s+(?P<file>\S+\.(?:java|kt|scala)):\[(?P<line>\d+),\d+\]\s*(?P<msg>.*)$"
)
_KOTLIN = re.compile(
    r"^\s*e:\s*(?:file://)?(?P<file>\S+\.kts?):(?:\((?P<line>\d+),\s*\d+\)|(?P<line2>\d+):\d+)"
    r"\s*:?\s*(?P<msg>.*)$"
)
_GO = re.compile(
    r"^\s*(?P<file>\.{0,2}/?[\w./-]+\.go):(?P<line>\d+):\d+:\s*(?P<msg>.+)$"
)
_MYPY = re.compile(
    r"^\s*(?P<file>\S+\.pyi?):(?P<line>\d+):(?:\d+:)?\s*error:\s*(?P<msg>.*?)\s*(?:\[(?P<code>[\w-]+)\])?\s*$"
)
_PYTEST_ERROR = re.compile(
    r"^\s*ERROR\s+(?:collecting\s+)?(?P<file>\S+\.py)(?:::\S+)?(?:\s+-\s+(?P<msg>.*))?$"
)


def _tool_for(code: str) -> str:
    for prefix, tool in _CODE_TOOLS:
        if code.startswith(prefix):
            return tool
    return ""


def _line(value: str | None) -> int | None:
    return int(value) if value and value.isdigit() else None


def parse_build_errors(output: str) -> list[BuildError]:
    """Every compiler, restore and packaging error in a CI log (or its OCR).

    Errors only: a pipeline fails on its errors, and a list padded with the
    two hundred warnings every .NET solution prints is a list nobody reads.
    """
    errors: list[BuildError] = []
    lines = (output or "").splitlines()
    npm_codes: list[BuildError] = []
    for index, raw in enumerate(lines):
        line = raw.rstrip()
        if not line.strip():
            continue
        found: BuildError | None = None
        if m := _CANONICAL.match(line):
            code = m.group("code")
            found = BuildError(
                _tool_for(code),
                code,
                m.group("msg"),
                m.group("file").strip(),
                _line(m.group("line")),
            )
        elif m := _TSC_PRETTY.match(line):
            found = BuildError(
                "tsc",
                m.group("code"),
                m.group("msg"),
                m.group("file"),
                _line(m.group("line")),
            )
        elif m := _BARE_CODE.search(line):
            code = m.group("code")
            found = BuildError(_tool_for(code), code, m.group("msg"))
        elif m := _NPM_CODE.match(line):
            found = BuildError("npm", m.group("code"))
            npm_codes.append(found)
        elif (m := _NPM_MSG.match(line)) and npm_codes and not npm_codes[-1].message:
            npm_codes[-1].message = m.group("msg").strip()
            continue
        elif m := _PNPM.match(line):
            found = BuildError("pnpm", m.group("code"), m.group("msg").strip())
        elif m := _RUSTC.match(line):
            found = BuildError("rustc", m.group("code"), m.group("msg"))
            for follow in lines[index + 1 : index + 4]:
                if at := _RUST_AT.match(follow):
                    found.file, found.line = at.group("file"), _line(at.group("line"))
                    break
        elif m := _JAVAC.match(line):
            found = BuildError(
                "javac", "", m.group("msg"), m.group("file"), _line(m.group("line"))
            )
        elif m := _MAVEN.match(line):
            found = BuildError(
                "maven", "", m.group("msg"), m.group("file"), _line(m.group("line"))
            )
        elif m := _KOTLIN.match(line):
            found = BuildError(
                "kotlinc",
                "",
                m.group("msg"),
                m.group("file"),
                _line(m.group("line") or m.group("line2")),
            )
        elif m := _MYPY.match(line):
            found = BuildError(
                "mypy",
                m.group("code") or "",
                m.group("msg"),
                m.group("file"),
                _line(m.group("line")),
            )
        elif m := _PYTEST_ERROR.match(line):
            found = BuildError(
                "pytest", "collection", (m.group("msg") or "").strip(), m.group("file")
            )
        elif (m := _GO.match(line)) and not line.lstrip().startswith(("---", "===")):
            found = BuildError(
                "go", "", m.group("msg"), m.group("file"), _line(m.group("line"))
            )
        if found is not None:
            found.message = found.message.strip()[:300]
            errors.append(found)

    unique: list[BuildError] = []
    seen: set[tuple] = set()
    for error in errors:
        key = (error.tool, error.code, error.file, error.line, error.message)
        if key not in seen:
            seen.add(key)
            unique.append(error)
    return unique[:MAX_BUILD_ERRORS]


_DOTNET_FAILED = re.compile(
    r"^\s*Failed\s+(?P<name>[\w.+`<>]+(?:\([^)]*\))?)\s+\[[\d.,]+\s*[a-zµ]*\s*\]"
)
_GRADLE_FAILED = re.compile(r"^\s*(?P<cls>[\w.$]+)\s+>\s+(?P<name>.+?)\s+FAILED\s*$")
_SUREFIRE_FAILED = re.compile(r"^\s*\[ERROR\]\s+(?P<name>[\w$]+(?:\.[\w$]+)+):\d+\s")


def parse_failing_tests(output: str) -> list[str]:
    """Failing test names from a test runner's output (or its OCR)."""
    failing: list[str] = []

    for line in (output or "").splitlines():
        line_stripped = line.strip()

        # pytest: FAILED tests/test_foo.py::test_bar
        if line_stripped.startswith("FAILED "):
            failing.append(line_stripped[7:].split(" ")[0])

        # jest/vitest: FAIL src/foo.test.ts
        elif line_stripped.startswith("FAIL "):
            failing.append(line_stripped[5:].strip())

        # go: --- FAIL: TestFoo (0.00s)
        elif line_stripped.startswith("--- FAIL:"):
            test_name = line_stripped[9:].split("(")[0].strip()
            failing.append(test_name)

        # cargo: test orders::create ... FAILED
        elif "test " in line_stripped and "... FAILED" in line_stripped:
            test_name = line_stripped.split("test ")[1].split(" ...")[0]
            failing.append(test_name)

        # dotnet test: Failed Acme.Tests.OrderTests.Create_Returns201 [12 ms]
        elif m := _DOTNET_FAILED.match(line):
            failing.append(m.group("name"))

        # gradle: OrderServiceTest > create() FAILED
        elif m := _GRADLE_FAILED.match(line):
            failing.append(f"{m.group('cls')}.{m.group('name')}")

        # maven surefire: [ERROR]   OrderServiceTest.create:42 expected…
        elif m := _SUREFIRE_FAILED.match(line):
            failing.append(m.group("name"))

    return list(dict.fromkeys(failing))


def render_build_errors(errors: list[BuildError], limit: int = 25) -> str:
    """One line per error, code first: the code is what gets searched for."""
    lines = []
    for error in errors[:limit]:
        where = (
            f" `{error.file}:{error.line}`"
            if error.file and error.line
            else (f" `{error.file}`" if error.file else "")
        )
        code = error.code or error.tool
        message = f" — {error.message}" if error.message else ""
        lines.append(f"- **{code}** ({error.tool}){where}{message}")
    if len(errors) > limit:
        lines.append(f"- … {len(errors) - limit} more")
    return "\n".join(lines)
