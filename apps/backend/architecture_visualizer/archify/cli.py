"""Calling archify, and reading what it says back.

Every archify command that matters here speaks `--json` and returns a receipt
with the same skeleton: `ok`, `command`, and — when it refuses — a
`diagnostics[]` list where each entry carries a stable `code`, the exact
`subject` at fault, the measured `evidence`, and `supportedFixes`. That is a
closed repair loop rather than "it looked wrong", and it is the reason the
authoring agent can be held to a bounded number of rounds: the diagnostics tell
it what to change, so a round that does not reduce the error count is a round
that has run out of information.

This module does the subprocess and the parsing. It never decides whether a
diagnosis is worth another round — `authoring.py` owns that.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .runtime import Readiness, check

logger = logging.getLogger(__name__)

#: Rendering is deterministic and local, but a pathological input should not
#: hold a build open. Generous enough that a real render never hits it.
DEFAULT_TIMEOUT = 180

QUALITY_SHOWCASE = "showcase"
QUALITY_STANDARD = "standard"


class ArchifyUnavailable(RuntimeError):
    """archify cannot run here. Carries the doctor so the caller can say why."""

    def __init__(self, readiness: Readiness):
        self.readiness = readiness
        blockers = (
            "; ".join(f"{c.name}: {c.detail}" for c in readiness.blockers) or "unknown"
        )
        super().__init__(f"archify is unavailable ({blockers})")


@dataclass
class Receipt:
    """One archify invocation, as it reported itself."""

    ok: bool
    command: str
    payload: dict = field(default_factory=dict)
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0

    @property
    def diagnostics(self) -> list[dict]:
        raw = self.payload.get("diagnostics")
        return [d for d in raw if isinstance(d, dict)] if isinstance(raw, list) else []

    @property
    def error_count(self) -> int:
        """How far the candidate is from acceptance, as one comparable number.

        The repair loop stops when this stops reaching a new minimum, so it has
        to count everything a failed run would count — a refusal with no
        diagnostics at all is still one thing wrong, not zero.
        """
        if self.ok:
            return 0
        return max(len(self.diagnostics), 1)

    def summary(self) -> str:
        """One line a human reads, never the raw stderr of a crashed process."""
        if self.ok:
            return f"{self.command}: ok"
        first = self.diagnostics[0] if self.diagnostics else {}
        code = first.get("code")
        message = first.get("message") or self.payload.get("error")
        if code and message:
            return f"{self.command}: {code} — {message}"
        if code:
            return f"{self.command}: {code}"
        if message:
            return f"{self.command}: {message}"
        return f"{self.command}: failed with exit code {self.exit_code}"


def _abs(path: Path) -> str:
    """Absolute, always.

    The subprocess runs with its cwd at the skill root so the renderer resolves
    its own template and validators. A relative path from the caller would be
    reinterpreted against that root — which reads as a missing-file error
    naming a path nobody wrote.
    """
    return str(path.resolve())


def _invoke(args: list[str], timeout: int = DEFAULT_TIMEOUT) -> Receipt:
    readiness = check()
    if not readiness.ok:
        raise ArchifyUnavailable(readiness)

    assert readiness.node and readiness.archify_root  # guaranteed by readiness.ok
    entry = readiness.archify_root / "bin" / "archify.mjs"
    command = [readiness.node, str(entry), *args]

    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            # Relative paths inside a receipt resolve against the skill root, and
            # the renderer resolves its own assets from the entry point's
            # location, so the working directory only has to be stable.
            cwd=str(readiness.archify_root),
        )
    except subprocess.TimeoutExpired:
        return Receipt(
            ok=False,
            command=args[0] if args else "archify",
            payload={"error": f"archify timed out after {timeout}s"},
            exit_code=-1,
        )

    payload: dict = {}
    stdout = completed.stdout or ""
    if stdout.strip().startswith("{"):
        try:
            parsed = json.loads(stdout)
            if isinstance(parsed, dict):
                payload = parsed
        except json.JSONDecodeError:
            logger.debug("archify %s produced non-JSON stdout", args[0] if args else "")

    return Receipt(
        # The exit code is the authority. A `--json` payload claiming `ok` on a
        # non-zero exit would be the one case where we report a failure as a
        # success, which the skill contract explicitly forbids.
        ok=completed.returncode == 0 and payload.get("ok", True) is not False,
        command=str(payload.get("command") or (args[0] if args else "archify")),
        payload=payload,
        stdout=stdout,
        stderr=completed.stderr or "",
        exit_code=completed.returncode,
    )


def validate(
    spec: Path,
    diagram_type: str = "architecture",
    quality: str = QUALITY_SHOWCASE,
    repo_root: Path | None = None,
) -> Receipt:
    """Check a candidate. Run after every edit, and before handing anything on."""
    args = [
        "validate",
        diagram_type,
        _abs(spec),
        "--quality",
        quality,
        "--json",
    ]
    if repo_root is not None and diagram_type == "architecture":
        args += ["--repo-root", _abs(repo_root)]
    return _invoke(args)


def deliver(
    spec: Path,
    output: Path,
    diagram_type: str = "architecture",
    quality: str = QUALITY_SHOWCASE,
    repo_root: Path | None = None,
) -> Receipt:
    """Final acceptance: freeze the spec, render it, commit the HTML atomically.

    A non-zero exit is never a success, and a failed delivery leaves any
    previous artifact in place — so the caller must not report the old file as
    the new one.
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "deliver",
        diagram_type,
        _abs(spec),
        _abs(output),
        "--quality",
        quality,
        "--json",
    ]
    if repo_root is not None and diagram_type == "architecture":
        args += ["--repo-root", _abs(repo_root)]
    return _invoke(args)


def compare(
    base: Path,
    head: Path,
    output: Path,
    receipt: Path | None = None,
    quality: str = QUALITY_SHOWCASE,
    repo_root: Path | None = None,
) -> Receipt:
    """Before / Delta / After between two architecture specs.

    Architecture only — the other diagram types reject `compare`, and there is
    nothing to fall back to: a workflow has no component identity to diff.
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "compare",
        "architecture",
        _abs(base),
        _abs(head),
        _abs(output),
        "--quality",
        quality,
        "--json",
    ]
    if receipt is not None:
        receipt.parent.mkdir(parents=True, exist_ok=True)
        args += ["--receipt", _abs(receipt)]
    if repo_root is not None:
        args += ["--repo-root", _abs(repo_root)]
    return _invoke(args)


def doctor() -> Receipt:
    """archify's own self-check, for the diagnostics panel."""
    return _invoke(["doctor"], timeout=60)
