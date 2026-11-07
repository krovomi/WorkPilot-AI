"""How a task's worktree is made ready: `.workpilot/worktree.toml`, or what the stack implies.

A fresh worktree has no dependencies, no local files and no port of its own.
Every agent used to rediscover that on its first build, and for anything but
WorkPilot's own monorepo (whose two `node_modules` were linked in by name)
nothing was installed at all. The recipe says what to run once, after the
checkout and before the first session:

```toml
[setup]
commands = [["dotnet", "restore"], ["dotnet", "tool", "restore"]]
windows  = [["pwsh", "-File", "scripts/setup.ps1"]]   # replaces commands on Windows
copy     = ["appsettings.Development.json"]           # ignored files to copy
link     = []                                         # directories to link (discouraged)
pass_env = ["NPM_TOKEN"]                              # credentials the commands need
timeout_seconds = 900

[ports]
count = 5             # WORKPILOT_PORT .. WORKPILOT_PORT+4

[teardown]
commands = [["docker", "compose", "-p", "${WORKPILOT_TASK_SLUG}", "down", "-v"]]
```

Every command is a list of arguments, never a string for a shell (rule 6):
`["bash", "-c", "..."]` is refused, `["bash", "scripts/setup.sh"]` is fine.
A file that does not validate runs nothing and says why.

Without a file, the recipe is the one the stack implies (`detect_recipe`),
for every stack WorkPilot builds. Its commands are WorkPilot's own, so they
run without an approval; a file comes from the project and runs once the
person approved its exact content (`recipe_approval`).
"""

from __future__ import annotations

import hashlib
import json
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from foundation.platform import is_windows

__all__ = [
    "RECIPE_FILE",
    "Recipe",
    "detect_recipe",
    "load_recipe",
    "recipe_for",
]

RECIPE_FILE = "worktree.toml"
DEFAULT_TIMEOUT = 900
MAX_TIMEOUT = 3600
DEFAULT_PROOF_TIMEOUT = 600
MAX_PORTS = 20
MAX_COMMANDS = 20

#: A shell asked to evaluate a string: the chain rule 6 forbids.
_SHELLS = frozenset(
    {
        "sh",
        "bash",
        "zsh",
        "dash",
        "ksh",
        "fish",
        "cmd",
        "cmd.exe",
        "powershell",
        "powershell.exe",
        "pwsh",
        "pwsh.exe",
    }
)
_EVAL_FLAGS = frozenset({"-c", "/c", "/k", "-command", "-encodedcommand", "-e", "-ec"})


@dataclass(frozen=True)
class Recipe:
    """What to run in a new worktree, and where it came from."""

    source: str  # "file" | "detected"
    setup: tuple[tuple[str, ...], ...] = ()
    copy: tuple[str, ...] = ()
    link: tuple[str, ...] = ()
    #: Credentials the commands need (a private feed's token); every other
    #: credential is kept out of their environment.
    pass_env: tuple[str, ...] = ()
    timeout_seconds: int = DEFAULT_TIMEOUT
    ports: int = 0
    teardown: tuple[tuple[str, ...], ...] = ()
    #: The project's verifiers (Dafny, Lean, Verus, F*…), run by the QA gate
    #: `proof-checks` once the reviewer approves (`core/workspace/proofs.py`).
    proofs: tuple[tuple[str, ...], ...] = ()
    proof_timeout_seconds: int = DEFAULT_PROOF_TIMEOUT
    errors: tuple[str, ...] = ()
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def digest(self) -> str:
        """What an approval is given to: the recipe as it will run."""
        payload = {
            "setup": self.setup,
            "copy": self.copy,
            "link": self.link,
            "pass_env": self.pass_env,
            "timeout": self.timeout_seconds,
            "ports": self.ports,
            "teardown": self.teardown,
        }
        if self.proofs:
            # Only when declared: approvals given before proofs existed stay valid.
            payload["proofs"] = self.proofs
            payload["proof_timeout"] = self.proof_timeout_seconds
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True).encode("utf-8")
        ).hexdigest()

    @property
    def empty(self) -> bool:
        return not (self.setup or self.copy or self.link or self.ports or self.teardown)

    def as_dict(self) -> dict:
        return {
            "source": self.source,
            "setup": [list(c) for c in self.setup],
            "copy": list(self.copy),
            "link": list(self.link),
            "passEnv": list(self.pass_env),
            "timeoutSeconds": self.timeout_seconds,
            "ports": self.ports,
            "teardown": [list(c) for c in self.teardown],
            "proofs": [list(c) for c in self.proofs],
            "proofTimeoutSeconds": self.proof_timeout_seconds,
            "errors": list(self.errors),
            "notes": list(self.notes),
            "digest": self.digest,
        }


