"""Running the vendored engine — the only place that does.

**A subprocess, never an import.** Upstream's modules are called `core` and
`design_system`, and `search.py` does `from core import …`: imported into this
process it would resolve WorkPilot's own `core` package and fail, or worse,
half-succeed. So the engine runs as a child process.

**`sys.executable`, never `python3`.** The interpreter running this backend is
the one Python guaranteed to exist on this machine, whatever the OS: `python3`
is usually absent on Windows (`py -3` is the launcher there) and `python` is
sometimes Python 2 elsewhere. `-E -s` keep the caller's ``PYTHONPATH`` and
user site-packages out, `-B` keeps `__pycache__` out of the skill directory —
it is committed, and a build must not dirty it.

Every argument is checked against upstream's own choices before the process
starts, so a model-supplied value can never become an option of `search.py`.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .runtime import skill_dir

__all__ = [
    "DOMAINS",
    "STACKS",
    "EngineError",
    "EngineResult",
    "design_system",
    "search",
    "stack_guidelines",
]

#: `search.py --domain` choices (upstream `core.CSV_CONFIG`).
DOMAINS: tuple[str, ...] = (
    "style",
    "color",
    "chart",
    "landing",
    "product",
    "ux",
    "typography",
    "icons",
    "react",
    "web",
    "google-fonts",
    "gsap",
)

#: `search.py --stack` choices (upstream `data/stacks/*.csv`).
STACKS: tuple[str, ...] = (
    "angular",
    "astro",
    "avalonia",
    "flutter",
    "html-tailwind",
    "javafx",
    "jetpack-compose",
    "laravel",
    "nextjs",
    "nuxt-ui",
    "nuxtjs",
    "react",
    "react-native",
    "shadcn",
    "svelte",
    "swiftui",
    "threejs",
    "uno",
    "uwp",
    "vue",
    "winui",
    "wpf",
)

MAX_QUERY_CHARS = 200
TIMEOUT_SECONDS = 30.0

#: A query is words. Anything that could read as an option or a path is cut.
_QUERY_UNSAFE = re.compile(r"[^\w\s.,'&+/#-]", re.UNICODE)


class EngineError(RuntimeError):
    """The engine could not answer — absent, timed out, or crashed."""


@dataclass(frozen=True)
class EngineResult:
    text: str
    args: tuple[str, ...]


def clean_query(query: str) -> str:
    text = _QUERY_UNSAFE.sub(" ", str(query or ""))
    text = " ".join(text.split())[:MAX_QUERY_CHARS].strip()
    # A leading dash would be read by argparse as an option.
    text = text.lstrip("-").strip()
    if not text:
        raise ValueError("query is empty")
    return text


def _run(args: list[str], cwd: Path | None = None) -> EngineResult:
    root = skill_dir()
    if root is None:
        raise EngineError("ui-ux-pro-max is not installed")
    script = root / "scripts" / "search.py"
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    # The engine colours its ASCII output when it thinks it has a terminal.
    env.pop("COLORTERM", None)
    env["NO_COLOR"] = "1"
    cmd = [sys.executable, "-E", "-s", "-B", str(script), *args]
    try:
        completed = subprocess.run(
            cmd,
            cwd=str(cwd or script.parent),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise EngineError(f"engine timed out after {TIMEOUT_SECONDS:.0f}s") from exc
    except OSError as exc:
        raise EngineError(f"engine could not start: {exc}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip().splitlines()
        raise EngineError(
            "engine failed: "
            + (detail[-1] if detail else f"exit {completed.returncode}")
        )
    return EngineResult(text=completed.stdout.strip(), args=tuple(args))


def _limit(n: int | None, default: int) -> int:
    try:
        value = int(n) if n is not None else default
    except (TypeError, ValueError):
        value = default
    return max(1, min(20, value))


def search(query: str, domain: str | None = None, n: int | None = None) -> EngineResult:
    """One domain search (`--domain`), or upstream's auto-detected domain."""
    args = [clean_query(query), "-n", str(_limit(n, 3))]
    if domain:
        if domain not in DOMAINS:
            raise ValueError(f"unknown domain {domain!r}; one of {', '.join(DOMAINS)}")
        args += ["--domain", domain]
    return _run(args)


def stack_guidelines(query: str, stack: str, n: int | None = None) -> EngineResult:
    if stack not in STACKS:
        raise ValueError(f"unknown stack {stack!r}; one of {', '.join(STACKS)}")
    return _run([clean_query(query), "--stack", stack, "-n", str(_limit(n, 5))])


def design_system(
    query: str,
    project_name: str | None = None,
    *,
    persist_to: Path | None = None,
) -> EngineResult:
    """The full design system as Markdown.

    With ``persist_to``, upstream also writes
    ``<persist_to>/design-system/<slug>/MASTER.md`` — never over an existing
    one: ``--force`` is not passed, ever. Upstream slugs the project name into
    ``[a-z0-9_-]``, so the name cannot steer the write outside ``persist_to``.
    """
    args = [clean_query(query), "--design-system", "-f", "markdown"]
    if project_name:
        args += ["-p", clean_query(project_name)[:60]]
    if persist_to is not None:
        args += ["--persist", "--output-dir", str(Path(persist_to).resolve())]
    return _run(args)


def search_json(query: str, domain: str, n: int = 3) -> list[dict]:
    """Structured rows, for callers that render rather than quote."""
    if domain not in DOMAINS:
        raise ValueError(f"unknown domain {domain!r}")
    result = _run(
        [clean_query(query), "--domain", domain, "-n", str(_limit(n, 3)), "--json"]
    )
    try:
        payload = json.loads(result.text)
    except ValueError as exc:
        raise EngineError("engine returned no JSON") from exc
    rows = payload.get("results") if isinstance(payload, dict) else payload
    return [row for row in rows or [] if isinstance(row, dict)]
