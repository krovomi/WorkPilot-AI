"""What there is to launch in a project, and how.

Files on disk only — no model, no network — so the Kanban can ask before a
build and pay nothing. The answer is a list, because a task can touch an API
and the front end that calls it, and both have to run for either to be
verified.

The detectors already in the repository are reused rather than repeated:
`AppEmulatorRunner` (the Kanban preview's answer for Node, Python, Go, Rust),
`mobile.stacks.detect_stack` (every phone framework) and
`project.stack.detect_api_stack`. What they did not cover is added here
and nowhere else: an ASP.NET Core project, an API written in Node (the
preview treats every `package.json` as a page), Spring Boot, and a monorepo
whose apps live one or two directories down.

A recipe learned by an earlier verification (`.workpilot/verify/recipe.json`,
see `verify.learn`) wins over detection: it is the command that *worked* on
this project, which is stronger evidence than the command its files suggest.
"""

from __future__ import annotations

import json
import logging
import re
import socket
from dataclasses import asdict, dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "KINDS",
    "Target",
    "Detection",
    "detect_targets",
    "free_port",
]

#: The four kinds of thing a verification knows how to drive.
KINDS = ("web-frontend", "desktop", "mobile", "backend-api")

#: Directories never searched for an app: dependencies, build output, VCS.
_SKIP = {
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".workpilot",
    ".worktrees",
    "vendor",
    "Pods",
}

#: Where a monorepo keeps its apps.
_APP_PARENTS = ("apps", "packages", "src", "services")
_APP_NAMES = (
    "frontend",
    "client",
    "web",
    "ui",
    "app",
    "backend",
    "server",
    "api",
)

_NODE_API = ("@nestjs/core", "express", "fastify", "koa", "@hapi/hapi", "hono")
_NODE_FRONTEND = (
    "next",
    "nuxt",
    "nuxt3",
    "vite",
    "react-scripts",
    "@angular/core",
    "@sveltejs/kit",
    "svelte",
    "vue",
    "astro",
)


@dataclass
class Target:
    """One thing to launch."""

    kind: str
    name: str
    #: The directory it runs from, relative to the project ("." for the root).
    root: str = "."
    framework: str = ""
    #: The command line, with ``{port}`` where a port goes. Empty for mobile,
    #: whose commands are per platform (`platforms`).
    command: str = ""
    #: The port the app listens on by default; the launch prefers a free one.
    port: int = 0
    #: A path that answers once the app is up ("/" accepts any HTTP status).
    ready_path: str = "/"
    #: Environment variables that carry the port, per framework.
    port_env: list[str] = field(default_factory=list)
    #: Extra environment for the launch (no secrets: names known to the stack).
    env: dict[str, str] = field(default_factory=dict)
    #: For mobile: the platforms this task asks for.
    platforms: list[str] = field(default_factory=list)
    #: A file of the task lives under `root`.
    touched: bool = False
    #: ``recipe`` when a learned recipe supplied the command, else ``detected``.
    origin: str = "detected"
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Detection:
    targets: list[Target] = field(default_factory=list)
    #: Why there is nothing to launch, when there is nothing.
    reason: str = ""

    @property
    def applicable(self) -> bool:
        return bool(self.targets)

    def primary(self) -> list[Target]:
        """The targets the task touched, or all of them when it touched none.

        A change to a shared library touches no app directly and still has to
        be seen running in each one that uses it.
        """
        touched = [t for t in self.targets if t.touched]
        return touched or list(self.targets)

    def to_dict(self) -> dict:
        return {
            "targets": [t.to_dict() for t in self.targets],
            "reason": self.reason,
            "applicable": self.applicable,
        }


def free_port(preferred: int = 0) -> int:
    """``preferred`` when nothing listens on it, else a free port on loopback."""
    for candidate in ([preferred] if preferred else []) + [0]:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(("127.0.0.1", candidate))
                return sock.getsockname()[1]
        except OSError:
            continue
    return preferred or 0


# ---------------------------------------------------------------------------
# Where apps live
# ---------------------------------------------------------------------------