# ── the file ─────────────────────────────────────────────────────────────────


def _command(value: object, where: str, errors: list[str]) -> tuple[str, ...] | None:
    if isinstance(value, str):
        errors.append(f"{where}: a command is a list of arguments, not a string")
        return None
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(a, str) and a for a in value)
    ):
        errors.append(f"{where}: a command is a non-empty list of strings")
        return None
    program = PurePosixPath(value[0].replace("\\", "/")).name.lower()
    if program in _SHELLS and any(a.lower() in _EVAL_FLAGS for a in value[1:]):
        errors.append(
            f"{where}: `{value[0]} {value[1]}` runs a string in a shell; "
            "name a script instead"
        )
        return None
    if any("\x00" in a for a in value):
        errors.append(f"{where}: an argument holds a NUL character")
        return None
    return tuple(value)


def _commands(
    value: object, where: str, errors: list[str]
) -> tuple[tuple[str, ...], ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        errors.append(f"{where}: expected a list of commands")
        return ()
    if len(value) > MAX_COMMANDS:
        errors.append(f"{where}: at most {MAX_COMMANDS} commands")
        return ()
    out = [_command(v, f"{where}[{i}]", errors) for i, v in enumerate(value)]
    return tuple(c for c in out if c is not None)


def _relative_paths(value: object, where: str, errors: list[str]) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        errors.append(f"{where}: expected a list of paths")
        return ()
    kept: list[str] = []
    for raw in value:
        path = PurePosixPath(raw.replace("\\", "/"))
        if not raw or path.is_absolute() or ".." in path.parts or ":" in raw:
            errors.append(f"{where}: {raw!r} must be a path inside the project")
            continue
        kept.append(str(path))
    return tuple(kept)


_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


def _env_names(value: object, where: str, errors: list[str]) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(
        isinstance(v, str) and _ENV_NAME.match(v) for v in value
    ):
        errors.append(f"{where}: expected a list of variable names")
        return ()
    return tuple(value)


def _int(
    value: object, where: str, low: int, high: int, default: int, errors: list[str]
) -> int:
    if value is None:
        return default
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not low <= value <= high
    ):
        errors.append(f"{where}: expected a whole number from {low} to {high}")
        return default
    return value


def parse_recipe(text: str) -> Recipe:
    """The recipe a `worktree.toml` holds. A recipe with errors runs nothing."""
    errors: list[str] = []
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        return Recipe("file", errors=(f"not valid TOML: {exc}",))
    unknown = sorted(set(data) - {"setup", "ports", "teardown", "proofs"})
    if unknown:
        errors.append(f"unknown section(s): {', '.join(unknown)}")
    setup = data.get("setup") or {}
    ports = data.get("ports") or {}
    teardown = data.get("teardown") or {}
    proofs = data.get("proofs") or {}
    for name, table in (
        ("setup", setup),
        ("ports", ports),
        ("teardown", teardown),
        ("proofs", proofs),
    ):
        if not isinstance(table, dict):
            errors.append(f"[{name}] must be a table")
    if errors:
        return Recipe("file", errors=tuple(errors))
    commands = _commands(setup.get("commands"), "setup.commands", errors)
    windows = _commands(setup.get("windows"), "setup.windows", errors)
    proof_commands = _commands(proofs.get("commands"), "proofs.commands", errors)
    proof_windows = _commands(proofs.get("windows"), "proofs.windows", errors)
    recipe = Recipe(
        "file",
        setup=windows if windows and is_windows() else commands,
        copy=_relative_paths(setup.get("copy"), "setup.copy", errors),
        link=_relative_paths(setup.get("link"), "setup.link", errors),
        pass_env=_env_names(setup.get("pass_env"), "setup.pass_env", errors),
        timeout_seconds=_int(
            setup.get("timeout_seconds"),
            "setup.timeout_seconds",
            10,
            MAX_TIMEOUT,
            DEFAULT_TIMEOUT,
            errors,
        ),
        ports=_int(ports.get("count"), "ports.count", 0, MAX_PORTS, 0, errors),
        teardown=_commands(teardown.get("commands"), "teardown.commands", errors),
        proofs=proof_windows if proof_windows and is_windows() else proof_commands,
        proof_timeout_seconds=_int(
            proofs.get("timeout_seconds"),
            "proofs.timeout_seconds",
            10,
            MAX_TIMEOUT,
            DEFAULT_PROOF_TIMEOUT,
            errors,
        ),
    )
    if errors:
        return Recipe("file", errors=tuple(errors))
    return recipe


