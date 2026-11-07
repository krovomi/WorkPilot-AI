"""Where a project gets its packages, when it is not only the public registry.

A company feed (Azure Artifacts, Artifactory, Nexus, GitHub Packages, a
`devpi`) serves packages the public registry has never heard of. For those, a
404 from nuget.org or npmjs.com says nothing, and blocking on it would be the
false positive this guard must never produce. So before a 404 can block, the
guard asks: does anything on this machine or in this project point the
ecosystem at another source? If so, the verdict is ``unknown``.

What is read, per ecosystem (project first, then the user's own files and
environment): `.npmrc`, `.yarnrc.yml`; `pip.conf`/`pip.ini`, `uv.toml`,
`[tool.uv.index]`, `[[tool.poetry.source]]`, `PIP_*`/`UV_*` variables;
`NuGet.Config`; `settings.xml`; `.cargo/config.toml`; `GOPRIVATE`, `GOPROXY`,
`GONOPROXY`; `composer.json` repositories; `PUB_HOSTED_URL`; `.gemrc`,
`Gemfile` sources. Only names and URLs are looked at, never a credential.
"""

from __future__ import annotations

import json
import os
import re
import tomllib
from pathlib import Path

__all__ = ["installed_locally", "private_sources"]

_PUBLIC_HOSTS = (
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "api.nuget.org",
    "nuget.org",
    "repo1.maven.org",
    "repo.maven.apache.org",
    "central.sonatype.com",
    "crates.io",
    "index.crates.io",
    "proxy.golang.org",
    "repo.packagist.org",
    "packagist.org",
    "pub.dev",
    "pub.dartlang.org",
    "rubygems.org",
)
# A comma or a pipe ends a host: `GOPROXY=https://proxy.golang.org,direct`.
_URL = re.compile(r"https?://([^/\s\"'<>;,|]+)", re.I)


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _foreign_hosts(text: str) -> set[str]:
    hosts = {m.group(1).lower().rsplit("@", 1)[-1] for m in _URL.finditer(text)}
    return {
        h
        for h in hosts
        if not any(h == p or h.endswith("." + p) for p in _PUBLIC_HOSTS)
        and not h.startswith(("schemas.", "maven.apache.org", "www.w3.org"))
    }


def _home() -> Path:
    return Path(os.environ.get("WORKPILOT_DEPGUARD_HOME") or Path.home())


def _appdata() -> Path | None:
    value = os.environ.get("APPDATA")
    return Path(value) if value else None


def _candidates(project: Path, ecosystem: str) -> list[Path]:
    home, appdata = _home(), _appdata()
    files: dict[str, list[Path]] = {
        "npm": [project / ".npmrc", project / ".yarnrc.yml", home / ".npmrc"],
        "pypi": [
            project / "pip.conf",
            project / "uv.toml",
            project / "pyproject.toml",
            project / "poetry.toml",
            home / ".pip" / "pip.conf",
            home / ".config" / "pip" / "pip.conf",
            home / ".config" / "uv" / "uv.toml",
        ]
        + (
            [appdata / "pip" / "pip.ini", appdata / "uv" / "uv.toml"] if appdata else []
        ),
        "nuget": [
            *project.glob("[Nn]u[Gg]et.[Cc]onfig"),
            home / ".nuget" / "NuGet" / "NuGet.Config",
        ]
        + ([appdata / "NuGet" / "NuGet.Config"] if appdata else []),
        "maven": [
            project / "pom.xml",
            project / "settings.gradle",
            project / "settings.gradle.kts",
            project / "build.gradle",
            project / "build.gradle.kts",
            project / ".mvn" / "settings.xml",
            home / ".m2" / "settings.xml",
        ],
        "cargo": [project / ".cargo" / "config.toml", home / ".cargo" / "config.toml"],
        "packagist": [project / "composer.json", home / ".composer" / "config.json"],
        "rubygems": [project / "Gemfile", home / ".gemrc"],
        "pub": [],
        "go": [],
    }
    return files.get(ecosystem, [])


