"""What the exposure gate reads: the build output of each stack (lot B)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from foundation.platform import is_windows
from rea.artifacts import find_artifacts


def _touch(root: Path, relative: str, content: str = "x") -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _found(root: Path) -> dict[str, str]:
    return {a.relative(root.resolve()): a.kind for a in find_artifacts(root)}


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        # Electron (electron-builder) and a macOS bundle
        (["dist/linux-unpacked/workpilot"], {"dist/linux-unpacked": "desktop"}),
        (
            ["release/WorkPilot.app/Contents/Info.plist"],
            {"release/WorkPilot.app": "desktop"},
        ),
        # mobile
        (
            ["android/app/build/outputs/apk/release/app-release.apk"],
            {"android/app/build/outputs/apk/release/app-release.apk": "android"},
        ),
        (["build/ios/ipa/Runner.ipa"], {"build/ios/ipa/Runner.ipa": "ios"}),
        # web: a build folder that holds JavaScript, source maps included
        (["dist/assets/index.js", "dist/assets/index.js.map"], {"dist": "web"}),
        ([".next/static/chunks/main.js"], {".next": "web"}),
        # .NET publish and Blazor
        (
            ["src/Api/bin/Release/net10.0/publish/Api.dll"],
            {"src/Api/bin/Release/net10.0/publish": "dotnet"},
        ),
        (
            ["Client/wwwroot/_framework/blazor.webassembly.js"],
            {"Client/wwwroot/_framework": "web"},
        ),
        # JVM, Python, Rust
        (["target/app-1.0.jar"], {"target/app-1.0.jar": "jvm"}),
        (["app/build/libs/app.war"], {"app/build/libs/app.war": "jvm"}),
        (
            ["dist/pkg-1.0-py3-none-any.whl"],
            {"dist/pkg-1.0-py3-none-any.whl": "python"},
        ),
        (["dist/setup.exe"], {"dist/setup.exe": "desktop"}),
    ],
)
def test_each_stack_has_its_build_output_found(
    tmp_path: Path, files: list[str], expected: dict[str, str]
) -> None:
    for name in files:
        _touch(tmp_path, name)
    assert _found(tmp_path) == expected


def test_a_rust_release_executable_is_found_not_its_build_files(tmp_path: Path) -> None:
    name = "server.exe" if is_windows() else "server"
    binary = _touch(tmp_path, f"target/release/{name}")
    os.chmod(binary, 0o755)
    _touch(tmp_path, "target/release/server.d")
    _touch(tmp_path, "target/release/deps/libfoo.rlib")
    assert _found(tmp_path) == {f"target/release/{name}": "rust"}


def test_sources_and_dependencies_are_not_build_output(tmp_path: Path) -> None:
    _touch(tmp_path, "src/index.js")
    _touch(tmp_path, "build/README.md")  # a build folder without JavaScript
    _touch(tmp_path, "node_modules/pkg/dist/index.js")
    _touch(tmp_path, ".venv/lib/x.whl")
    _touch(tmp_path, "obj/Debug/app.dll")
    _touch(tmp_path, "lib/helper.jar")  # a jar outside target/ or libs/
    _touch(tmp_path, ".workpilot/specs/001/dist/app.js")
    assert _found(tmp_path) == {}


def test_nested_output_is_read_once_through_its_outer_folder(tmp_path: Path) -> None:
    _touch(tmp_path, "dist/linux-unpacked/resources/app.asar")
    _touch(tmp_path, "dist/linux-unpacked/resources/inner.wasm")
    assert _found(tmp_path) == {"dist/linux-unpacked": "desktop"}


def test_a_link_out_of_the_project_is_not_followed(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    _touch(outside, "dist/app.js")
    _touch(outside, "evil.apk")
    project = tmp_path / "project"
    project.mkdir()
    linked = 0
    for name, target, is_dir in (
        ("dist", outside / "dist", True),
        ("app.apk", outside / "evil.apk", False),
    ):
        try:
            (project / name).symlink_to(target, target_is_directory=is_dir)
            linked += 1
        except OSError:  # Windows without the symlink privilege: nothing linked
            pass
    assert _found(project) == {}
    assert linked in (0, 2)


def test_the_number_of_artifacts_is_bounded(tmp_path: Path) -> None:
    for n in range(10):
        _touch(tmp_path, f"out{n}/app-{n}.apk")
    assert len(find_artifacts(tmp_path, limit=3)) == 3


def test_a_missing_project_has_nothing(tmp_path: Path) -> None:
    assert find_artifacts(tmp_path / "missing") == []