def _candidate_dirs(project_dir: Path) -> list[Path]:
    """The root, the conventional app folders, and one level under `apps/`…"""
    out = [project_dir]
    for name in (*_APP_NAMES, *_APP_PARENTS):
        child = project_dir / name
        if child.is_dir() and not child.is_symlink():
            out.append(child)
    for parent in _APP_PARENTS:
        base = project_dir / parent
        if not base.is_dir():
            continue
        try:
            children = sorted(base.iterdir())
        except OSError:
            continue
        for child in children[:40]:
            if (
                child.is_dir()
                and not child.is_symlink()
                and child.name not in _SKIP
                and not child.name.startswith(".")
            ):
                out.append(child)
    seen: set[Path] = set()
    unique = []
    for directory in out:
        resolved = directory.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(directory)
    return unique


def _relative(path: Path, project_dir: Path) -> str:
    try:
        rel = path.resolve().relative_to(project_dir.resolve()).as_posix()
    except ValueError:
        return "."
    return rel or "."


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------
# Detectors
# ---------------------------------------------------------------------------


def _package_manager(directory: Path, project_dir: Path) -> str:
    for base in (directory, project_dir):
        if (base / "pnpm-lock.yaml").exists():
            return "pnpm"
        if (base / "yarn.lock").exists():
            return "yarn"
        if (base / "bun.lockb").exists() or (base / "bun.lock").exists():
            return "bun"
    return "npm"


def _node_target(directory: Path, project_dir: Path) -> Target | None:
    pkg = _read_json(directory / "package.json")
    if not pkg:
        return None
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    scripts = pkg.get("scripts") or {}
    if not isinstance(scripts, dict) or not scripts:
        return None
    pm = _package_manager(directory, project_dir)
    rel = _relative(directory, project_dir)
    name = str(pkg.get("name") or (directory.name if rel != "." else "app"))

    def _script(*names: str) -> str:
        for script in names:
            if script in scripts:
                return f"{pm} start" if script == "start" else f"{pm} run {script}"
        return ""

    if "electron" in deps:
        command = _script("dev", "start", "electron:dev")
        if not command:
            return None
        return Target(
            kind="desktop",
            name=name,
            root=rel,
            framework="electron",
            command=command,
            # The debugging endpoint is what answers once the window is up.
            ready_path="/json/version",
            notes=["launched with --remote-debugging-port for Chrome DevTools"],
        )

    is_api = any(d in deps for d in _NODE_API)
    is_frontend = any(d in deps for d in _NODE_FRONTEND)
    if is_api and not is_frontend:
        command = _script("start:dev", "dev", "start")
        if not command:
            return None
        framework = (
            "nestjs"
            if "@nestjs/core" in deps
            else next((d for d in _NODE_API if d in deps), "node")
        )
        return Target(
            kind="backend-api",
            name=name,
            root=rel,
            framework=framework.lstrip("@").split("/")[0],
            command=command,
            port=3000,
            port_env=["PORT"],
        )
    if not is_frontend:
        return None
    try:
        from runners.app_emulator_runner import AppEmulatorRunner

        found = AppEmulatorRunner(str(directory)).detect_project_type()
    except Exception as exc:  # noqa: BLE001 - the preview's detector is optional
        logger.debug("app emulator detection failed in %s: %s", directory, exc)
        found = {}
    command = found.get("startCommand") or _script("dev", "start:dev", "serve", "start")
    if not command:
        return None
    return Target(
        kind="web-frontend",
        name=name,
        root=rel,
        framework=str(found.get("framework") or "node"),
        command=command,
        port=int(found.get("port") or 3000),
        port_env=["PORT"],
        env={"BROWSER": "none"},
    )


_WEB_SDK = re.compile(
    r'Sdk\s*=\s*"Microsoft\.NET\.Sdk\.(?:Web|BlazorWebAssembly)"', re.I
)
_TEST_PROJECT = re.compile(
    r"(?:^|[./_-])(?:unit|integration|e2e)?tests?(?:$|[./_-])", re.I
)


