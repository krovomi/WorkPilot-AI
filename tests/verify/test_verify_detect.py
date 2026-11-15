"""What `detect_targets` finds to launch, on project trees written to disk.

Every stack WorkPilot builds has its row: Node (front end, API, Electron,
each package manager), Python (FastAPI, Django, Flask, Streamlit), JVM
(Maven, Gradle, their wrappers), Go, .NET (ASP.NET Core, Blazor WebAssembly,
WPF, WinForms, WinUI packaged or not) and mobile. Nothing is launched here;
`tests/test_verify_loop.py` launches what detection finds.
"""

from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest
import verify.detect as detect_module
from verify.detect import detect_targets, free_port


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _package(path: Path, deps: dict, scripts: dict | None = None, **extra) -> None:
    _write(
        path / "package.json",
        json.dumps({"dependencies": deps, "scripts": scripts or {}, **extra}),
    )


def save_recipe(root: Path, targets: dict) -> None:
    """The recipe a clean launch leaves (`verify.learn.save_recipe`)."""
    _write(
        root / ".workpilot" / "verify" / "recipe.json", json.dumps({"targets": targets})
    )


def _only(root: Path, changed=None):
    detection = detect_targets(root, changed)
    assert len(detection.targets) == 1, detection.to_dict()
    return detection.targets[0]


def test_a_busy_preferred_port_gives_another_one():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        taken = busy.getsockname()[1]
        port = free_port(taken)
    assert port and port != taken
    assert free_port() > 0


@pytest.mark.parametrize(
    ("lockfile", "manager"),
    [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lock", "bun"),
        ("", "npm"),
    ],
)
def test_the_lockfile_names_the_package_manager(tmp_path, lockfile, manager):
    _package(tmp_path, {"express": "4"}, {"start": "node server.js"}, name="api")
    if lockfile:
        _write(tmp_path / lockfile, "")
    target = _only(tmp_path)
    assert target.command == f"{manager} start"
    assert (target.kind, target.framework, target.port) == (
        "backend-api",
        "express",
        3000,
    )


def test_a_workspace_lockfile_at_the_root_counts_for_its_apps(tmp_path):
    _write(tmp_path / "pnpm-lock.yaml", "")
    _package(tmp_path / "apps" / "api", {"fastify": "4"}, {"dev": "tsx src/main.ts"})
    target = _only(tmp_path)
    assert target.command == "pnpm run dev"
    assert (target.name, target.root, target.framework) == (
        "api",
        "apps/api",
        "fastify",
    )


def test_a_nest_api_is_named_by_its_framework(tmp_path):
    _package(tmp_path, {"@nestjs/core": "10"}, {"start:dev": "nest start --watch"})
    target = _only(tmp_path)
    assert (target.framework, target.command, target.name) == (
        "nestjs",
        "npm run start:dev",
        "app",
    )


def test_an_api_without_a_start_script_is_not_launched(tmp_path):
    _package(tmp_path, {"express": "4"}, {"build": "tsc"})
    assert not detect_targets(tmp_path).applicable


def test_a_package_without_scripts_or_an_app_is_nothing(tmp_path):
    _package(tmp_path, {"react": "18"})
    assert not detect_targets(tmp_path).applicable
    _package(tmp_path, {"lodash": "4"}, {"build": "tsc"})
    assert not detect_targets(tmp_path).applicable


def test_an_electron_app_is_a_desktop_target(tmp_path):
    _package(tmp_path, {"electron": "30"}, {"electron:dev": "electron ."}, name="desk")
    target = _only(tmp_path)
    assert (target.kind, target.framework, target.command) == (
        "desktop",
        "electron",
        "npm run electron:dev",
    )
    assert target.ready_path == "/json/version"


def test_an_electron_app_without_a_dev_script_is_not_launched(tmp_path):
    _package(tmp_path, {"electron": "30"}, {"build": "electron-builder"})
    assert not detect_targets(tmp_path).applicable


def test_a_ui_library_alone_is_a_front_end(tmp_path):
    _package(tmp_path, {"preact": "10"}, {"serve": "sirv public"}, name="ui")
    target = _only(tmp_path)
    assert target.kind == "web-frontend"
    assert target.command == "npm run serve"


def test_a_front_end_with_nothing_to_run_is_not_launched(tmp_path, monkeypatch):
    import app_detection

    def broken(self):
        raise RuntimeError("detector crashed")

    monkeypatch.setattr(app_detection.AppEmulatorRunner, "detect_project_type", broken)
    _package(tmp_path, {"vite": "5"}, {"build": "vite build"})
    assert not detect_targets(tmp_path).applicable


