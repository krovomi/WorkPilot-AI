"""The public API of a task's .NET libraries, before and after (lot D).

The QA gate (`qa/dotnet_api_gate.py`) builds each library project the task
touched twice, at the task's base and as QA reviewed it, each in a disposable
copy, and hands both assemblies to `rea.managed_api.public_api_diff`. This
module holds what does not depend on where the copies come from:

* which changed files are .NET (`dotnet_files`), and which projects they make
  worth comparing (`affected_projects`): the projects holding a changed file,
  every project when a file all of them import changed (``Directory.Build.*``,
  ``global.json``, any ``.props`` or ``.targets``); never a test project;
* how one project is built and where its assemblies land (`DotnetBuilder`):
  ``dotnet build -c Release``, then MSBuild's own ``TargetPath`` for each
  target framework, so a custom ``OutputPath`` or the artifacts layout is
  found without guessing; an executable or a test project is not a library;
* how the target frameworks pair (`pair_tfms`): the ones both sides build,
  else the newest of each, which is what a migration retargets;
* the record ``dotnet_public_api.json``, which the hard gate
  ``public-api-stable`` reads.

A build that fails, a missing SDK, a reader REA could not finish or a project
beyond the cap is ``unchecked``: never a pass.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable, Iterable, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

from security.child_env import env_without_credentials

from .locate import ReaLauncher, ReaUnavailable
from .managed_api import BREAKING, COMPATIBLE, ApiDiff, public_api_diff
from .runner import ReaRun, run_rea

__all__ = [
    "FAIL",
    "MAX_PROJECTS",
    "NONE",
    "PASS",
    "RECORD",
    "UNCHECKED",
    "ApiReport",
    "AssemblyResult",
    "DotnetBuilder",
    "ProjectOutputs",
    "affected_projects",
    "cached_outputs",
    "compare_outputs",
    "dotnet_files",
    "load_record",
    "pair_tfms",
    "projects_in",
    "store_outputs",
    "write_record",
]

RECORD = "dotnet_public_api.json"
PASS = "pass"
FAIL = "fail"
NONE = "none"
"""No .NET library changed: nothing to compare, and nothing broken."""
UNCHECKED = "unchecked"

MAX_PROJECTS = 8
_MAX_TFMS = 4
_MAX_DEPTH = 8
_PROJECT_SUFFIXES = (".csproj", ".fsproj", ".vbproj")
_SOURCE_SUFFIXES = (".cs", ".fs", ".fsi", ".vb")
# Files every project of the tree may import: a change there touches them all.
_SHARED_NAMES = frozenset({"global.json", "directory.packages.props"})
_SHARED_SUFFIXES = (".props", ".targets")
_SKIP_DIRS = frozenset(
    {"bin", "obj", "node_modules", ".git", ".vs", ".workpilot", "packages"}
)
# The names .NET test projects go by; the build's IsTestProject settles the rest.
_TEST_PROJECT = re.compile(
    r"(?:^|[._-])(?:tests?|specs?|unittests?|integrationtests?|benchmarks?)$",
    re.IGNORECASE,
)
_TFM = re.compile(r"^(netcoreapp|netstandard|net)(\d+)(?:\.(\d+))?", re.IGNORECASE)
_OUTPUT_TAIL = 1500


def _posix(path: str) -> str:
    path = path.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def dotnet_files(files: Iterable[str]) -> list[str]:
    """The changed files that can move a .NET assembly's public API."""
    found = []
    for name in files:
        lower = _posix(name).lower()
        base = PurePosixPath(lower).name
        if (
            lower.endswith(_PROJECT_SUFFIXES + _SOURCE_SUFFIXES + _SHARED_SUFFIXES)
            or base in _SHARED_NAMES
        ):
            found.append(_posix(name))
    return found


def _shared(path: str) -> bool:
    lower = path.lower()
    return PurePosixPath(lower).name in _SHARED_NAMES or lower.endswith(
        _SHARED_SUFFIXES
    )


