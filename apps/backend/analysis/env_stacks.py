"""Toolchains of every stack, for environment snapshots and their replay.

A snapshot records the version of each toolchain found on the machine and
the lockfiles of the project; a replay turns that record back into a
Dockerfile, a Nix shell or a check script for the same toolchains. Every
value written into a replay comes from the snapshot file, which lives in the
project and may come from someone else: versions, commit and remote are
reduced to a safe alphabet before they reach a shell line.
"""

from __future__ import annotations

import re
import shlex
from collections.abc import Callable

# (snapshot key, executable, version argument)
TOOLS: tuple[tuple[str, str, str], ...] = (
    ("node", "node", "--version"),
    ("npm", "npm", "--version"),
    ("pnpm", "pnpm", "--version"),
    ("yarn", "yarn", "--version"),
    ("bun", "bun", "--version"),
    ("deno", "deno", "--version"),
    ("python", "python3", "--version"),
    ("uv", "uv", "--version"),
    ("dotnet", "dotnet", "--version"),
    ("java", "java", "-version"),
    ("maven", "mvn", "--version"),
    ("gradle", "gradle", "--version"),
    ("go", "go", "version"),
    ("rustc", "rustc", "--version"),
    ("cargo", "cargo", "--version"),
    ("php", "php", "--version"),
    ("composer", "composer", "--version"),
    ("ruby", "ruby", "--version"),
    ("dart", "dart", "--version"),
    ("flutter", "flutter", "--version"),
    ("swift", "swift", "--version"),
    ("git", "git", "--version"),
    ("docker", "docker", "--version"),
)

# Lockfiles and toolchain pins, per stack.
LOCKFILES: tuple[str, ...] = (
    # JavaScript / TypeScript
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "deno.lock",
    ".nvmrc",
    ".node-version",
    # Python
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "requirements.txt",
    ".python-version",
    # .NET
    "packages.lock.json",
    "Directory.Packages.props",
    "global.json",
    # JVM
    "gradle.lockfile",
    "gradle/libs.versions.toml",
    "gradle/wrapper/gradle-wrapper.properties",
    ".mvn/wrapper/maven-wrapper.properties",
    # Go, Rust
    "go.sum",
    "Cargo.lock",
    "rust-toolchain.toml",
    "rust-toolchain",
    # PHP, Ruby, Elixir
    "composer.lock",
    "Gemfile.lock",
    ".ruby-version",
    "mix.lock",
    # Dart / Flutter, Swift, iOS
    "pubspec.lock",
    ".fvmrc",
    "Package.resolved",
    "Podfile.lock",
    # Any stack
    ".tool-versions",
    ".sdkmanrc",
)

_VERSION = re.compile(r"\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.]+)?")
_HEX = re.compile(r"[0-9a-fA-F]{4,64}")
_REMOTE = re.compile(r"[A-Za-z0-9@:/._~+-]+")


def version_of(raw: object) -> str | None:
    """The first version number of a tool's output, or None."""
    if not isinstance(raw, str):
        return None
    # The number after the last "version" wins: `swift-driver version: 1.87.3
    # Apple Swift version 5.9.2`, `go version go1.22.3`, `openjdk version "21"`.
    at = raw.lower().rfind("version")
    match = _VERSION.search(raw[at:] if at >= 0 else raw) or _VERSION.search(raw)
    return match.group(0) if match else None


def _major(version: str) -> str:
    return version.split(".", 1)[0]


def _major_minor(version: str) -> str:
    return ".".join(version.split(".")[:2])


def _versions(snapshot: dict) -> dict[str, str]:
    tools = snapshot.get("tools") or {}
    if not isinstance(tools, dict):
        return {}
    found = {key: version_of(raw) for key, raw in tools.items()}
    return {key: v for key, v in found.items() if v}


def _commit(snapshot: dict) -> str:
    commit = str((snapshot.get("git") or {}).get("commit") or "")
    return commit if _HEX.fullmatch(commit) else "HEAD"


def _remote(snapshot: dict) -> str:
    remote = str((snapshot.get("git") or {}).get("remote") or "")
    return remote if _REMOTE.fullmatch(remote) else "<remote-url>"


def _snap_label(snapshot: dict) -> str:
    return re.sub(r"[^A-Za-z0-9._:+-]", "", str(snapshot.get("id", "")))


# --- Dockerfile ---------------------------------------------------------------