@pytest.mark.parametrize(
    ("requirements", "files", "framework", "kind", "command"),
    [
        (
            "django\n",
            {"manage.py": ""},
            "django",
            "backend-api",
            "python manage.py runserver 127.0.0.1:{port} --noreload",
        ),
        ("flask\n", {"app.py": ""}, "flask", "backend-api", "python app.py"),
        (
            "streamlit\n",
            {"app.py": ""},
            "streamlit",
            "web-frontend",
            "streamlit run app.py --server.port {port} --server.headless true",
        ),
    ],
)
def test_python_web_apps(tmp_path, requirements, files, framework, kind, command):
    _write(tmp_path / "requirements.txt", requirements)
    for name, text in files.items():
        _write(tmp_path / name, text)
    target = _only(tmp_path)
    assert (target.framework, target.kind, target.command) == (framework, kind, command)
    if framework == "flask":
        assert target.env == {"FLASK_RUN_PORT": "{port}", "FLASK_RUN_HOST": "127.0.0.1"}


def test_a_python_detector_that_crashes_is_no_target(tmp_path, monkeypatch):
    import app_detection

    def broken(self):
        raise OSError("unreadable")

    monkeypatch.setattr(app_detection.AppEmulatorRunner, "_detect_from_python", broken)
    _write(tmp_path / "requirements.txt", "flask\n")
    assert not detect_targets(tmp_path).applicable


@pytest.mark.parametrize(
    ("manifest", "wrapper", "command"),
    [
        ("pom.xml", "mvnw", "./mvnw -q spring-boot:run"),
        ("pom.xml", "", "mvn -q spring-boot:run"),
        ("build.gradle", "gradlew", "./gradlew -q bootRun"),
        ("build.gradle.kts", "", "gradle -q bootRun"),
    ],
)
def test_spring_boot_with_or_without_its_wrapper(tmp_path, manifest, wrapper, command):
    _write(tmp_path / manifest, "org.springframework.boot:spring-boot-starter-web\n")
    if wrapper:
        _write(tmp_path / wrapper, "#!/bin/sh\n")
    target = _only(tmp_path)
    assert (target.framework, target.command, target.port) == ("spring", command, 8080)
    assert target.port_env == ["SERVER_PORT"]


def test_a_jvm_project_that_is_not_spring_boot_is_nothing(tmp_path):
    _write(tmp_path / "pom.xml", "<project><artifactId>lib</artifactId></project>")
    assert not detect_targets(tmp_path).applicable


def test_a_go_module_is_an_api(tmp_path):
    _write(tmp_path / "go.mod", "module example.com/shop\n")
    _write(tmp_path / "main.go", "package main\n")
    target = _only(tmp_path)
    assert (target.framework, target.command, target.name) == ("go", "go run .", "go")


def test_a_go_module_whose_stack_cannot_be_read_is_nothing(tmp_path, monkeypatch):
    def broken(directory):
        raise ValueError("unreadable")

    monkeypatch.setattr(detect_module, "_api_stack", broken)
    _write(tmp_path / "go.mod", "module example.com/shop\n")
    assert not detect_targets(tmp_path).applicable
    monkeypatch.setattr(detect_module, "_api_stack", lambda directory: ("node", "ts"))
    assert not detect_targets(tmp_path).applicable


WPF = """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>WinExe</OutputType><UseWPF>true</UseWPF></PropertyGroup>
</Project>"""
WINFORMS = WPF.replace("UseWPF", "UseWindowsForms")
WINUI = """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>WinExe</OutputType>{packaging}</PropertyGroup>
  <ItemGroup><PackageReference Include="Microsoft.WindowsAppSDK" /></ItemGroup>
</Project>"""
CONTROLS = """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Library</OutputType><UseWPF>true</UseWPF></PropertyGroup>
</Project>"""


def test_windows_apps_by_their_ui_framework(tmp_path):
    _write(tmp_path / "src" / "Orders" / "Orders.csproj", WPF)
    _write(tmp_path / "src" / "Admin" / "Admin App.csproj", WINFORMS)
    _write(tmp_path / "src" / "Controls" / "Controls.csproj", CONTROLS)
    _write(tmp_path / "src" / "Orders.Tests" / "Orders.Tests.csproj", WPF)

    found = {t.name: t for t in detect_targets(tmp_path).targets}

    assert set(found) == {"Orders", "Admin App"}
    assert (found["Orders"].kind, found["Orders"].framework) == ("windows-app", "wpf")
    assert found["Orders"].command == "dotnet run --project Orders.csproj"
    assert found["Admin App"].framework == "winforms"
    assert found["Admin App"].command == 'dotnet run --project "Admin App.csproj"'


def test_a_packaged_winui_app_is_not_started_with_dotnet_run(tmp_path):
    _write(tmp_path / "Shell" / "Shell.csproj", WINUI.format(packaging=""))
    _write(
        tmp_path / "Tool" / "Tool.csproj",
        WINUI.format(packaging="<WindowsPackageType>None</WindowsPackageType>"),
    )
    found = {t.name: t for t in detect_targets(tmp_path).targets}
    assert found["Shell"].framework == "winui"
    assert found["Shell"].command == ""
    assert "WindowsPackageType" in found["Shell"].notes[0]
    assert found["Tool"].command == "dotnet run --project Tool.csproj"


