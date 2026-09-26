"""
CI/CD Mode - Self-Healing Codebase
====================================

Detects test regressions after git push / CI pipeline failures,
analyzes the diff, generates a fix in an isolated worktree,
runs QA validation, and opens a correction PR automatically.

Flow:
1. on_test_failure() triggered by git hook or CI webhook
2. Runs git diff to identify changed files
3. Launches CI/CD analyzer agent with diff + test failures
4. Creates isolated worktree, applies fix
5. Runs QA pipeline in worktree
6. If QA passes -> creates PR with auto-heal label
"""

from __future__ import annotations

import logging
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from rtk import capture_for_model

from .models import (
    CICDIncidentData,
    HealingStatus,
    Incident,
    IncidentMode,
    IncidentSeverity,
    IncidentSource,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Reading a failed pipeline: which tests, which compiler errors
#
# The parsers live here and nowhere else. `docintel` reads a screenshot of a
# failed pipeline with the same functions, so a code the incident model knows
# is a code the attachment reader knows, and the day a toolchain changes its
# output there is one table to fix.
# ---------------------------------------------------------------------------

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


class CICDMode:
    """CI/CD regression detection and auto-fix mode."""

    def __init__(self, project_dir: str | Path):
        self.project_dir = Path(project_dir)

    async def on_test_failure(
        self,
        commit_sha: str,
        branch: str,
        test_output: str,
        failing_tests: list[str] | None = None,
        ci_log_url: str | None = None,
        pipeline_id: str | None = None,
    ) -> Incident:
        """Handle a test failure event from CI/CD.

        Creates an incident and prepares it for the healing pipeline.

        Args:
            commit_sha: The commit that caused the failure.
            branch: The branch where the failure occurred.
            test_output: Raw test runner output.
            failing_tests: List of specific failing test names.
            ci_log_url: URL to the CI pipeline logs.
            pipeline_id: CI pipeline identifier.

        Returns:
            Created Incident ready for healing.
        """
        # Get the diff for the failing commit
        diff_summary = self._get_commit_diff(commit_sha)

        # Parse failing tests from output if not provided
        if not failing_tests:
            failing_tests = self._parse_failing_tests(test_output)
        build_errors = parse_build_errors(test_output)

        # Determine severity based on failure count. A build that does not
        # compile runs no test at all, so "0 failing" there is not "minor".
        if len(failing_tests) > 10:
            severity = IncidentSeverity.CRITICAL
        elif len(failing_tests) > 3 or (build_errors and not failing_tests):
            severity = IncidentSeverity.HIGH
        else:
            severity = IncidentSeverity.MEDIUM

        # Build incident data
        cicd_data = CICDIncidentData(
            commit_sha=commit_sha,
            branch=branch,
            failing_tests=failing_tests,
            diff_summary=diff_summary,
            ci_log_url=ci_log_url,
            pipeline_id=pipeline_id,
            test_output=test_output,
            build_errors=[e.to_dict() for e in build_errors],
        )

        if failing_tests or not build_errors:
            title = f"Test regression: {len(failing_tests)} test(s) failing after {commit_sha[:7]}"
        else:
            codes = ", ".join(dict.fromkeys(e.code or e.tool for e in build_errors[:3]))
            title = f"Build broken after {commit_sha[:7]}: {len(build_errors)} error(s) ({codes})"

        incident = Incident(
            mode=IncidentMode.CICD,
            source=IncidentSource.CI_FAILURE
            if pipeline_id
            else IncidentSource.GIT_PUSH,
            severity=severity,
            title=title,
            description=f"Tests broke after commit {commit_sha[:7]} on branch {branch}. "
            f"{len(failing_tests)} test(s) affected.",
            status=HealingStatus.PENDING,
            source_data=cicd_data.to_dict(),
            regression_commit=commit_sha,
        )

        logger.info(
            f"CI/CD incident created: {incident.title} "
            f"(severity={severity.value}, tests={len(failing_tests)})"
        )
        return incident

    def build_agent_prompt(self, incident: Incident) -> str:
        """Build the prompt for the CI/CD analyzer agent.

        Injects the diff, test failures, and commit context into the prompt template.
        """
        data = incident.source_data
        prompt_path = (
            Path(__file__).parent.parent.parent
            / "prompts"
            / "incident_cicd_analyzer.md"
        )

        try:
            template = prompt_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            template = self._fallback_prompt()

        # Replace template variables
        replacements = {
            "{{DIFF}}": data.get("diff_summary", "No diff available"),
            "{{TEST_FAILURES}}": data.get("test_output", "No test output"),
            "{{COMMIT_SHA}}": data.get("commit_sha", "unknown"),
            "{{COMMIT_MESSAGE}}": self._get_commit_message(data.get("commit_sha", "")),
            "{{BRANCH}}": data.get("branch", "unknown"),
            "{{FAILING_TESTS}}": "\n".join(
                f"- {t}" for t in data.get("failing_tests", [])
            ),
            "{{BUILD_ERRORS}}": render_build_errors(
                [
                    BuildError(**{k: e.get(k) for k in BuildError.__dataclass_fields__})
                    for e in data.get("build_errors") or []
                    if isinstance(e, dict) and e.get("tool")
                ]
            )
            or "None reported.",
        }

        for key, value in replacements.items():
            template = template.replace(key, value)

        return template

    def read_capture(self, path: str | Path) -> tuple[str, str]:
        """(text, problem) from a screenshot or saved log of a failed pipeline.

        Read by `docintel` — local OCR under the project's airgap policy,
        secrets masked, `injection_guard` applied — so a capture reaches the
        incident exactly as an attachment reaches a build. `problem` is empty
        when the text may be used.
        """
        try:
            from docintel.diagnostics import read_capture
        except Exception as exc:  # noqa: BLE001
            return "", f"capture reader unavailable: {exc}"
        doc = read_capture(Path(path), self.project_dir)
        if doc.status == "withheld" and doc.reason == "injection":
            return "", "text in the capture reads like instructions; it was not used"
        if not doc.text:
            return "", f"nothing could be read ({doc.reason or doc.status})"
        return doc.text, ""

    async def run_tests(
        self, working_dir: Path | None = None
    ) -> tuple[bool, str, list[str]]:
        """Run the project test suite and return results.

        Returns:
            Tuple of (all_passed, output, failing_test_names)
        """
        cwd = str(working_dir or self.project_dir)
        test_cmd = self._detect_test_command()

        if not test_cmd:
            return (
                False,
                "No test command detected for this project",
                ["NO_TEST_COMMAND"],
            )

        try:
            result = subprocess.run(
                test_cmd,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=300,
                shell=False,
            )
            output = (result.stdout or "") + "\n" + (result.stderr or "")
            passed = result.returncode == 0
            failing = self._parse_failing_tests(output) if not passed else []
            return passed, output, failing
        except subprocess.TimeoutExpired:
            return False, "Test execution timed out after 300s", ["TIMEOUT"]
        except (FileNotFoundError, OSError) as e:
            return False, f"Failed to run tests: {e}", ["EXECUTION_ERROR"]

    def _detect_test_command(self) -> list[str]:
        """Detect the appropriate test command for the project.

        Returns the command as an argv list (for shell=False execution).
        Returns an empty list when no test command can be inferred.
        """
        project = self.project_dir

        # Python
        if (project / "pytest.ini").exists() or (project / "pyproject.toml").exists():
            if (project / ".venv").exists():
                return [".venv/bin/pytest", "-v", "--tb=short"]
            return ["pytest", "-v", "--tb=short"]

        # Node.js
        if (project / "package.json").exists():
            import json

            try:
                pkg = json.loads((project / "package.json").read_text(encoding="utf-8"))
                scripts = pkg.get("scripts", {})
                if "test" in scripts:
                    if (project / "pnpm-lock.yaml").exists():
                        return ["pnpm", "test"]
                    elif (project / "yarn.lock").exists():
                        return ["yarn", "test"]
                    return ["npm", "test"]
            except (json.JSONDecodeError, OSError):
                pass

        # Go
        if (project / "go.mod").exists():
            return ["go", "test", "./..."]

        # Rust
        if (project / "Cargo.toml").exists():
            return ["cargo", "test"]

        return []

    def _get_commit_diff(self, commit_sha: str) -> str:
        """Get the diff for a specific commit."""
        try:
            result = subprocess.run(
                ["git", "diff", f"{commit_sha}~1..{commit_sha}", "--stat"],
                cwd=str(self.project_dir),
                capture_output=True,
                text=True,
                timeout=30,
            )
            stat = result.stdout

            # The full diff is read by the analyzer agent and by nothing else,
            # so it goes through rtk: the `diff --git` / `index` / `---` / `+++`
            # header block is four lines per file that carry no information the
            # hunks do not. The `--stat` above deliberately does not — it is
            # short already, and it is the half a person reads in the report.
            capture = capture_for_model(
                ["git", "diff", f"{commit_sha}~1..{commit_sha}"],
                cwd=self.project_dir,
                timeout=30,
            )
            # Limit diff size to avoid context overflow
            diff = capture.text
            if len(diff) > 50000:
                diff = diff[:50000] + "\n... [diff truncated at 50KB]"

            return f"--- Stats ---\n{stat}\n--- Full Diff ---\n{diff}"
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
            logger.warning(f"Failed to get commit diff: {e}")
            return f"Failed to get diff for {commit_sha}: {e}"

    def _get_commit_message(self, commit_sha: str) -> str:
        """Get the commit message for a specific commit."""
        if not commit_sha:
            return ""
        try:
            result = subprocess.run(
                ["git", "log", "-1", "--format=%B", commit_sha],
                cwd=str(self.project_dir),
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result.stdout.strip()
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            return ""

    def _parse_failing_tests(self, output: str) -> list[str]:
        """Parse failing test names from test runner output."""
        return parse_failing_tests(output)

    def _fallback_prompt(self) -> str:
        return """## YOUR ROLE - CI/CD INCIDENT ANALYZER

You analyze test regressions and generate fixes.

## CONTEXT
- Commit: {{COMMIT_SHA}}
- Branch: {{BRANCH}}
- Commit message: {{COMMIT_MESSAGE}}

## DIFF
{{DIFF}}

## FAILING TESTS
{{FAILING_TESTS}}

## BUILD ERRORS
{{BUILD_ERRORS}}

## TEST OUTPUT
{{TEST_FAILURES}}

## INSTRUCTIONS
1. Identify which changes in the diff caused the test failures
2. Generate the minimal fix to make all tests pass
3. Do not change the tests unless they are incorrect
4. Commit with message: "fix: auto-heal regression from {{COMMIT_SHA}}"
"""