_ENV: dict[str, tuple[str, ...]] = {
    "npm": ("NPM_CONFIG_REGISTRY", "npm_config_registry", "YARN_NPM_REGISTRY_SERVER"),
    "pypi": (
        "PIP_INDEX_URL",
        "PIP_EXTRA_INDEX_URL",
        "UV_INDEX_URL",
        "UV_EXTRA_INDEX_URL",
        "UV_INDEX",
        "UV_DEFAULT_INDEX",
    ),
    "go": ("GOPRIVATE", "GONOPROXY", "GOPROXY"),
    "pub": ("PUB_HOSTED_URL",),
    "nuget": (),
    "maven": (),
    "cargo": (),
    "packagist": ("COMPOSER_REPOSITORIES",),
    "rubygems": (),
}


def _source_text(path: Path, text: str) -> str:
    """The part of ``text`` that names package sources, by file kind.

    A `pyproject.toml` or a `pom.xml` names many URLs (home page, licence,
    SCM) that are not sources; counting them would mark every project private
    and switch the guard off in silence.
    """
    name = path.name.lower()
    if name in (".npmrc",):
        return "\n".join(
            line for line in text.splitlines() if "registry" in line.lower()
        )
    if name == ".yarnrc.yml":
        return "\n".join(line for line in text.splitlines() if "npm" in line.lower())
    if name in ("pip.conf", "pip.ini"):
        return "\n".join(line for line in text.splitlines() if "index" in line.lower())
    if name == "pyproject.toml":
        try:
            tool = tomllib.loads(text).get("tool") or {}
        except tomllib.TOMLDecodeError:
            return ""
        urls = [
            str(entry.get("url", ""))
            for key in (("uv", "index"), ("poetry", "source"), ("pdm", "source"))
            for entry in ((tool.get(key[0]) or {}).get(key[1]) or [])
            if isinstance(entry, dict)
        ]
        return "\n".join(urls)
    if name == "pom.xml":
        return "\n".join(re.findall(r"<repositories>.*?</repositories>", text, re.S))
    if name.startswith(("build.gradle", "settings.gradle")):
        return "\n".join(re.findall(r"maven\s*[({][^)}]*[)}]", text))
    if name == "composer.json":
        try:
            return json.dumps((json.loads(text) or {}).get("repositories") or [])
        except (ValueError, AttributeError):
            return ""
    if name == "gemfile":
        return "\n".join(
            line for line in text.splitlines() if line.strip().startswith("source")
        )
    return text


def private_sources(project: Path, ecosystem: str) -> list[str]:
    """What points ``ecosystem`` away from its public registry; ``[]`` if nothing.

    Each entry is a short, credential-free description (a file name and a
    host, or a variable name), for the record and the card.
    """
    found: list[str] = []
    for path in _candidates(Path(project), ecosystem):
        hosts = (
            _foreign_hosts(_source_text(path, _read(path))) if path.is_file() else set()
        )
        if hosts:
            found.append(f"{path.name}: {', '.join(sorted(hosts)[:3])}")
    for name in _ENV.get(ecosystem, ()):
        value = os.environ.get(name, "")
        if not value:
            continue
        if ecosystem == "go":
            # GOPROXY=https://proxy.golang.org,direct is the default.
            if name != "GOPROXY" or _foreign_hosts(value):
                found.append(name)
        elif _foreign_hosts(value):
            found.append(name)
    return found


def installed_locally(project: Path, ecosystem: str, name: str) -> bool:
    """Whether the package is already on disk, so it came from *some* source."""
    project = Path(project)
    if ecosystem == "npm":
        return (project / "node_modules" / name / "package.json").is_file()
    if ecosystem == "nuget":
        root = os.environ.get("NUGET_PACKAGES") or str(_home() / ".nuget" / "packages")
        return (Path(root) / name.lower()).is_dir()
    return False
