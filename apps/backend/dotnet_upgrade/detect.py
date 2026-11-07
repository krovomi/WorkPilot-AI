"""What a .NET project is on, which areas it uses, and which .NET a task asks for.

Read from the files on disk only, in a few hundred milliseconds at worst: the
project's TargetFramework through `skills_registry.project` (the same reading
that decides which skills a project gets, `.workpilot/skills.toml` first), and
the SDK attributes and package references of its MSBuild files for the areas.

The areas name the skills' reference files (``references/<area>-dotnetAtoB.md``);
each hop has its own subset, and an area a hop has no file for is skipped there.
The general ones apply to every project; the others are chosen from what the
project files say, so a console app is not handed the EF Core and Blazor notes. What only the code reveals (cryptography
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
    "requested_target",
    "task_asks_for_dotnet11",
    "task_text",
]

ALWAYS_AREAS = (
    "csharp-compiler",
    "core-libraries",
    "sdk-msbuild",
    "extensions",
    "serialization-networking",
    "deployment-runtime",
)

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
    (
        "winforms-wpf",
        re.compile(
            r"<Use(?:WPF|WindowsForms)>\s*true|Sdk=\"Microsoft\.NET\.Sdk\.WindowsDesktop",
            re.IGNORECASE,
        ),
    ),
    (
        "containers-interop",
        re.compile(
            r"<(?:PublishSingleFile|EnableSdkContainerSupport)>\s*true"
            r"|<Container(?:Repository|ImageName|BaseImage)>",
            re.IGNORECASE,
        ),
    ),
)

KNOWN_AREAS = frozenset((*ALWAYS_AREAS, *(area for area, _ in _AREA_SIGNALS)))

# ".NET 10", "dotnet 11", "net9.0", "C# 14" — in a task's words, French or English.
# Only the releases a skill migrates to; the look-behind keeps "planet 11" out.
_TARGET_RE = re.compile(
    r"(?<![a-z])(?:\.?net|dotnet)\s?-?(?P<net>9|10|11)(?:\.0)?(?![\d.]*\d)"
    r"|\b(?:c#|csharp)\s?(?P<cs>13|14|15)\b",
    re.IGNORECASE,
)
_CSHARP_TO_NET = {"13": 9, "14": 10, "15": 11}

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
    # A Dockerfile is the containers signal no project file carries.
    if any(root.glob("Dockerfile*")) or any(
        any(f.parent.glob("Dockerfile*")) for f in files[:50]
    ):
        found.add("containers-interop")
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


def requested_target(text: str) -> int | None:
    """The newest .NET release (9, 10 or 11) a task's words name, None if none.

    "Migrer de .NET 9 vers .NET 10" -> 10: the newest one named is the goal.
    """
    found = [
        int(m["net"]) if m["net"] else _CSHARP_TO_NET[m["cs"]]
        for m in _TARGET_RE.finditer(text or "")
    ]
    return max(found, default=None)


def task_asks_for_dotnet11(text: str) -> bool:
    """Whether a task's words name .NET 11 or C# 15."""
    return requested_target(text) == 11
