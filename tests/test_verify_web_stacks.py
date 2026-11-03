"""Every web stack is seen in a browser by the verification (`verify/web_stacks.py`).

Chrome DevTools MCP only checks what detection hands it. Two kinds of web
change used to reach QA unseen:

* pages a backend renders (Blazor Server, Razor Pages, MVC, Django templates,
  Express views, Thymeleaf, Go templates) — detected as an API, called, never
  opened;
* stacks nothing detected (PHP, Ruby, Rust, a static site, React on webpack,
  Remix, Gatsby…).

These tests pin both, from files on disk, and that a backend with pages gets
the browser evidence (performance trace, desktop and mobile captures) on top
of its endpoint calls.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from verify.detect import Target, detect_targets  # noqa: E402
from verify.web_stacks import serves_pages  # noqa: E402


def _write(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _only(tmp_path: Path) -> Target:
    detection = detect_targets(tmp_path)
    assert len(detection.targets) == 1, detection.to_dict()
    return detection.targets[0]


def _package(path: Path, deps: dict, scripts: dict | None = None) -> None:
    _write(
        path,
        json.dumps(
            {
                "name": path.parent.name,
                "scripts": scripts or {"dev": "dev", "start": "start"},
                "dependencies": deps,
            }
        ),
    )


# ── .NET ─────────────────────────────────────────────────────────────────────

WEB_SDK = '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>'


class TestDotnet:
    def test_blazor_server_is_opened_in_the_browser(self, tmp_path):
        _write(tmp_path / "src" / "Shop.Web" / "Shop.Web.csproj", WEB_SDK)
        _write(tmp_path / "src" / "Shop.Web" / "Components" / "App.razor", "<html/>")
        target = _only(tmp_path)
        assert (target.kind, target.framework, target.pages) == (
            "backend-api",
            "blazor",
            True,
        )
        assert target.command.startswith("dotnet run --project Shop.Web.csproj")

    def test_razor_pages_and_mvc_views_are_pages(self, tmp_path):
        _write(tmp_path / "Shop" / "Shop.csproj", WEB_SDK)
        _write(tmp_path / "Shop" / "Views" / "Home" / "Index.cshtml", "<h1/>")
        target = _only(tmp_path)
        assert (target.framework, target.pages) == ("aspnetcore-razor", True)

    def test_a_pure_api_has_no_pages(self, tmp_path):
        _write(tmp_path / "Shop.Api" / "Shop.Api.csproj", WEB_SDK)
        _write(tmp_path / "Shop.Api" / "Program.cs", "var app = 1;")
        target = _only(tmp_path)
        assert (target.framework, target.pages) == ("aspnetcore", False)

    def test_blazor_webassembly_stays_a_front_end(self, tmp_path):
        _write(
            tmp_path / "Client" / "Client.csproj",
            '<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly"></Project>',
        )
        _write(tmp_path / "Client" / "Pages" / "Home.razor", "<h1/>")
        target = _only(tmp_path)
        assert (target.kind, target.framework, target.pages) == (
            "web-frontend",
            "blazor",
            False,
        )


# ── JavaScript ───────────────────────────────────────────────────────────────


class TestNode:
    @pytest.mark.parametrize(
        "deps",
        [
            {"react": "18", "webpack-dev-server": "5"},
            {"react": "18", "react-dom": "18"},
            {"@remix-run/dev": "2"},
            {"gatsby": "5"},
            {"solid-js": "1"},
            {"@builder.io/qwik": "1"},
            {"lit": "3"},
            {"ember-source": "5"},
        ],
    )
    def test_front_ends_the_preview_list_missed(self, tmp_path, deps):
        _package(tmp_path / "web" / "package.json", deps)
        assert _only(tmp_path).kind == "web-frontend"

    def test_an_api_rendering_its_emails_with_react_stays_an_api(self, tmp_path):
        _package(
            tmp_path / "api" / "package.json",
            {"@nestjs/core": "10", "react": "18"},
            {"start:dev": "nest start"},
        )
        target = _only(tmp_path)
        assert (target.kind, target.pages) == ("backend-api", False)

    def test_express_views_are_pages(self, tmp_path):
        _package(tmp_path / "package.json", {"express": "4", "ejs": "3"})
        _write(tmp_path / "views" / "index.ejs", "<h1><%= title %></h1>")
        target = _only(tmp_path)
        assert (target.kind, target.pages) == ("backend-api", True)


# ── Python, JVM, Go ──────────────────────────────────────────────────────────


class TestServerTemplates:
    def test_django_templates_are_pages(self, tmp_path):
        _write(tmp_path / "requirements.txt", "django\n")
        _write(tmp_path / "manage.py", "import django\n")
        _write(tmp_path / "shop" / "templates" / "shop" / "list.html", "<ul></ul>")
        target = _only(tmp_path)
        assert (target.framework, target.pages) == ("django", True)

    def test_an_api_with_html_only_in_its_tests_has_no_pages(self, tmp_path):
        _write(tmp_path / "requirements.txt", "fastapi\nuvicorn\n")
        _write(tmp_path / "main.py", "app = None\n")
        _write(tmp_path / "tests" / "templates" / "fixture.html", "<p/>")
        _write(tmp_path / "htmlcov" / "index.html", "<p/>")
        _write(tmp_path / "docs" / "guide.html", "<p/>")
        assert _only(tmp_path).pages is False

    def test_thymeleaf_templates_are_pages(self, tmp_path):
        _write(tmp_path / "pom.xml", "<artifactId>spring-boot-starter</artifactId>")
        _write(
            tmp_path / "src" / "main" / "resources" / "templates" / "home.html",
            "<p th:text='x'/>",
        )
        target = _only(tmp_path)
        assert (target.framework, target.pages) == ("spring", True)

    def test_go_templates_are_pages(self, tmp_path, monkeypatch):
        import verify.detect as detect

        monkeypatch.setattr(detect, "_api_stack", lambda _d: ("go", "go"))
        _write(tmp_path / "go.mod", "module shop\n")
        _write(tmp_path / "web" / "layout.gohtml", "{{ .Title }}")
        target = _only(tmp_path)
        assert (target.framework, target.pages) == ("go", True)


# ── PHP, Ruby, Rust, static ──────────────────────────────────────────────────


class TestNewStacks:
    def test_laravel(self, tmp_path):
        _write(tmp_path / "composer.json", json.dumps({"name": "acme/shop"}))
        _write(tmp_path / "artisan", "#!/usr/bin/env php")
        _write(tmp_path / "resources" / "views" / "welcome.blade.php", "<h1/>")
        target = _only(tmp_path)
        assert target.framework == "laravel"
        assert target.command == "php artisan serve --host=127.0.0.1 --port={port}"
        assert target.pages and target.name == "shop"

    def test_symfony_serves_its_public_folder(self, tmp_path):
        _write(tmp_path / "composer.json", "{}")
        _write(tmp_path / "bin" / "console", "")
        _write(tmp_path / "public" / "index.php", "<?php")
        target = _only(tmp_path)
        assert target.framework == "symfony"
        assert target.command == "php -S 127.0.0.1:{port} -t public"

    def test_plain_php_is_its_pages(self, tmp_path):
        _write(tmp_path / "index.php", "<?php echo 'hi';")
        target = _only(tmp_path)
        assert (target.framework, target.pages) == ("php", True)

    def test_a_composer_library_launches_nothing(self, tmp_path):
        _write(tmp_path / "composer.json", "{}")
        _write(tmp_path / "src" / "Money.php", "<?php")
        assert not detect_targets(tmp_path).applicable

    def test_rails(self, tmp_path):
        _write(
            tmp_path / "Gemfile",
            "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n",
        )
        _write(tmp_path / "config" / "application.rb", "")
        _write(tmp_path / "bin" / "rails", "")
        _write(tmp_path / "app" / "views" / "orders" / "index.html.erb", "<h1/>")
        target = _only(tmp_path)
        assert target.framework == "rails"
        assert target.command == "bin/rails server -b 127.0.0.1 -p {port}"
        assert target.pages

    def test_rack(self, tmp_path):
        _write(tmp_path / "Gemfile", "gem 'sinatra'\n")
        _write(tmp_path / "config.ru", "run App")
        assert _only(tmp_path).framework == "rack"

    def test_leptos_takes_our_port(self, tmp_path):
        _write(tmp_path / "Cargo.toml", '[dependencies]\nleptos = "0.6"\n')
        target = _only(tmp_path)
        assert (target.kind, target.framework) == ("web-frontend", "leptos")
        assert target.env["LEPTOS_SITE_ADDR"] == "127.0.0.1:{port}"

    def test_yew_is_served_by_trunk(self, tmp_path):
        _write(tmp_path / "Cargo.toml", '[dependencies]\nyew = { version = "0.21" }\n')
        _write(tmp_path / "index.html", "<html></html>")
        target = _only(tmp_path)
        assert target.framework == "yew"
        assert target.command.startswith("trunk serve")

    def test_axum_with_askama_templates(self, tmp_path):
        _write(
            tmp_path / "Cargo.toml", '[dependencies]\naxum = "0.7"\naskama = "0.12"\n'
        )
        _write(tmp_path / "templates" / "index.html", "<h1>{{ title }}</h1>")
        target = _only(tmp_path)
        assert (target.kind, target.framework, target.pages) == (
            "backend-api",
            "axum",
            True,
        )

    def test_a_rust_cli_launches_nothing(self, tmp_path):
        _write(tmp_path / "Cargo.toml", '[dependencies]\nclap = "4"\n')
        assert not detect_targets(tmp_path).applicable

    def test_a_static_site_is_served_by_python(self, tmp_path):
        _write(tmp_path / "index.html", "<h1>Hi</h1>")
        target = _only(tmp_path)
        assert (target.kind, target.framework) == ("web-frontend", "static")
        assert "-m http.server {port} --bind 127.0.0.1" in target.command

    def test_index_html_of_a_vite_app_is_not_a_second_site(self, tmp_path):
        _package(tmp_path / "package.json", {"vite": "5"}, {"dev": "vite"})
        _write(tmp_path / "index.html", "<div id=app></div>")
        target = _only(tmp_path)
        assert target.framework != "static"


def test_serves_pages_names_the_template_it_found(tmp_path):
    _write(tmp_path / "Components" / "Pages" / "Counter.razor", "")
    assert serves_pages(tmp_path) == "Components/Pages/Counter.razor"
    assert serves_pages(tmp_path / "missing") == ""


# ── the loop ─────────────────────────────────────────────────────────────────


class _Browser:
    available = True

    def __init__(self, calls: list):
        self.calls = calls

    async def emulate(self, viewport: str) -> str:
        self.calls.append(("emulate", viewport))
        return ""


class _Toolbox:
    def __init__(self, base: Path, url: str, current: str | None = None):
        self.base = base
        self.calls: list = []
        self._url = url
        self._current_url = current

    def running(self, _target) -> bool:
        return True

    def url_of(self, _target) -> str:
        return self._url

    async def call(self, name: str, args: dict) -> str:
        self.calls.append((name, args))
        return ""

    async def browser(self, _target):
        return _Browser(self.calls)

    async def _document(self, _target):
        return None, None


APP = "http://127.0.0.1:5001"


def _evidence(
    tmp_path,
    monkeypatch,
    target: Target,
    current: str | None = None,
    landing: int | None = 200,
):
    import verify.launch as launch
    from verify.loop import LoopOptions, _deterministic_evidence
    from verify.settings import load_settings

    # The landing page answers `landing`; the API docs pages are absent.
    monkeypatch.setattr(
        launch, "probe", lambda url, *_a, **_k: landing if url == APP else 404
    )
    toolbox = _Toolbox(tmp_path, APP, current)
    settings = load_settings(tmp_path)
    asyncio.run(
        _deterministic_evidence(
            {}, toolbox, [target], settings, LoopOptions(log=lambda _m: None)
        )
    )
    return toolbox.calls


def test_a_backend_with_pages_gets_the_browser_evidence(tmp_path, monkeypatch):
    target = Target(kind="backend-api", name="Shop.Web", framework="blazor", pages=True)
    calls = _evidence(tmp_path, monkeypatch, target)
    names = [c[0] for c in calls]
    assert "verify_perf_trace" in names
    shots = [c[1]["label"] for c in calls if c[0] == "verify_screenshot"]
    assert shots == ["Shop.Web final state", "Shop.Web mobile view"]
    assert ("emulate", "mobile") in calls


def test_an_api_without_pages_is_not_opened(tmp_path, monkeypatch):
    target = Target(kind="backend-api", name="Shop.Api", framework="aspnetcore")
    calls = _evidence(tmp_path, monkeypatch, target)
    assert not [c for c in calls if c[0] in ("verify_screenshot", "verify_perf_trace")]


def test_another_apps_page_is_not_this_ones_capture(tmp_path, monkeypatch):
    target = Target(kind="backend-api", name="Shop.Web", pages=True)
    calls = _evidence(
        tmp_path, monkeypatch, target, current="http://127.0.0.1:5173/cart"
    )
    final = next(c[1] for c in calls if c[0] == "verify_screenshot")
    assert final["url"] == APP


def test_a_backend_whose_root_is_a_404_is_not_captured(tmp_path, monkeypatch):
    # Django pages under /shop/: the root's 404 is no defect of the task.
    target = Target(kind="backend-api", name="shop", framework="django", pages=True)
    calls = _evidence(tmp_path, monkeypatch, target, landing=404)
    assert not [c for c in calls if c[0] in ("verify_screenshot", "verify_perf_trace")]


def test_a_backend_404_root_is_not_read_for_errors(tmp_path, monkeypatch):
    import verify.launch as launch
    from verify.loop import _browser_errors

    monkeypatch.setattr(launch, "probe", lambda *_a, **_k: 404)
    toolbox = _Toolbox(tmp_path, APP)
    target = Target(kind="backend-api", name="shop", pages=True)
    assert asyncio.run(_browser_errors(toolbox, target, APP)) == []
    assert toolbox.calls == []


def test_a_nested_front_end_is_not_the_pages_of_the_api_above(tmp_path):
    _write(tmp_path / "requirements.txt", "fastapi\nuvicorn\n")
    _write(tmp_path / "main.py", "app = None\n")
    _write(tmp_path / "web" / "package.json", "{}")
    _write(tmp_path / "web" / "public" / "index.html", "<div id=root></div>")
    assert serves_pages(tmp_path) == ""
