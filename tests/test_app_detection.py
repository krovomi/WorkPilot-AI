"""What the Kanban preview and `/verify` learn about a project (`app_detection.py`).

Each test writes the files a real project of that kind has, then asks.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from app_detection import AppEmulatorRunner


def _detect(project: Path) -> dict:
    return AppEmulatorRunner(str(project)).detect_project_type()


def _package(
    project: Path, deps: dict | None = None, scripts: dict | None = None, **extra
):
    payload = {"dependencies": deps or {}, "scripts": scripts or {}, **extra}
    (project / "package.json").write_text(json.dumps(payload), encoding="utf-8")


@pytest.mark.parametrize(
    ("deps", "framework", "port"),
    [
        ({"next": "15"}, "next", 3000),
        ({"nuxt": "3"}, "nuxt", 3000),
        ({"react-scripts": "5"}, "create-react-app", 3000),
        ({"vite": "6", "vue": "3"}, "vite", 5173),
        ({"@angular/core": "19"}, "angular", 4200),
        ({"vue": "2"}, "vue-cli", 8080),
        ({"@sveltejs/kit": "2"}, "svelte", 5173),
        ({"express": "5"}, "node", 3000),
    ],
)
def test_a_web_framework_is_named_with_its_port(tmp_path, deps, framework, port):
    _package(tmp_path, deps, {"dev": "x"})

    result = _detect(tmp_path)

    assert result["success"] is True
    assert (result["framework"], result["port"], result["isWeb"]) == (
        framework,
        port,
        True,
    )
    assert result["startCommand"] == "npm run dev"


def test_an_electron_app_is_a_desktop_app(tmp_path):
    _package(
        tmp_path, scripts={"start": "electron ."}, devDependencies={"electron": "33"}
    )

    result = _detect(tmp_path)

    assert (result["type"], result["port"], result["isWeb"]) == ("desktop", 0, False)
    assert result["startCommand"] == "npm start"


@pytest.mark.parametrize(
    ("lockfile", "manager"),
    [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
    ],
)
def test_the_package_manager_follows_the_lockfile(tmp_path, lockfile, manager):
    _package(tmp_path, scripts={"serve": "x"})
    (tmp_path / lockfile).write_text("", encoding="utf-8")

    assert _detect(tmp_path)["startCommand"] == f"{manager} run serve"


def test_another_serving_script_is_used_when_no_usual_one_exists(tmp_path):
    _package(tmp_path, scripts={"build": "tsc", "dev:web": "vite"})

    assert _detect(tmp_path)["startCommand"] == "npm run dev:web"


def test_a_build_or_deploy_script_is_never_the_preview(tmp_path):
    _package(tmp_path, scripts={"deploy": "firebase deploy", "build": "tsc"})

    assert _detect(tmp_path)["startCommand"] == ""


@pytest.mark.parametrize(
    "content",
    ["{broken", "[1, 2]", json.dumps({"scripts": ["dev"], "dependencies": "next"})],
)
def test_an_odd_package_json_does_not_break_detection(tmp_path, content):
    (tmp_path / "package.json").write_text(content, encoding="utf-8")

    result = _detect(tmp_path)

    assert result["framework"] in {"node", "unknown"}
    assert result.get("startCommand", "") == ""


@pytest.mark.parametrize(
    ("files", "framework", "command", "port"),
    [
        ({"manage.py": ""}, "django", "python manage.py runserver", 8000),
        (
            {"requirements.txt": "FastAPI\n", "main.py": ""},
            "fastapi",
            "uvicorn main:app --reload --port 8000",
            8000,
        ),
        (
            {"requirements.txt": "fastapi", "app.py": ""},
            "fastapi",
            "uvicorn app:app --reload --port 8000",
            8000,
        ),
        (
            {"pyproject.toml": 'dependencies = ["flask"]', "app.py": ""},
            "flask",
            "python app.py",
            5000,
        ),
        ({"requirements.txt": "flask"}, "flask", "python main.py", 5000),
        (
            {"requirements.txt": "streamlit", "app.py": ""},
            "streamlit",
            "streamlit run app.py",
            8501,
        ),
        ({"requirements.txt": "streamlit"}, "streamlit", "streamlit run main.py", 8501),
    ],
)
def test_python_web_frameworks(tmp_path, files, framework, command, port):
    for name, text in files.items():
        (tmp_path / name).write_text(text, encoding="utf-8")

    result = _detect(tmp_path)

    assert (result["framework"], result["startCommand"], result["port"]) == (
        framework,
        command,
        port,
    )


@pytest.mark.parametrize("entry", ["main.py", "app.py"])
def test_a_plain_python_script_is_a_cli(tmp_path, entry):
    (tmp_path / entry).write_text("print('hi')\n", encoding="utf-8")

    result = _detect(tmp_path)

    assert (result["type"], result["startCommand"], result["isWeb"]) == (
        "cli",
        f"python {entry}",
        False,
    )


def test_python_dependencies_alone_without_an_entry_are_not_enough(tmp_path):
    (tmp_path / "requirements.txt").write_text("requests\n", encoding="utf-8")

    assert _detect(tmp_path)["success"] is False


def test_unreadable_python_files_fall_back_to_the_others(tmp_path):
    (tmp_path / "requirements.txt").mkdir()  # reading a folder fails
    (tmp_path / "pyproject.toml").mkdir()
    (tmp_path / "main.py").write_text("", encoding="utf-8")

    assert _detect(tmp_path)["framework"] == "python"


@pytest.mark.parametrize(
    ("module", "framework"),
    [
        ("github.com/gin-gonic/gin", "gin"),
        ("github.com/gorilla/mux", "gorilla"),
        ("github.com/labstack/echo/v4", "echo"),
        ("github.com/gofiber/fiber/v2", "fiber"),
        ("golang.org/x/text", "go"),
    ],
)
def test_go_frameworks(tmp_path, module, framework):
    (tmp_path / "go.mod").write_text(
        f"module shop\n\nrequire {module} v1\n", encoding="utf-8"
    )

    result = _detect(tmp_path)

    assert (result["framework"], result["startCommand"]) == (framework, "go run .")


def test_an_unreadable_go_mod_is_still_go(tmp_path):
    (tmp_path / "go.mod").mkdir()

    assert _detect(tmp_path)["framework"] == "go"


@pytest.mark.parametrize(("dep", "is_web"), [("axum", True), ("clap", False)])
def test_rust_web_or_cli(tmp_path, dep, is_web):
    (tmp_path / "Cargo.toml").write_text(
        f'[dependencies]\n{dep} = "1"\n', encoding="utf-8"
    )

    result = _detect(tmp_path)

    assert result["isWeb"] is is_web
    assert result["port"] == (8080 if is_web else 0)


def test_an_unreadable_cargo_toml_is_a_rust_cli(tmp_path):
    (tmp_path / "Cargo.toml").mkdir()

    assert _detect(tmp_path)["type"] == "cli"


@pytest.mark.parametrize(
    ("name", "framework"),
    [
        ("docker-compose.yml", "docker-compose"),
        ("docker-compose.yaml", "docker-compose"),
        ("Dockerfile", "docker"),
    ],
)
def test_docker_projects(tmp_path, name, framework):
    (tmp_path / name).write_text("", encoding="utf-8")

    assert _detect(tmp_path)["framework"] == framework


def test_an_empty_folder_is_unknown(tmp_path):
    result = _detect(tmp_path)

    assert result["success"] is False
    assert result["type"] == "unknown"
    assert "Could not detect project type" in result["error"]
