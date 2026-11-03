"""Web stacks `verify.detect` reaches through no other detector, and pages.

Two gaps let a web change reach QA without a browser ever opening it:

* **Pages rendered by a backend.** Blazor Server and Blazor Web App, Razor
  Pages, MVC, Django or Flask templates, Rails views, Thymeleaf, Go templates,
  Express views: the project is detected as a `backend-api`, and an API is
  only called, never looked at. `serves_pages` reads the files for the
  templates a server renders, and a target that has them is opened in the
  browser (console, network, screenshots, performance) as well as called.
* **Stacks nothing detected.** PHP (Laravel, Symfony, plain PHP), Ruby (Rails,
  Rack), Rust (Leptos, Trunk, Dioxus, Axum/Actix/Rocket…) and a static site
  (an ``index.html`` with no build): each gets a launch command that takes the
  verification's port.

Files only, like the rest of detection: no model, no network, never raises.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from .detect import _SKIP, Target, _read_json, _relative

__all__ = [
    "EXTRA_DETECTORS",
    "PAGE_SUFFIXES",
    "serves_pages",
    "static_target",
]

#: Template files a server renders into HTML, whatever the language.
PAGE_SUFFIXES = (
    ".razor",
    ".cshtml",
    ".vbhtml",
    ".jinja",
    ".jinja2",
    ".j2",
    ".ejs",
    ".pug",
    ".hbs",
    ".handlebars",
    ".njk",
    ".twig",
    ".blade.php",
    ".erb",
    ".haml",
    ".slim",
    ".gohtml",
    ".templ",
    ".liquid",
    ".mustache",
    ".jte",
    ".jsp",
    ".ftlh",
    ".heex",
)

#: An ``.html`` file is a page only under one of these folders: elsewhere it is
#: as likely a coverage report or a doc as something the app serves.
_PAGE_DIRS = {
    "templates",
    "views",
    "pages",
    "wwwroot",
    "static",
    "public",
    "webapp",
    "www",
}

#: Folders whose templates are not the app's pages.
_NOT_PAGES = {
    "tests",
    "test",
    "__tests__",
    "spec",
    "fixtures",
    "docs",
    "coverage",
    "htmlcov",
    "migrations",
}

#: A folder holding one of these is another app, with a target of its own:
#: a front end's ``public/index.html`` is not the pages of the API above it.
_APP_MARKERS = (
    "package.json",
    "composer.json",
    "Gemfile",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
)

_MAX_ENTRIES = 4000


def _another_app(folder: Path) -> bool:
    if any((folder / marker).is_file() for marker in _APP_MARKERS):
        return True
    try:
        return any(folder.glob("*.csproj"))
    except OSError:
        return False


def serves_pages(directory: Path, depth: int = 5) -> str:
    """The first page template under ``directory`` (relative), or ""."""
    seen = 0

    def _visit(folder: Path, level: int, parents: tuple[str, ...]) -> str:
        nonlocal seen
        if level > depth or seen > _MAX_ENTRIES:
            return ""
        try:
            entries = sorted(folder.iterdir())
        except OSError:
            return ""
        for entry in entries:
            seen += 1
            name = entry.name
            if entry.is_symlink() or name.startswith("."):
                continue
            if entry.is_dir():
                lowered = name.lower()
                if name in _SKIP or lowered in _NOT_PAGES or _another_app(entry):
                    continue
                found = _visit(entry, level + 1, (*parents, lowered))
                if found:
                    return found
                continue
            lowered = name.lower()
            if lowered.endswith(PAGE_SUFFIXES) or (
                lowered.endswith((".html", ".htm")) and _PAGE_DIRS & set(parents)
            ):
                return _relative(entry, directory)
        return ""

    return _visit(directory, 0, ())


# ---------------------------------------------------------------------------
# PHP
# ---------------------------------------------------------------------------


def _php_target(directory: Path, project_dir: Path) -> Target | None:
    composer = _read_json(directory / "composer.json")
    public = directory / "public" / "index.php"
    if (
        not (directory / "composer.json").is_file()
        and not (directory / "index.php").is_file()
    ):
        return None
    rel = _relative(directory, project_dir)
    name = str(composer.get("name") or "").split("/")[-1] or (
        directory.name if rel != "." else "php"
    )
    if (directory / "artisan").is_file():
        framework = "laravel"
        command = "php artisan serve --host=127.0.0.1 --port={port}"
    elif public.is_file():
        framework = "symfony" if (directory / "bin" / "console").is_file() else "php"
        command = "php -S 127.0.0.1:{port} -t public"
    elif (directory / "index.php").is_file():
        framework, command = "php", "php -S 127.0.0.1:{port}"
    else:
        # A library: composer.json and nothing that answers a request.
        return None
    return Target(
        kind="backend-api",
        name=name,
        root=rel,
        framework=framework,
        command=command,
        port=8000,
        # A plain PHP site is its pages; a framework says so with its views.
        pages=framework == "php" or bool(serves_pages(directory)),
    )


# ---------------------------------------------------------------------------
# Ruby
# ---------------------------------------------------------------------------


def _ruby_target(directory: Path, project_dir: Path) -> Target | None:
    gemfile = directory / "Gemfile"
    if not gemfile.is_file():
        return None
    try:
        gems = gemfile.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    rel = _relative(directory, project_dir)
    if (directory / "config" / "application.rb").is_file() and re.search(
        r"""gem\s+['"]rails['"]""", gems
    ):
        framework = "rails"
        launcher = "bin/rails" if (directory / "bin" / "rails").is_file() else ""
        command = (
            f"{launcher} server -b 127.0.0.1 -p {{port}}"
            if launcher
            else "bundle exec rails server -b 127.0.0.1 -p {port}"
        )
    elif (directory / "config.ru").is_file():
        framework = "rack"
        command = "bundle exec rackup -o 127.0.0.1 -p {port}"
    else:
        return None
    return Target(
        kind="backend-api",
        name=directory.name if rel != "." else framework,
        root=rel,
        framework=framework,
        command=command,
        port=3000,
        port_env=["PORT"],
        env={"RAILS_ENV": "development"} if framework == "rails" else {},
        pages=bool(serves_pages(directory)),
    )


