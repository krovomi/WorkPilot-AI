"""The errors an application printed while it was being verified.

A launch is judged on what it said, and "it said nothing alarming" has to be a
measured answer, not an impression. Three readers already exist in this
repository and are reused rather than imitated:

* `docintel.stacktrace.analyze` — a trace of any backend runtime, attached to
  *this* repository's file:line;
* `self_healing.incident_responder.cicd_mode.parse_build_errors` — the compiler
  and restore codes (`CS0103`, `TS2345`, `NU1101`…), the one table of them;
* below, the handful of lines every runtime prints when it fails without a
  trace: `fail:` (ASP.NET Core's logger), `Traceback`, `panic:`,
  `EADDRINUSE`, an unhandled rejection.

Warnings are not errors, and an error counted twice is still one error: the
fix loop is bounded by whether the count falls, so a count inflated by
repetition would read as progress when a line merely scrolled away.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from pathlib import Path

__all__ = ["VerifyError", "collect_errors", "console_errors", "network_errors"]

MAX_ERRORS = 30


@dataclass
class VerifyError:
    #: ``crash``, ``exception``, ``build``, ``console``, ``network``,
    #: ``http``, ``launch`` or ``environment``.
    kind: str
    message: str
    file: str = ""
    line: int | None = None
    #: Where it was read: ``log:<target>``, ``console``, ``network``, ``probe``.
    source: str = ""

    def key(self) -> str:
        return f"{self.kind}|{self.file}|{self.line}|{_normalise(self.message)}"

    def to_dict(self) -> dict:
        return asdict(self)


def _normalise(message: str) -> str:
    """What makes two printings of one error the same error."""
    text = re.sub(r"\b0x[0-9a-f]+\b|\b\d{2,}\b", "#", message.lower())
    text = re.sub(r"\s+", " ", text)
    return text[:160]


# Lines that are an error by themselves, whatever the runtime.
_ERROR_LINES = (
    (re.compile(r"^\s*fail:\s+(?P<msg>.+)$"), "exception"),  # ASP.NET Core
    (re.compile(r"^\s*crit:\s+(?P<msg>.+)$"), "crash"),
    (re.compile(r"Unhandled exception\.?\s*(?P<msg>.*)$", re.I), "crash"),
    (re.compile(r"^(?P<msg>Traceback \(most recent call last\):)"), "exception"),
    (re.compile(r"^\s*(?P<msg>panic: .+)$"), "crash"),
    (re.compile(r"(?P<msg>UnhandledPromiseRejection\w*.*)$"), "exception"),
    (re.compile(r"(?P<msg>(?:Error: )?listen EADDRINUSE.*)$"), "environment"),
    (re.compile(r"(?P<msg>address already in use.*)$", re.I), "environment"),
    (re.compile(r"(?P<msg>Cannot find module .+)$"), "build"),
    (re.compile(r"(?P<msg>ModuleNotFoundError: .+)$"), "build"),
    (re.compile(r"(?P<msg>ImportError: .+)$"), "build"),
    (re.compile(r"^\s*(?P<msg>(?:\w+\.)*\w*(?:Exception|Error): .+)$"), "exception"),
    (re.compile(r"^\s*\[?ERROR\]?[:\s]+(?P<msg>.+)$"), "exception"),
    (re.compile(r"^\s*ERR!\s+(?P<msg>.+)$"), "build"),
    (re.compile(r"(?P<msg>Failed to compile\.?.*)$"), "build"),
    (
        re.compile(
            r"\[vite\]\s+(?P<msg>(?:Internal server error|Pre-transform error).*)$"
        ),
        "build",
    ),
)

# Lines that look like errors and are not.
_NOT_ERRORS = re.compile(
    r"\b0 errors?\b|\bno errors?\b|errors?: 0\b|error_page|ErrorBoundary|"
    r"--error|on_error|\berrors?\.(?:ts|js|py|cs)\b|DeprecationWarning|warn(?:ing)?:",
    re.I,
)

_ENVIRONMENT_HINTS = re.compile(
    r"connection refused|could not connect|no such host|ECONNREFUSED|"
    r"database .* does not exist|password authentication failed|"
    r"environment variable|is not set|missing (?:required )?(?:config|setting|env)",
    re.I,
)


def _classify(kind: str, message: str) -> str:
    if kind in ("exception", "crash") and _ENVIRONMENT_HINTS.search(message):
        return "environment"
    return kind


def _trace_errors(
    text: str, project_dir: Path | None, source: str
) -> list[VerifyError]:
    try:
        from docintel.stacktrace import analyze
    except Exception:  # noqa: BLE001 - the reader is optional here
        return []
    out: list[VerifyError] = []
    # A log can hold several traces; split on blank-line-separated blocks so
    # each is analysed on its own frames.
    for block in re.split(r"\n\s*\n", text):
        if len(block) > 60_000:
            block = block[-60_000:]
        trace = analyze(block, project_dir)
        if trace is None or not trace.frames:
            continue
        frame = trace.project_frames[0] if trace.project_frames else trace.frames[0]
        message = trace.exception or (block.strip().splitlines() or [""])[0]
        out.append(
            VerifyError(
                kind=_classify("exception", message),
                message=message[:400],
                file=frame.path if frame.origin == "project" else "",
                line=frame.line if frame.origin == "project" else None,
                source=source,
            )
        )
    return out


def _build_errors(text: str, source: str) -> list[VerifyError]:
    try:
        from self_healing.incident_responder.cicd_mode import parse_build_errors
    except Exception:  # noqa: BLE001
        return []
    try:
        errors = parse_build_errors(text)
    except Exception:  # noqa: BLE001
        return []
    return [
        VerifyError(
            kind="build",
            message=f"{e.code} {e.message}".strip()[:400],
            file=e.file,
            line=e.line,
            source=source,
        )
        for e in errors
    ]


def collect_errors(
    text: str, project_dir: Path | str | None = None, source: str = "log"
) -> list[VerifyError]:
    """Every distinct error in ``text``, most specific reading first. Never raises."""
    if not text:
        return []
    root = Path(project_dir) if project_dir else None
    found: list[VerifyError] = []
    found += _trace_errors(text, root, source)
    found += _build_errors(text, source)
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or len(line) > 2000 or _NOT_ERRORS.search(line):
            continue
        for pattern, kind in _ERROR_LINES:
            match = pattern.search(line)
            if match:
                message = (match.group("msg") or line).strip() or line.strip()
                found.append(
                    VerifyError(
                        kind=_classify(kind, message),
                        message=message[:400],
                        source=source,
                    )
                )
                break
    return dedupe(found)


def dedupe(errors: list[VerifyError]) -> list[VerifyError]:
    """One entry per distinct error, keeping the most located one."""
    out: list[VerifyError] = []
    seen_keys: set[str] = set()
    seen_messages: dict[str, int] = {}
    for error in errors:
        key = error.key()
        message_key = _normalise(error.message)
        if key in seen_keys:
            continue
        if message_key in seen_messages:
            # The same message read twice (trace header and line pattern):
            # keep the located copy.
            index = seen_messages[message_key]
            if not out[index].file and error.file:
                out[index] = error
            continue
        seen_keys.add(key)
        seen_messages[message_key] = len(out)
        out.append(error)
        if len(out) >= MAX_ERRORS:
            break
    return out


_CONSOLE_LINE = re.compile(
    r"^msgid=\d+\s+\[(?P<level>\w+)\]\s+(?P<msg>.+?)(?:\s+\(\d+ args?\))?$"
)


def console_errors(console_text: str) -> list[VerifyError]:
    """Errors from a `list_console_messages` answer (or the fallback's list).

    A favicon 404 is the one console error every dev server prints; reporting
    it would teach everyone to ignore the console line.
    """
    out: list[VerifyError] = []
    for raw in (console_text or "").splitlines():
        match = _CONSOLE_LINE.match(raw.strip())
        if not match or match.group("level").lower() not in ("error", "assert"):
            continue
        message = match.group("msg").strip()
        # "Failed to load resource" never names the resource; the network list
        # does, and `network_errors` judges it there (a favicon 404 is noise,
        # a missing script chunk is not).
        if "favicon" in message.lower() or message.startswith(
            "Failed to load resource"
        ):
            continue
        out.append(VerifyError(kind="console", message=message[:400], source="console"))
    return dedupe(out)


_NETWORK_LINE = re.compile(
    r"(?P<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?P<url>\S+)\s+\[(?:failed - )?(?P<status>\d{3}|net::\S+)",
    re.I,
)


def network_errors(network_text: str) -> list[VerifyError]:
    """Failed page requests from `list_network_requests`.

    5xx and transport failures always; a 404/410 on an asset of the page (a
    script chunk, a stylesheet, an image) too. An API path answering 4xx is
    left to the endpoint checks — a 404 can be the answer the test expects.
    """
    out: list[VerifyError] = []
    for raw in (network_text or "").splitlines():
        match = _NETWORK_LINE.search(raw)
        if not match:
            continue
        status = match.group("status")
        url = match.group("url")
        if "favicon" in url.lower():
            continue
        is_api = "/api/" in url.lower() or "/graphql" in url.lower()
        if (
            status.startswith("5")
            or status.startswith("net::")
            or (status in ("404", "410") and not is_api)
        ):
            out.append(
                VerifyError(
                    kind="network",
                    message=f"{match.group('method').upper()} {url} -> {status}",
                    source="network",
                )
            )
    return dedupe(out)