def _dotnet_targets(project_dir: Path) -> list[Target]:
    """Every ASP.NET Core project that is not a test project."""
    out: list[Target] = []
    for csproj in _walk(project_dir, "*.csproj", depth=4):
        if _TEST_PROJECT.search(csproj.stem):
            continue
        try:
            text = csproj.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if not _WEB_SDK.search(text):
            continue
        rel = _relative(csproj, project_dir)
        blazor = "BlazorWebAssembly" in text or (csproj.parent / "Pages").is_dir()
        out.append(
            Target(
                kind="web-frontend" if "BlazorWebAssembly" in text else "backend-api",
                name=csproj.stem,
                root=_relative(csproj.parent, project_dir),
                framework="blazor"
                if blazor and "BlazorWebAssembly" in text
                else "aspnetcore",
                # --no-launch-profile: launchSettings.json's applicationUrl
                # would override ASPNETCORE_URLS, and the port is ours to pick.
                command=f"dotnet run --project {rel} --no-launch-profile",
                port=5000,
                port_env=[],
                env={
                    "ASPNETCORE_URLS": "http://127.0.0.1:{port}",
                    "ASPNETCORE_ENVIRONMENT": "Development",
                    "DOTNET_ENVIRONMENT": "Development",
                },
            )
        )
    return out


def _python_target(directory: Path, project_dir: Path) -> Target | None:
    try:
        from runners.app_emulator_runner import AppEmulatorRunner

        found = AppEmulatorRunner(str(directory))._detect_from_python()  # noqa: SLF001
    except Exception:  # noqa: BLE001
        found = None
    if not found or not found.get("isWeb"):
        return None
    framework = str(found.get("framework") or "python")
    command = str(found.get("startCommand") or "")
    env: dict[str, str] = {}
    if framework == "fastapi":
        command = re.sub(r"--port\s+\d+", "--port {port}", command)
        command = command.replace(" --reload", "") + " --host 127.0.0.1"
    elif framework == "django":
        command = "python manage.py runserver 127.0.0.1:{port} --noreload"
    elif framework == "flask":
        env = {"FLASK_RUN_PORT": "{port}", "FLASK_RUN_HOST": "127.0.0.1"}
    elif framework == "streamlit":
        command += " --server.port {port} --server.headless true"
    return Target(
        kind="web-frontend" if framework == "streamlit" else "backend-api",
        name=directory.name if directory != project_dir else framework,
        root=_relative(directory, project_dir),
        framework=framework,
        command=command,
        port=int(found.get("port") or 8000),
        port_env=["PORT"],
        env=env,
    )


def _jvm_target(directory: Path, project_dir: Path) -> Target | None:
    pom = directory / "pom.xml"
    gradle = next(
        (
            directory / n
            for n in ("build.gradle.kts", "build.gradle")
            if (directory / n).exists()
        ),
        None,
    )
    text = ""
    for manifest in (pom, gradle):
        if manifest and manifest.exists():
            try:
                text += manifest.read_text(encoding="utf-8", errors="replace")
            except OSError:
                # Unreadable manifest: detect from the other one, or not at all.
                continue
    if "spring-boot" not in text:
        return None
    if pom.exists():
        wrapper = "./mvnw" if (directory / "mvnw").exists() else "mvn"
        command = f"{wrapper} -q spring-boot:run"
    else:
        wrapper = "./gradlew" if (directory / "gradlew").exists() else "gradle"
        command = f"{wrapper} -q bootRun"
    return Target(
        kind="backend-api",
        name=directory.name if directory != project_dir else "spring",
        root=_relative(directory, project_dir),
        framework="spring",
        command=command,
        port=8080,
        port_env=["SERVER_PORT"],
    )


def _go_target(directory: Path, project_dir: Path) -> Target | None:
    if not (directory / "go.mod").exists():
        return None
    try:
        stack, _lang = _api_stack(directory)
    except Exception:  # noqa: BLE001
        stack = ""
    if stack != "go":
        return None
    return Target(
        kind="backend-api",
        name=directory.name if directory != project_dir else "go",
        root=_relative(directory, project_dir),
        framework="go",
        command="go run .",
        port=8080,
        port_env=["PORT"],
    )


def _api_stack(directory: Path) -> tuple[str, str]:
    from project.stack import detect_api_stack

    return detect_api_stack(directory)