# ---------------------------------------------------------------------------
# Rust
# ---------------------------------------------------------------------------

_RUST_WASM = ("yew", "sycamore", "dioxus-web")
_RUST_API = ("axum", "actix-web", "rocket", "warp", "poem", "salvo", "tide")


def _crate(text: str, name: str) -> bool:
    return re.search(rf"(?m)^\s*{re.escape(name)}\s*=", text) is not None


def _rust_target(directory: Path, project_dir: Path) -> Target | None:
    cargo = directory / "Cargo.toml"
    if not cargo.is_file():
        return None
    try:
        text = cargo.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    rel = _relative(directory, project_dir)
    name = directory.name if rel != "." else "rust"
    if _crate(text, "leptos"):
        return Target(
            kind="web-frontend",
            name=name,
            root=rel,
            framework="leptos",
            command="cargo leptos watch",
            port=3000,
            env={"LEPTOS_SITE_ADDR": "127.0.0.1:{port}"},
        )
    if (directory / "Dioxus.toml").is_file():
        return Target(
            kind="web-frontend",
            name=name,
            root=rel,
            framework="dioxus",
            command="dx serve --port {port}",
            port=8080,
        )
    wasm = next((c for c in _RUST_WASM if _crate(text, c)), "")
    if wasm and (directory / "index.html").is_file():
        return Target(
            kind="web-frontend",
            name=name,
            root=rel,
            framework=wasm,
            command="trunk serve --address 127.0.0.1 --port {port}",
            port=8080,
        )
    api = next((c for c in _RUST_API if _crate(text, c)), "")
    if not api:
        return None
    return Target(
        kind="backend-api",
        name=name,
        root=rel,
        framework=api,
        command="cargo run",
        port=8080,
        port_env=["PORT"],
        env={"ROCKET_PORT": "{port}", "ROCKET_ADDRESS": "127.0.0.1"}
        if api == "rocket"
        else {},
        pages=bool(serves_pages(directory)),
    )


# ---------------------------------------------------------------------------
# A static site
# ---------------------------------------------------------------------------


def static_target(directory: Path, project_dir: Path) -> Target | None:
    """An ``index.html`` with no build: served as it is, by Python itself."""
    if not (directory / "index.html").is_file():
        return None
    if any(
        (directory / marker).exists()
        for marker in ("package.json", "Cargo.toml", "composer.json", "Gemfile")
    ):
        return None
    rel = _relative(directory, project_dir)
    python = sys.executable or "python"
    if " " in python:
        python = f'"{python}"'
    return Target(
        kind="web-frontend",
        name=directory.name if rel != "." else "site",
        root=rel,
        framework="static",
        command=f"{python} -m http.server {{port}} --bind 127.0.0.1",
        port=8000,
    )


#: Run after the Node, Python, JVM and Go detectors, on the same folders.
EXTRA_DETECTORS = (_php_target, _ruby_target, _rust_target)