def _is_test_project(project: str) -> bool:
    return bool(_TEST_PROJECT.search(PurePosixPath(project).stem))


def projects_in(tree: Path) -> list[str]:
    """Project files under ``tree``, as POSIX paths relative to it."""
    tree = Path(tree)
    found: list[str] = []

    def walk(directory: Path, depth: int) -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda e: e.name)
        except OSError:
            return
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_dir():
                if depth < _MAX_DEPTH and entry.name.lower() not in _SKIP_DIRS:
                    walk(Path(entry.path), depth + 1)
            elif entry.name.lower().endswith(_PROJECT_SUFFIXES):
                found.append(Path(entry.path).relative_to(tree).as_posix())

    walk(tree, 0)
    return found


def affected_projects(projects: Iterable[str], files: Iterable[str]) -> list[str]:
    """The non-test projects among ``projects`` that the changed ``files`` reach."""
    known = sorted({_posix(p) for p in projects})
    changed = dotnet_files(files)
    if any(_shared(f) for f in changed):
        chosen = set(known)
    else:
        by_dir: dict[str, list[str]] = {}
        for project in known:
            by_dir.setdefault(str(PurePosixPath(project).parent), []).append(project)
        chosen = set()
        for name in changed:
            if name.lower().endswith(_PROJECT_SUFFIXES):
                chosen.add(name)
                continue
            # The nearest folder up the tree that holds a project owns the file.
            for parent in PurePosixPath(name).parents:
                owners = by_dir.get(str(parent))
                if owners:
                    chosen.update(owners)
                    break
    return sorted(p for p in chosen if not _is_test_project(p))


def _tfm_key(tfm: str) -> tuple[int, int, int]:
    match = _TFM.match(tfm)
    if not match:
        return (-2, 0, 0)
    family, major, minor = match.group(1).lower(), int(match.group(2)), match.group(3)
    if family == "net" and minor is None:
        return (-1, major, 0)  # net48: .NET Framework
    rank = {"netstandard": 0, "netcoreapp": 1, "net": 2}[family]
    return (rank, major, int(minor or 0))


def pair_tfms(before: Iterable[str], after: Iterable[str]) -> list[tuple[str, str]]:
    """The target frameworks to compare: shared ones, else newest against newest."""
    left, right = set(before), set(after)
    common = sorted(left & right, key=_tfm_key)
    if common:
        return [(t, t) for t in common]
    if left and right:
        return [(max(left, key=_tfm_key), max(right, key=_tfm_key))]
    return []


@dataclass
class ProjectOutputs:
    library: bool = False
    outputs: dict[str, str] = field(default_factory=dict)
    """Target framework -> the built assembly's absolute path."""
    error: str = ""
    """Why the project could not be built or read; empty when it was."""


def _tail(text: str) -> str:
    text = (text or "").strip()
    return text[-_OUTPUT_TAIL:]


