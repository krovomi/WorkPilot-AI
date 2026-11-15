"""`verify.web_stacks` on the projects the main tests do not lay out.

A Rails app without its binstub, a Gemfile that is neither Rails nor Rack, a
Dioxus crate, a static page that belongs to a build, and an interpreter whose
path has a space: each read from real files.
"""

from __future__ import annotations

import sys

from verify import web_stacks
from verify.web_stacks import _ruby_target, _rust_target, serves_pages, static_target


def _write(path, text=""):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_rails_without_its_binstub_runs_through_bundler(tmp_path):
    _write(
        tmp_path / "Gemfile", "source 'https://rubygems.org'\ngem 'rails', '~> 8.0'\n"
    )
    _write(tmp_path / "config" / "application.rb", "module Shop; end\n")
    _write(tmp_path / "app" / "views" / "orders" / "index.html.erb", "<h1>Orders</h1>")
    target = _ruby_target(tmp_path, tmp_path)
    assert target.command == "bundle exec rails server -b 127.0.0.1 -p {port}"
    assert (target.name, target.env, target.pages) == (
        "rails",
        {"RAILS_ENV": "development"},
        True,
    )


def test_a_gemfile_alone_is_not_an_app(tmp_path):
    _write(tmp_path / "Gemfile", "gem 'rubocop'\n")
    assert _ruby_target(tmp_path, tmp_path) is None


def test_a_dioxus_crate_is_served_by_dx(tmp_path):
    app = tmp_path / "apps" / "board"
    _write(app / "Cargo.toml", '[dependencies]\ndioxus = "0.6"\n')
    _write(app / "Dioxus.toml", "[application]\nname = 'board'\n")
    target = _rust_target(app, tmp_path)
    assert (target.name, target.root, target.framework) == (
        "board",
        "apps/board",
        "dioxus",
    )
    assert target.command == "dx serve --port {port}"


def test_a_page_that_belongs_to_a_build_is_not_a_static_site(tmp_path):
    _write(tmp_path / "index.html", "<!doctype html>")
    _write(tmp_path / "package.json", "{}")
    assert static_target(tmp_path, tmp_path) is None


def test_an_interpreter_path_with_a_space_is_quoted(tmp_path, monkeypatch):
    _write(tmp_path / "index.html", "<!doctype html>")
    monkeypatch.setattr(sys, "executable", "/opt/My Python/bin/python3")
    target = static_target(tmp_path, tmp_path)
    assert (
        target.command
        == '"/opt/My Python/bin/python3" -m http.server {port} --bind 127.0.0.1'
    )


def test_a_search_for_pages_stops_at_its_depth_and_its_budget(tmp_path, monkeypatch):
    deep = tmp_path
    for level in range(4):
        deep = deep / f"level{level}"
    _write(deep / "views" / "index.cshtml", "@page")
    assert serves_pages(tmp_path, depth=2) == ""
    assert serves_pages(tmp_path).endswith("index.cshtml")
    monkeypatch.setattr(web_stacks, "_MAX_ENTRIES", 0)
    assert serves_pages(tmp_path) == ""