def test_a_blazor_webassembly_app_is_a_front_end(tmp_path):
    _write(
        tmp_path / "Client" / "Client.csproj",
        '<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly"></Project>',
    )
    target = _only(tmp_path)
    assert (target.kind, target.framework) == ("web-frontend", "blazor")


def test_project_files_too_deep_or_hidden_are_not_read(tmp_path):
    _write(tmp_path / "a" / "b" / "c" / "d" / "e" / "Deep.csproj", WPF)
    _write(tmp_path / ".cache" / "Hidden.csproj", WPF)
    _write(tmp_path / "node_modules" / "x" / "Vendored.csproj", WPF)
    assert not detect_targets(tmp_path).applicable


def test_two_apps_with_one_name_get_two_names(tmp_path):
    _package(
        tmp_path / "apps" / "shop", {"express": "4"}, {"start": "node ."}, name="shop"
    )
    _package(
        tmp_path / "services" / "shop", {"koa": "2"}, {"start": "node ."}, name="shop"
    )
    names = sorted(t.name for t in detect_targets(tmp_path).targets)
    assert names == ["shop", "shop-services-shop"]


def test_a_learned_recipe_overrides_what_was_detected(tmp_path):
    _package(tmp_path, {"express": "4"}, {"start": "node ."}, name="api")
    save_recipe(
        tmp_path,
        {
            "api": {
                "command": "npm run start:local",
                "ready_path": "/health",
                "port": 4100,
                "notes": ["needs REDIS_URL", 42],
            },
            "ghost": {"command": "npm start"},
        },
    )
    target = _only(tmp_path)
    assert (target.command, target.origin) == ("npm run start:local", "recipe")
    assert (target.ready_path, target.port) == ("/health", 4100)
    assert target.notes == ["needs REDIS_URL"]


def test_a_recipe_never_relaunches_a_phone_app(tmp_path, monkeypatch):
    (tmp_path / "android").mkdir()
    _write(
        tmp_path / "pubspec.yaml",
        "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    )
    save_recipe(
        tmp_path, {"app": {"command": "flutter run"}, "flutter": {"command": "x"}}
    )
    [target] = detect_targets(tmp_path).targets
    assert target.kind == "mobile" and target.command == ""


def test_a_phone_app_is_not_also_a_web_target(tmp_path):
    (tmp_path / "android").mkdir()
    _write(
        tmp_path / "pubspec.yaml",
        "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    )
    # Flutter web tooling leaves a package.json at the root.
    _package(tmp_path, {"vite": "5"}, {"dev": "vite"})
    assert [t.kind for t in detect_targets(tmp_path).targets] == ["mobile"]


def test_a_mobile_detector_that_crashes_leaves_the_rest(tmp_path, monkeypatch):
    import mobile.stacks as stacks_module

    def broken(project):
        raise OSError("unreadable pubspec")

    monkeypatch.setattr(stacks_module, "detect_stack", broken)
    _package(tmp_path, {"express": "4"}, {"start": "node ."})
    assert [t.kind for t in detect_targets(tmp_path).targets] == ["backend-api"]


def test_a_detector_that_crashes_does_not_sink_the_others(tmp_path, monkeypatch):
    def broken(directory, root):
        raise RuntimeError("bad detector")

    monkeypatch.setattr(detect_module, "EXTRA_DETECTORS", (broken,))
    _package(tmp_path, {"express": "4"}, {"start": "node ."})
    assert _only(tmp_path).framework == "express"


def test_a_detection_that_fails_entirely_finds_nothing(tmp_path, monkeypatch):
    def broken(project):
        raise RuntimeError("walk failed")

    monkeypatch.setattr(detect_module, "_dotnet_targets", broken)
    _package(tmp_path, {"express": "4"}, {"start": "node ."})
    detection = detect_targets(tmp_path)
    assert not detection.applicable


def test_a_missing_project_directory(tmp_path):
    assert detect_targets(tmp_path / "nowhere").reason == "project directory not found"


def test_changed_files_mark_the_app_that_owns_them(tmp_path):
    _package(
        tmp_path / "apps" / "api", {"express": "4"}, {"start": "node ."}, name="api"
    )
    _package(tmp_path, {"vite": "5"}, {"dev": "vite"}, name="site")
    found = {
        t.name: t.touched
        for t in detect_targets(tmp_path, ["apps\\api\\src\\orders.ts"]).targets
    }
    assert found == {"api": True, "site": False}
    found = {
        t.name: t.touched for t in detect_targets(tmp_path, ["./README.md"]).targets
    }
    assert found == {"api": False, "site": True}