def load_recipe(project_dir: Path | str) -> Recipe | None:
    """The project's `worktree.toml`, or None when it has none."""
    path = Path(project_dir) / ".workpilot" / RECIPE_FILE
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError) as exc:
        return Recipe("file", errors=(f"unreadable: {exc}",))
    return parse_recipe(text)


# ── what the stack implies ───────────────────────────────────────────────────


def _has(root: Path, *names: str) -> bool:
    return any((root / n).exists() for n in names)


def _glob(root: Path, pattern: str, depth: int = 2) -> bool:
    for level in range(depth + 1):
        if next(root.glob("/".join(["*"] * level + [pattern])), None):
            return True
    return False


def _venv_python() -> str:
    return ".venv\\Scripts\\python.exe" if is_windows() else ".venv/bin/python"


def detect_recipe(project_dir: Path | str) -> Recipe:
    """The setup a project's stack implies, from the files at its root.

    One command per package manager the lockfiles name, so a polyglot
    repository (a .NET API and an Angular front) gets both.
    """
    root = Path(project_dir)
    steps: list[tuple[str, ...]] = []
    notes: list[str] = []
    # JavaScript and TypeScript: the lockfile names the manager.
    if _has(root, "pnpm-lock.yaml"):
        steps.append(("pnpm", "install", "--frozen-lockfile"))
    elif _has(root, "yarn.lock"):
        steps.append(("yarn", "install"))
    elif _has(root, "bun.lockb", "bun.lock"):
        steps.append(("bun", "install"))
    elif _has(root, "package-lock.json"):
        steps.append(("npm", "ci"))
    elif _has(root, "package.json"):
        steps.append(("npm", "install"))
    # Python
    if _has(root, "uv.lock"):
        steps.append(("uv", "sync"))
    elif _has(root, "poetry.lock"):
        steps.append(("poetry", "install"))
    elif _has(root, "requirements.txt"):
        steps.append(("python", "-m", "venv", ".venv"))
        steps.append((_venv_python(), "-m", "pip", "install", "-r", "requirements.txt"))
    # .NET
    if _glob(root, "*.sln") or _glob(root, "*.slnx") or _glob(root, "*.csproj"):
        steps.append(("dotnet", "restore"))
        if _has(root, ".config/dotnet-tools.json"):
            steps.append(("dotnet", "tool", "restore"))
    # Go, Rust, PHP, Ruby
    if _has(root, "go.mod"):
        steps.append(("go", "mod", "download"))
    if _has(root, "Cargo.toml"):
        steps.append(("cargo", "fetch"))
    if _has(root, "composer.json"):
        steps.append(("composer", "install", "--no-interaction"))
    if _has(root, "Gemfile"):
        steps.append(("bundle", "install"))
    # Dart and Flutter
    pubspec = root / "pubspec.yaml"
    if pubspec.is_file():
        flutter = "flutter" in pubspec.read_text(encoding="utf-8", errors="replace")
        steps.append(("flutter", "pub", "get") if flutter else ("dart", "pub", "get"))
    # JVM
    if _has(root, "gradlew", "gradlew.bat"):
        wrapper = "gradlew.bat" if is_windows() else "./gradlew"
        steps.append((wrapper, "dependencies", "--quiet"))
    elif _has(root, "pom.xml"):
        steps.append(("mvn", "-q", "dependency:go-offline"))
    if not steps:
        notes.append("no package manager recognised at the project root")
    return Recipe("detected", setup=tuple(steps), notes=tuple(notes))


def recipe_for(project_dir: Path | str) -> Recipe:
    """The file when the project has one, else what the stack implies."""
    return load_recipe(project_dir) or detect_recipe(project_dir)
