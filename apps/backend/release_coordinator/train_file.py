"""The release train file: how each service deploys, rolls back and is checked.

``release-train.yaml`` at the root of the project (versioned, shared by the
team), else ``.workpilot/release-train.yaml``. It is data (S2): read with
``yaml.safe_load``, 64 KB at most, never through a link, every field checked.
A command is an argument list, never a shell line, and runs only once the
person approved this exact file (its SHA-256, kept by the app, outside the
project): a commit that changes a command asks again.

```yaml
environments:
  staging: {}
  production: {production: true}      # each service waits for a click
services:
  - name: auth-service                # a discovered service, or an external one
    path: services/auth               # where commands run (default: its folder)
    depends_on: [db]                  # added to the manifest's dependencies
    criticality: high                 # high | normal | low: order inside a wave
    external: false                   # true: a person confirms it is ready
    deploy:   {command: [./deploy.sh, "{environment}", "{version}"], timeout: 900}
    rollback: {command: [./rollback.sh, "{environment}", "{previous_version}"]}
    health:   {url: "https://auth.example.com/health", expect_status: 200, retries: 5}
    smoke:    {command: [npm, run, smoke, --, "{environment}"]}
    pass_env: [AWS_PROFILE, KUBECONFIG]  # project variables the commands receive
flags:
  - key: new-checkout
    services: [frontend, backend]
    provider: unleash                 # unleash | launchdarkly | configcat | manual
    url: https://unleash.example.com  # the provider's address (Unleash; EU or US LaunchDarkly)
    project: default                  # Unleash project, LaunchDarkly project, ConfigCat config
    environment: production           # the provider's environment (default: the train's)
calendar:
  - {service: backend, environment: production, at: "2026-11-12T14:00:00Z", minutes: 60}
```

A command gets the app's environment without its credentials (``CI=1``),
plus the variables named in ``pass_env``, read from the project's environment
(Settings, Project, environment variables): nothing else reaches it.

A deployment run by CI is a command too: ``[gh, workflow, run, deploy.yml, -f,
"env={environment}"]`` then ``[gh, run, watch, --exit-status]`` in ``smoke``,
or ``glab ci run`` / ``az pipelines run``.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

FILE_NAMES = ("release-train.yaml", ".workpilot/release-train.yaml")
MAX_BYTES = 64 * 1024
MAX_SERVICES = 100
MAX_ARGS = 40
NAME = re.compile(r"^[\w@./-]{1,80}$")
ENVIRONMENT = re.compile(r"^[a-z][a-z0-9_-]{0,30}$")
FLAG_KEY = re.compile(r"^[\w.:-]{1,100}$")
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
MAX_PASS_ENV = 30
PLACEHOLDERS = {"environment", "version", "previous_version", "service"}
PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")
PROVIDERS = {"unleash", "launchdarkly", "configcat", "manual"}
CRITICALITY = {"high": 0, "normal": 1, "low": 2}


class TrainFileError(ValueError):
    """A train file that does not hold: nothing of it is used."""


@dataclass
class Step:
    """A command (argument list) or a URL to call, with its time limit."""

    command: list[str] = field(default_factory=list)
    url: str = ""
    timeout: int = 600
    expect_status: int = 200
    retries: int = 3

    def to_dict(self) -> dict[str, Any]:
        return {
            "command": self.command,
            "url": self.url,
            "timeout": self.timeout,
            "expectStatus": self.expect_status,
            "retries": self.retries,
        }


@dataclass
class TrainService:
    name: str
    path: str = ""
    depends_on: list[str] = field(default_factory=list)
    criticality: str = "normal"
    external: bool = False
    deploy: Step | None = None
    rollback: Step | None = None
    health: Step | None = None
    smoke: Step | None = None
    pass_env: list[str] = field(default_factory=list)

    def steps(self) -> dict[str, Step]:
        return {
            kind: step
            for kind, step in (
                ("deploy", self.deploy),
                ("rollback", self.rollback),
                ("health", self.health),
                ("smoke", self.smoke),
            )
            if step is not None
        }


@dataclass
class Flag:
    key: str
    services: list[str]
    provider: str
    project: str = ""
    environment: str = ""
    url: str = ""


@dataclass
class Slot:
    service: str
    environment: str
    at: datetime
    minutes: int = 60


@dataclass
class TrainFile:
    path: str
    sha256: str
    environments: dict[str, bool]
    services: dict[str, TrainService]
    flags: list[Flag]
    calendar: list[Slot]


def find(root: Path) -> Path | None:
    for name in FILE_NAMES:
        candidate = root / name
        parents = [candidate, *candidate.relative_to(root).parents]
        if any((root / p).is_symlink() for p in parents if str(p) != "."):
            continue
        if candidate.is_file():
            return candidate
    return None


def fingerprint(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _str_list(
    value: object, what: str, pattern: re.Pattern[str] | None = None
) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_SERVICES:
        raise TrainFileError(f"{what} must be a list")
    out = []
    for item in value:
        if not isinstance(item, str) or (pattern and not pattern.match(item)):
            raise TrainFileError(f"{what}: {str(item)[:60]!r} is not a name")
        out.append(item)
    return out


def _int(value: object, what: str, low: int, high: int, default: int) -> int:
    if value is None:
        return default
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not low <= value <= high
    ):
        raise TrainFileError(f"{what} must be a whole number from {low} to {high}")
    return value


def _command(value: object, what: str) -> list[str]:
    if not isinstance(value, list) or not value or len(value) > MAX_ARGS:
        raise TrainFileError(
            f"{what}.command must be a list of arguments (no shell line)"
        )
    args: list[str] = []
    for arg in value:
        if isinstance(arg, (int, float)) and not isinstance(arg, bool):
            arg = str(arg)
        if not isinstance(arg, str) or "\x00" in arg or len(arg) > 1000:
            raise TrainFileError(f"{what}.command holds something that is not text")
        unknown = set(PLACEHOLDER.findall(arg)) - PLACEHOLDERS
        if unknown:
            raise TrainFileError(
                f"{what}.command: unknown placeholder {sorted(unknown)[0]}"
            )
        args.append(arg)
    if args[0].startswith("-"):
        raise TrainFileError(f"{what}.command must start with the program")
    return args


def _url(value: object, what: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 2000
        or not re.match(r"^https?://[^\s/@]+", value)
    ):
        raise TrainFileError(f"{what}.url must be an http(s) address")
    return value


def _step(
    value: object, what: str, *, url_allowed: bool, command_allowed: bool = True
) -> Step | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TrainFileError(f"{what} must be a mapping")
    step = Step(
        timeout=_int(value.get("timeout"), f"{what}.timeout", 1, 7200, 600),
        expect_status=_int(
            value.get("expect_status"), f"{what}.expect_status", 100, 599, 200
        ),
        retries=_int(value.get("retries"), f"{what}.retries", 1, 30, 3),
    )
    if "command" in value:
        if not command_allowed:
            raise TrainFileError(f"{what} calls a URL, not a command")
        step.command = _command(value["command"], what)
    if "url" in value:
        if not url_allowed:
            raise TrainFileError(f"{what} runs a command, not a URL")
        step.url = _url(value["url"], what)
    if not step.command and not step.url:
        needs = (
            "a command"
            if not url_allowed
            else "a url"
            if not command_allowed
            else "a command or a url"
        )
        raise TrainFileError(f"{what} needs {needs}")
    return step


def _service(raw: object, index: int) -> TrainService:
    if (
        not isinstance(raw, dict)
        or not isinstance(raw.get("name"), str)
        or not NAME.match(raw["name"])
    ):
        raise TrainFileError(f"services[{index}] needs a name")
    name = raw["name"]
    path = raw.get("path", "")
    if (
        not isinstance(path, str)
        or ".." in Path(path).parts
        or Path(path).is_absolute()
        or len(path) > 300
    ):
        raise TrainFileError(f"{name}.path must be a folder inside the project")
    criticality = raw.get("criticality", "normal")
    if criticality not in CRITICALITY:
        raise TrainFileError(f"{name}.criticality must be high, normal or low")
    pass_env = _str_list(raw.get("pass_env"), f"{name}.pass_env", ENV_NAME)
    if len(pass_env) > MAX_PASS_ENV:
        raise TrainFileError(
            f"{name}.pass_env names more than {MAX_PASS_ENV} variables"
        )
    return TrainService(
        name=name,
        path=path,
        depends_on=_str_list(raw.get("depends_on"), f"{name}.depends_on", NAME),
        criticality=str(criticality),
        external=raw.get("external") is True,
        deploy=_step(raw.get("deploy"), f"{name}.deploy", url_allowed=False),
        rollback=_step(raw.get("rollback"), f"{name}.rollback", url_allowed=False),
        health=_step(
            raw.get("health"), f"{name}.health", url_allowed=True, command_allowed=False
        ),
        smoke=_step(raw.get("smoke"), f"{name}.smoke", url_allowed=True),
        pass_env=pass_env,
    )


def _flag(raw: object, index: int) -> Flag:
    if (
        not isinstance(raw, dict)
        or not isinstance(raw.get("key"), str)
        or not FLAG_KEY.match(raw["key"])
    ):
        raise TrainFileError(f"flags[{index}] needs a key")
    provider = raw.get("provider", "manual")
    if provider not in PROVIDERS:
        raise TrainFileError(
            f"flag {raw['key']}: provider must be one of {', '.join(sorted(PROVIDERS))}"
        )
    text = {k: raw.get(k, "") for k in ("project", "environment")}
    for key, value in text.items():
        if not isinstance(value, str) or (value and not FLAG_KEY.match(value)):
            raise TrainFileError(f"flag {raw['key']}: {key} is not a name")
    url = raw.get("url", "")
    if url:
        url = _url(url, f"flag {raw['key']}").rstrip("/")
    return Flag(
        raw["key"],
        _str_list(raw.get("services"), f"flag {raw['key']}.services", NAME),
        str(provider),
        str(text["project"]),
        str(text["environment"]),
        url,
    )


def _slot(raw: object, index: int) -> Slot:
    if not isinstance(raw, dict):
        raise TrainFileError(f"calendar[{index}] must be a mapping")
    service, environment, at = raw.get("service"), raw.get("environment"), raw.get("at")
    if not isinstance(service, str) or not NAME.match(service):
        raise TrainFileError(f"calendar[{index}] needs a service")
    if not isinstance(environment, str) or not ENVIRONMENT.match(environment):
        raise TrainFileError(f"calendar[{index}] needs an environment")
    if isinstance(at, datetime):
        moment = at
    elif isinstance(at, str):
        try:
            moment = datetime.fromisoformat(at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise TrainFileError(
                f"calendar[{index}].at is not a date and time"
            ) from exc
    else:
        raise TrainFileError(f"calendar[{index}] needs at")
    if moment.tzinfo is None:
        raise TrainFileError(f"calendar[{index}].at needs a time zone (Z or +01:00)")
    return Slot(
        service,
        environment,
        moment,
        _int(raw.get("minutes"), f"calendar[{index}].minutes", 1, 1440, 60),
    )


def parse(data: bytes, path: str = "release-train.yaml") -> TrainFile:
    if len(data) > MAX_BYTES:
        raise TrainFileError("the train file is over 64 KB")
    try:
        raw = yaml.safe_load(data.decode("utf-8")) or {}
    except (yaml.YAMLError, UnicodeDecodeError) as exc:
        raise TrainFileError(
            f"the train file is not YAML: {type(exc).__name__}"
        ) from exc
    if not isinstance(raw, dict):
        raise TrainFileError("the train file must be a mapping")
    environments_raw = raw.get("environments") or {
        "staging": {},
        "production": {"production": True},
    }
    if not isinstance(environments_raw, dict) or len(environments_raw) > 20:
        raise TrainFileError("environments must be a mapping")
    environments: dict[str, bool] = {}
    for name, value in environments_raw.items():
        if not isinstance(name, str) or not ENVIRONMENT.match(name):
            raise TrainFileError(f"environment {str(name)[:40]!r} is not a name")
        environments[name] = isinstance(value, dict) and value.get("production") is True
    services_raw = raw.get("services") or []
    if not isinstance(services_raw, list) or len(services_raw) > MAX_SERVICES:
        raise TrainFileError("services must be a list")
    services: dict[str, TrainService] = {}
    for index, item in enumerate(services_raw):
        service = _service(item, index)
        if service.name in services:
            raise TrainFileError(f"service {service.name} is listed twice")
        services[service.name] = service
    flags_raw = raw.get("flags") or []
    calendar_raw = raw.get("calendar") or []
    if not isinstance(flags_raw, list) or not isinstance(calendar_raw, list):
        raise TrainFileError("flags and calendar must be lists")
    return TrainFile(
        path=path,
        sha256=fingerprint(data),
        environments=environments,
        services=services,
        flags=[_flag(f, i) for i, f in enumerate(flags_raw[:50])],
        calendar=[_slot(s, i) for i, s in enumerate(calendar_raw[:200])],
    )


def load(root: Path) -> TrainFile | None:
    """The project's train file, None when it has none; TrainFileError when it does not hold."""
    path = find(root)
    if path is None:
        return None
    if path.stat().st_size > MAX_BYTES:
        raise TrainFileError("the train file is over 64 KB")
    return parse(path.read_bytes(), str(path.relative_to(root)).replace("\\", "/"))