class DotnetBuilder:
    """Builds one project in a tree and finds its assemblies. Never raises."""

    def __init__(self, dotnet: str, *, timeout: int = 600) -> None:
        self.dotnet = dotnet
        self.timeout = timeout

    def _run(self, tree: Path, args: Sequence[str]) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.dotnet, *args],
            cwd=tree,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=self.timeout,
            check=False,
            env=env_without_credentials(
                extra={
                    "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
                    "DOTNET_NOLOGO": "1",
                    "MSBUILDDISABLENODEREUSE": "1",
                }
            ),
        )

    def _properties(
        self, tree: Path, project: str, names: Sequence[str], tfm: str = ""
    ) -> dict:
        args = ["msbuild", project, "-nologo", "-p:Configuration=Release"]
        if tfm:
            args.append(f"-p:TargetFramework={tfm}")
        args += [f"-getProperty:{n}" for n in names]
        done = self._run(tree, args)
        if done.returncode != 0:
            raise OSError(f"dotnet msbuild failed: {_tail(done.stdout + done.stderr)}")
        out = done.stdout.strip()
        if len(names) == 1:
            return {names[0]: out}
        data = json.loads(out)
        props = data.get("Properties") if isinstance(data, dict) else None
        if not isinstance(props, dict):
            raise ValueError("dotnet msbuild printed no properties")
        return {k: str(v) for k, v in props.items()}

    def __call__(self, tree: Path, project: str) -> ProjectOutputs:
        tree = Path(tree).resolve()
        if project.startswith("-") or not (tree / project).is_file():
            return ProjectOutputs(error=f"{project} is not in the tree")
        try:
            built = self._run(
                tree, ["build", project, "-c", "Release", "--nologo", "-nr:false"]
            )
            if built.returncode != 0:
                return ProjectOutputs(
                    error=f"dotnet build failed: {_tail(built.stdout + built.stderr)}"
                )
            props = self._properties(
                tree,
                project,
                ("OutputType", "IsTestProject", "TargetFramework", "TargetFrameworks"),
            )
            if props.get("OutputType", "").strip().lower() not in ("", "library") or (
                props.get("IsTestProject", "").strip().lower() == "true"
            ):
                return ProjectOutputs(library=False)
            listed = props.get("TargetFrameworks") or props.get("TargetFramework") or ""
            tfms = [t.strip() for t in listed.split(";") if t.strip()][:_MAX_TFMS]
            result = ProjectOutputs(library=True)
            for tfm in tfms:
                raw = self._properties(tree, project, ("TargetPath",), tfm)[
                    "TargetPath"
                ]
                path = Path(raw).resolve() if raw else None
                if (
                    path is None
                    or not path.is_relative_to(tree)
                    or not path.is_file()
                    or path.suffix.lower() != ".dll"
                ):
                    return ProjectOutputs(
                        library=True, error=f"no assembly for {tfm} at {raw or '?'}"
                    )
                result.outputs[tfm] = os.fspath(path)
            if not result.outputs:
                result.error = "the project names no target framework"
            return result
        except subprocess.TimeoutExpired:
            return ProjectOutputs(error=f"dotnet did not finish in {self.timeout} s")
        except (OSError, ValueError) as exc:
            return ProjectOutputs(error=str(exc)[:_OUTPUT_TAIL])


@dataclass
class AssemblyResult:
    project: str
    before: str = ""
    """Target framework of the base assembly."""
    after: str = ""
    status: str = UNCHECKED
    """``breaking``, ``compatible`` or ``unknown`` (`rea.managed_api`)."""
    breaking: list[dict] = field(default_factory=list)
    added: int = 0
    public_members: int = 0
    detail: str = ""


@dataclass
class ApiReport:
    mode: str = "warn"
    status: str = UNCHECKED
    rea: str = ""
    assemblies: list[AssemblyResult] = field(default_factory=list)
    projects: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    unchecked: str = ""

    @property
    def blocking(self) -> list[tuple[AssemblyResult, dict]]:
        return [(a, change) for a in self.assemblies for change in a.breaking]

    def to_dict(self) -> dict:
        return asdict(self)


