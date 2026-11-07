"""What a .NET project is on, which areas it uses, and whether a task asks for .NET 11.

Read from the files on disk only, in a few hundred milliseconds at worst: the
project's TargetFramework through `skills_registry.project` (the same reading
that decides which skills a project gets, `.workpilot/skills.toml` first), and
the SDK attributes and package references of its MSBuild files for the areas.

The areas name the skill's reference files. Four apply to every project; the
others are chosen from what the project files say, so a console app is not
handed the EF Core and Blazor notes. What only the code reveals (cryptography
calls, `BackgroundService`) is left to the procedure's own Step 1.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

__all__ = [
    "ALWAYS_AREAS",
    "KNOWN_AREAS",
    "dotnet_major",
    "project_areas",
    "project_dotnet_version",
    "task_asks_for_dotnet11",
    "task_text",
]

ALWAYS_AREAS = ("csharp-compiler", "core-libraries", "sdk-msbuild", "extensions")

# Area -> what in a project file says the project uses it. `Include="…"` covers a
# PackageReference and, under Central Package Management, a PackageVersion.
_AREA_SIGNALS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "aspnetcore",
        re.compile(
            r'Sdk="Microsoft\.NET\.Sdk\.(?:Web|Razor|BlazorWebAssembly)'
            r'|Include="Microsoft\.AspNetCore\.',
            re.IGNORECASE,
        ),
    ),
    (
        "efcore",
        re.compile(
            r'Include="Microsoft\.(?:EntityFrameworkCore|Data\.Sqlite|Data\.SqlClient)',
            re.IGNORECASE,
        ),
    ),
    (
        "cryptography",
        re.compile(
            r'Include="(?:System\.Security\.Cryptography\.'
            r"|Microsoft\.AspNetCore\.Authentication\.Certificate)",
            re.IGNORECASE,
        ),
    ),
    (
        "runtime-jit",
        re.compile(
            r"<(?:PublishAot|PublishReadyToRun|IsAotCompatible)>\s*true", re.IGNORECASE
        ),
    ),
    (
        "maui",
        re.compile(
            r"<UseMaui>\s*true|net\d+\.\d+-(?:android|ios|maccatalyst|tvos)",
            re.IGNORECASE,
        ),
    ),
)

KNOWN_AREAS = frozenset((*ALWAYS_AREAS, *(area for area, _ in _AREA_SIGNALS)))

# ".NET 11", "dotnet 11", "net11.0", "C# 15" — in a task's words, French or English.
# The look-behind keeps "planet 11" and "Kubernetes 11" out.
_ASKS_RE = re.compile(
    r"(?<![a-z])(?:\.?net|dotnet)\s?-?11(?:\.0)?(?![\d.]*\d)|\bc#\s?15\b|\bcsharp\s?15\b",
    re.IGNORECASE,
)

_MAX_TASK_CHARS = 8000
_MAX_FILE_CHARS = 200_000


def project_dotnet_version(project_dir: Path | str) -> str | None:
    """The project's .NET version (``"10.0"``), declared or detected; None if none."""
    from skills_registry.project import load_project_config

    try:
        config = load_project_config(Path(project_dir))
    except (OSError, ValueError):
        return None
    version = config.targets.get("dotnet")
    return str(version) if version else None


def dotnet_major(version: str | None) -> int | None:
    """``"10.0"`` -> 10; None for no version or one that does not start with a number."""
    if not version:
        return None
    head = str(version).strip().split(".", 1)[0]
    return int(head) if head.isdigit() else None


def project_areas(project_dir: Path | str) -> list[str]:
    """The reference areas this project needs, always-areas first, in a stable order."""
    from skills_registry.project import dotnet_project_files

    root = Path(project_dir)
    files = list(dotnet_project_files(root))
    packages = root / "Directory.Packages.props"
    if packages.is_file():
        files.append(packages)

    found: set[str] = set()
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:_MAX_FILE_CHARS]
        except OSError:
            continue
        for area, signal in _AREA_SIGNALS:
            if area not in found and signal.search(text):
                found.add(area)
    return [*ALWAYS_AREAS, *(area for area, _ in _AREA_SIGNALS if area in found)]


def task_text(spec_dir: Path | str | None) -> str:
    """The task's own words: the requirement as typed, then the spec's head."""
    if not spec_dir:
        return ""
    spec = Path(spec_dir)
    parts: list[str] = []
    try:
        data = json.loads((spec / "requirements.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = None
    if isinstance(data, dict) and isinstance(data.get("task_description"), str):
        parts.append(data["task_description"])
    try:
        parts.append((spec / "spec.md").read_text(encoding="utf-8", errors="replace"))
    except OSError:
        # No spec.md yet (the planner writes it): the requirement alone decides.
        pass
    return "\n".join(parts)[:_MAX_TASK_CHARS]


def task_asks_for_dotnet11(text: str) -> bool:
    """Whether a task's words name .NET 11 or C# 15."""
    return bool(text) and _ASKS_RE.search(text) is not None