def _mobile_targets(project_dir: Path) -> list[Target]:
    try:
        from mobile.prompt import requested_targets
        from mobile.stacks import detect_stack
    except ImportError:
        return []
    try:
        stack = detect_stack(project_dir)
    except Exception:  # noqa: BLE001
        stack = None
    if stack is None:
        return []
    platforms = list(requested_targets(project_dir, stack))
    return [
        Target(
            kind="mobile",
            name=stack.framework,
            root=_relative(Path(stack.project_dir), project_dir)
            if stack.project_dir
            else ".",
            framework=stack.framework,
            platforms=platforms,
            notes=[stack.notes] if stack.notes else [],
        )
    ]


def _walk(root: Path, pattern: str, depth: int) -> list[Path]:
    out: list[Path] = []

    def _visit(directory: Path, level: int) -> None:
        if level > depth or len(out) > 60:
            return
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            return
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_dir():
                if entry.name not in _SKIP and not entry.name.startswith("."):
                    _visit(entry, level + 1)
            elif entry.match(pattern):
                out.append(entry)

    _visit(root, 0)
    return out


# ---------------------------------------------------------------------------
# The answer
# ---------------------------------------------------------------------------


def _mark_touched(targets: list[Target], changed_files: list[str] | None) -> None:
    if not changed_files:
        return
    paths = [p.replace("\\", "/").removeprefix("./") for p in changed_files]
    roots = sorted({t.root for t in targets}, key=len, reverse=True)
    for path in paths:
        # The deepest root containing the file owns it; the root "." owns
        # whatever no deeper app claims.
        owner = next(
            (r for r in roots if r != "." and (path == r or path.startswith(r + "/"))),
            ".",
        )
        for target in targets:
            if target.root == owner:
                target.touched = True


def _apply_recipe(targets: list[Target], project_dir: Path) -> list[Target]:
    try:
        from .learn import load_recipe
    except ImportError:
        return targets
    recipe = load_recipe(project_dir)
    if not recipe:
        return targets
    by_name = {t.name: t for t in targets}
    for name, learned in recipe.items():
        target = by_name.get(name)
        if target is None or target.kind == "mobile":
            continue
        command = str(learned.get("command") or "").strip()
        if command:
            target.command = command
            target.origin = "recipe"
        if isinstance(learned.get("ready_path"), str) and learned[
            "ready_path"
        ].startswith("/"):
            target.ready_path = learned["ready_path"]
        if isinstance(learned.get("port"), int) and learned["port"] > 0:
            target.port = learned["port"]
        for step in learned.get("notes") or []:
            if isinstance(step, str) and step not in target.notes:
                target.notes.append(step)
    return targets


def detect_targets(
    project_dir: Path | str, changed_files: list[str] | None = None
) -> Detection:
    """Everything to launch in ``project_dir``. Never raises."""
    root = Path(project_dir)
    if not root.is_dir():
        return Detection(reason="project directory not found")

    targets: list[Target] = []
    try:
        targets.extend(_mobile_targets(root))
        targets.extend(_dotnet_targets(root))
        mobile_roots = {t.root for t in targets if t.kind == "mobile"}
        for directory in _candidate_dirs(root):
            rel = _relative(directory, root)
            if rel in mobile_roots:
                # A Flutter/RN tree carries a package.json or a Gradle build of
                # its own: it is the phone app, not a second web target.
                continue
            for detector in (_node_target, _python_target, _jvm_target, _go_target):
                try:
                    found = detector(directory, root)
                except Exception as exc:  # noqa: BLE001 - one detector never sinks the rest
                    logger.debug("detector %s failed: %s", detector.__name__, exc)
                    found = None
                if found is not None and not any(
                    t.root == found.root and t.kind == found.kind for t in targets
                ):
                    targets.append(found)
    except Exception as exc:  # noqa: BLE001
        logger.warning("verify: detection failed: %s", exc)

    # Two targets with one name would share a log and a recipe entry.
    seen: dict[str, int] = {}
    for target in targets:
        count = seen.get(target.name, 0)
        seen[target.name] = count + 1
        if count:
            target.name = f"{target.name}-{target.root.replace('/', '-')}"

    targets = _apply_recipe(targets, root)
    _mark_touched(targets, changed_files)
    if not targets:
        return Detection(
            reason="nothing to launch: no web app, API, desktop or mobile project found"
        )
    return Detection(targets=targets)