_DOCKER_STEPS: dict[str, Callable[[str], str]] = {
    "node": lambda v: (
        f"RUN curl -fsSL https://deb.nodesource.com/setup_{_major(v)}.x | bash - "
        "&& apt-get install -y nodejs && corepack enable"
    ),
    "bun": lambda v: f"RUN curl -fsSL https://bun.sh/install | bash -s bun-v{v}",
    "deno": lambda v: f"RUN curl -fsSL https://deno.land/install.sh | sh -s v{v}",
    "python": lambda v: "RUN apt-get install -y python3 python3-pip python3-venv",
    "uv": lambda v: f"RUN curl -LsSf https://astral.sh/uv/{v}/install.sh | sh",
    "dotnet": lambda v: (
        "RUN curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- "
        f"--version {v} --install-dir /usr/share/dotnet "
        "&& ln -s /usr/share/dotnet/dotnet /usr/bin/dotnet"
    ),
    "java": lambda v: f"RUN apt-get install -y openjdk-{_major(v)}-jdk-headless",
    "maven": lambda v: "RUN apt-get install -y maven",
    "gradle": lambda v: f"# Gradle {v}: the project's gradlew wrapper downloads it",
    "go": lambda v: (
        f"RUN curl -fsSL https://go.dev/dl/go{v}.linux-$(dpkg --print-architecture).tar.gz "
        "| tar -C /usr/local -xz\nENV PATH=/usr/local/go/bin:$PATH"
    ),
    "rustc": lambda v: (
        "RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y "
        f"--default-toolchain {v}\nENV PATH=/root/.cargo/bin:$PATH"
    ),
    "php": lambda v: "RUN apt-get install -y php-cli php-xml php-mbstring unzip",
    "composer": lambda v: "RUN apt-get install -y composer",
    "ruby": lambda v: "RUN apt-get install -y ruby-full && gem install bundler",
    "flutter": lambda v: (
        f"RUN git clone --depth 1 -b {v} https://github.com/flutter/flutter.git "
        "/opt/flutter\nENV PATH=/opt/flutter/bin:$PATH"
    ),
    "dart": lambda v: f"# Dart {v}: https://dart.dev/get-dart (bundled with Flutter)",
    "swift": lambda v: (
        f"# Swift {v}: base the image on swift:{_major_minor(v)} instead"
    ),
}


def dockerfile(snapshot: dict) -> str:
    versions = _versions(snapshot)
    steps = [
        _DOCKER_STEPS[key](version)
        for key, version in versions.items()
        if key in _DOCKER_STEPS and not (key == "dart" and "flutter" in versions)
    ]
    pinned = ", ".join(f"{k}={v}" for k, v in versions.items()) or "none"
    return "\n".join(
        [
            f"# Reproduces snapshot {_snap_label(snapshot)}",
            f"# Toolchains at capture: {pinned}",
            "FROM ubuntu:24.04",
            "ENV DEBIAN_FRONTEND=noninteractive",
            "RUN apt-get update && apt-get install -y curl git ca-certificates unzip",
            *steps,
            "WORKDIR /work",
            f"RUN git clone {shlex.quote(_remote(snapshot))} repo "
            f"&& cd repo && git checkout {_commit(snapshot)}",
            "WORKDIR /work/repo",
            'CMD ["bash"]',
            "",
        ]
    )


# --- Nix ---------------------------------------------------------------------

_NIX_PACKAGES: dict[str, Callable[[str], str]] = {
    "node": lambda v: f"nodejs_{_major(v)}",
    "pnpm": lambda v: "pnpm",
    "yarn": lambda v: "yarn",
    "bun": lambda v: "bun",
    "deno": lambda v: "deno",
    "python": lambda v: f"python{_major_minor(v).replace('.', '')}",
    "uv": lambda v: "uv",
    "dotnet": lambda v: f"dotnet-sdk_{_major(v)}",
    "java": lambda v: f"jdk{_major(v)}",
    "maven": lambda v: "maven",
    "gradle": lambda v: "gradle",
    "go": lambda v: "go",
    "rustc": lambda v: "rustc",
    "cargo": lambda v: "cargo",
    "php": lambda v: "php",
    "composer": lambda v: "phpPackages.composer",
    "ruby": lambda v: "ruby",
    "dart": lambda v: "dart",
    "flutter": lambda v: "flutter",
    "swift": lambda v: "swift",
    "git": lambda v: "git",
}


def nix_shell(snapshot: dict) -> str:
    versions = _versions(snapshot)
    packages = sorted(
        {_NIX_PACKAGES[k](v) for k, v in versions.items() if k in _NIX_PACKAGES}
        | {"git"}
    )
    inputs = " ".join(f"pkgs.{p}" for p in packages)
    return (
        f"# Reproduces snapshot {_snap_label(snapshot)}\n"
        "{ pkgs ? import <nixpkgs> {} }:\n"
        "pkgs.mkShell {\n"
        f"  buildInputs = [ {inputs} ];\n"
        "  shellHook = ''\n"
        f'    echo "Snapshot {_snap_label(snapshot)}, commit {_commit(snapshot)}"\n'
        "  '';\n"
        "}\n"
    )


# --- Check script ------------------------------------------------------------

_EXECUTABLES = {key: (exe, arg) for key, exe, arg in TOOLS}


def check_script(snapshot: dict) -> str:
    lines = [
        "#!/usr/bin/env bash",
        f"# Replay snapshot {_snap_label(snapshot)}: compare toolchains, then check out.",
        "set -uo pipefail",
        "check() {",
        "  local name=$1 want=$2; shift 2",
        '  local have; have=$("$@" 2>&1 | grep -oE "[0-9]+(\\.[0-9]+)+" | head -1)',
        '  if [ "$have" = "$want" ]; then echo "ok    $name $have";'
        ' else echo "DIFF  $name: want $want, have ${have:-missing}"; fi',
        "}",
    ]
    for key, version in _versions(snapshot).items():
        exe, arg = _EXECUTABLES.get(key, (key, "--version"))
        lines.append(f"check {key} {shlex.quote(version)} {exe} {arg}")
    lines.append(f"git checkout {_commit(snapshot)}")
    return "\n".join(lines) + "\n"


REPLAYS: dict[str, Callable[[dict], str]] = {
    "dockerfile": dockerfile,
    "nix": nix_shell,
    "script": check_script,
}