def compare_outputs(
    before: dict[str, ProjectOutputs],
    after: dict[str, ProjectOutputs],
    projects: Sequence[str],
    *,
    launcher: ReaLauncher | ReaUnavailable,
    project_dir: Path | None = None,
    runner: Callable[..., ReaRun] = run_rea,
    diff: Callable[..., ApiDiff] = public_api_diff,
    timeout: int = 600,
) -> ApiReport:
    """Each library of ``projects`` before and after, decided."""
    report = ApiReport(projects=list(projects))
    if isinstance(launcher, ReaLauncher):
        report.rea = f"rea-agents {launcher.version} ({launcher.source})"
    reasons: list[str] = []
    for project in projects:
        old, new = before.get(project), after.get(project)
        if old is None:
            report.notes.append(f"{project} is new: nothing to compare")
            continue
        if old.error:
            reasons.append(f"{project} at the base: {old.error}")
            continue
        if not old.library:
            continue
        if new is None:
            report.assemblies.append(
                AssemblyResult(
                    project=project,
                    status=BREAKING,
                    breaking=[
                        {
                            "kind": "removed",
                            "member": project,
                            "detail": "the project is gone",
                        }
                    ],
                    detail="the library project was removed",
                )
            )
            continue
        if new.error:
            reasons.append(f"{project}: {new.error}")
            continue
        if not new.library:
            report.assemblies.append(
                AssemblyResult(
                    project=project,
                    status=BREAKING,
                    breaking=[
                        {
                            "kind": "removed",
                            "member": project,
                            "detail": "no longer a library",
                        }
                    ],
                    detail="the project no longer builds a library",
                )
            )
            continue
        pairs = pair_tfms(old.outputs, new.outputs)
        dropped = sorted(set(old.outputs) - {b for b, _ in pairs})
        if dropped and set(old.outputs) & set(new.outputs):
            report.notes.append(f"{project} no longer targets {', '.join(dropped)}")
        if not pairs:
            reasons.append(f"{project}: no target framework to compare")
            continue
        for left_tfm, right_tfm in pairs:
            api = diff(
                Path(old.outputs[left_tfm]),
                Path(new.outputs[right_tfm]),
                launcher=launcher,
                project_dir=project_dir,
                runner=runner,
                timeout=timeout,
            )
            report.assemblies.append(
                AssemblyResult(
                    project=project,
                    before=left_tfm,
                    after=right_tfm,
                    status=api.status,
                    breaking=[asdict(c) for c in api.breaking],
                    added=len(api.added),
                    public_members=api.public_members,
                    detail=api.unknown,
                )
            )
            if api.status not in (BREAKING, COMPATIBLE):
                reasons.append(f"{project} ({right_tfm}): {api.unknown}")
    if report.blocking:
        report.status = FAIL
    elif reasons:
        report.unchecked = "; ".join(reasons)[:800]
    elif report.assemblies:
        report.status = PASS
    else:
        report.status = NONE
        report.unchecked = ""
        report.notes.append("no library among the projects the task changed")
    return report


def store_outputs(cache: Path, project: str, outputs: ProjectOutputs) -> ProjectOutputs:
    """Keep a base build's assemblies under ``cache``; the copy it came from goes."""
    index_path = cache / "index.json"
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = {}
    index = index if isinstance(index, dict) else {}
    kept = ProjectOutputs(library=outputs.library, error=outputs.error)
    slot = cache / str(len(index))
    for tfm, source in outputs.outputs.items():
        dest = slot / re.sub(r"[^A-Za-z0-9._-]", "_", tfm) / Path(source).name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
        kept.outputs[tfm] = os.fspath(dest)
    if not outputs.error:  # a failed build is retried on the next pass
        index[project] = {
            "library": kept.library,
            "outputs": {
                t: Path(p).relative_to(cache).as_posix()
                for t, p in kept.outputs.items()
            },
        }
        cache.mkdir(parents=True, exist_ok=True)
        index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    return kept


def cached_outputs(cache: Path, project: str) -> ProjectOutputs | None:
    try:
        index = json.loads((cache / "index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    entry = index.get(project) if isinstance(index, dict) else None
    if not isinstance(entry, dict):
        return None
    outputs = entry.get("outputs") if isinstance(entry.get("outputs"), dict) else {}
    found = ProjectOutputs(library=bool(entry.get("library")))
    root = cache.resolve()
    for tfm, rel in outputs.items():
        path = (cache / str(rel)).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            return None
        found.outputs[str(tfm)] = os.fspath(path)
    return found


def write_record(spec_dir: Path | str, report: ApiReport) -> None:
    spec_dir = Path(spec_dir)
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / RECORD).write_text(
        json.dumps(report.to_dict(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_record(spec_dir: Path | str) -> dict | None:
    try:
        data = json.loads((Path(spec_dir) / RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
