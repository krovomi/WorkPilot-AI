"""Technical debt and longevity on every stack, not Python and npm only."""

from __future__ import annotations

from pathlib import Path

import pytest
from tech_debt.manifests import stale_dependencies
from tech_debt.scanner import SKIP_DIRS, scan_project


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


MANIFESTS = {
    "nuget": (
        "src/Api/Api.csproj",
        """<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
<PackageReference Include="Serilog" Version="4.*" />
<PackageReference Include="Contoso.Next" Version="2.0.0-preview.3" />
<PackageReference Include="Dapper" Version="2.1.35" />
<PackageReference Include="Central.Managed" />
</ItemGroup></Project>""",
        {("Serilog", "floating"), ("Contoso.Next", "prerelease")},
    ),
    "maven": (
        "pom.xml",
        """<project><dependencies>
<dependency><groupId>com.acme</groupId><artifactId>core</artifactId><version>1.2-SNAPSHOT</version></dependency>
<dependency><groupId>org.x</groupId><artifactId>y</artifactId><version>[1.0,2.0)</version></dependency>
<dependency><groupId>org.ok</groupId><artifactId>ok</artifactId><version>3.4.5</version></dependency>
<dependency><groupId>org.prop</groupId><artifactId>p</artifactId><version>${p.version}</version></dependency>
</dependencies></project>""",
        {("com.acme:core", "snapshot"), ("org.x:y", "range")},
    ),
    "gradle": (
        "app/build.gradle.kts",
        'dependencies {\n  implementation("io.ktor:ktor-core:2.+")\n  implementation("a:b:1.0.0")\n'
        '  testImplementation("c:d:latest.release")\n}\n',
        {("io.ktor:ktor-core", "floating"), ("c:d", "floating")},
    ),
    "cargo": (
        "Cargo.toml",
        '[package]\nname = "app"\n\n[dependencies]\nserde = "*"\ntokio = { version = "1.40" }\n'
        'mylib = { git = "https://example.com/mylib" }\npinned = { git = "https://x", rev = "abc" }\n',
        {("serde", "unpinned"), ("mylib", "vcs")},
    ),
    "go": (
        "go.mod",
        "module example.com/app\n\nrequire (\n\tgithub.com/acme/lib v0.0.0-20240102150405-abcdef123456\n"
        "\tgithub.com/ok/ok v1.4.0\n)\n",
        {("github.com/acme/lib", "pseudo_version")},
    ),
    "composer": (
        "composer.json",
        '{"require": {"php": ">=8.2", "acme/x": "*", "acme/y": "dev-main", "acme/z": "^3.1"}}',
        {("acme/x", "unpinned"), ("acme/y", "prerelease")},
    ),
    "pub": (
        "pubspec.yaml",
        "name: app\ndependencies:\n  http: any\n  intl: ^0.19.0\n  mypkg:\n    git:\n      url: https://x\n",
        {("http", "unpinned"), ("mypkg", "vcs")},
    ),
    "npm": (
        "apps/web/package.json",
        '{"dependencies": {"left": "^0.3.0", "ok": "^5.0.0", "any": "*", "fork": "github:me/fork"}}',
        {("left", "pre_1_0"), ("any", "unpinned"), ("fork", "vcs")},
    ),
    "pip": (
        "services/api/requirements-dev.txt",
        "requests\nflask==3.0.0\n# comment\n-r base.txt\nhttpx>=0.27\n",
        {("requests", "unpinned")},
    ),
}


@pytest.mark.parametrize("ecosystem", sorted(MANIFESTS))
def test_each_ecosystem_flags_what_will_rot_and_nothing_else(tmp_path, ecosystem):
    rel, text, expected = MANIFESTS[ecosystem]
    _write(tmp_path, rel, text)
    found = stale_dependencies(tmp_path, SKIP_DIRS)
    assert {(d.name, d.reason) for d in found} == expected
    assert {d.ecosystem for d in found} == {ecosystem}
    assert all(d.file_path == rel for d in found)


def test_manifests_in_dependency_folders_are_not_read(tmp_path):
    _write(tmp_path, "node_modules/x/package.json", '{"dependencies": {"a": "*"}}')
    _write(tmp_path, "vendor/acme/composer.json", '{"require": {"b": "*"}}')
    assert stale_dependencies(tmp_path, SKIP_DIRS) == []


SOURCES = {
    "Service.kt": "// TODO: split this service\nfun main() {}\n",
    "View.swift": "// FIXME: retain cycle\nfunc load() {}\n",
    "home.dart": "// TODO: localise\nvoid main() {}\n",
    "Controller.php": "<?php // HACK: until v2\nfunction index() {}\n",
    "user.rb": "# TODO: remove\ndef call; end\n",
    "App.vue": "<template><!-- TODO: empty state --></template>\n",
    "engine.cpp": "// XXX: overflow\nint main() {}\n",
}


def test_todos_are_found_in_every_stack_and_a_string_is_not_a_todo(tmp_path):
    for name, text in SOURCES.items():
        _write(tmp_path, f"src/{name}", text)
    _write(tmp_path, "src/labels.ts", "export const label = 'Todo list';\n")
    report = scan_project(tmp_path, persist=False)
    todo_files = {
        Path(i.file_path).name for i in report.items if i.kind == "todo_fixme"
    }
    assert todo_files == set(SOURCES)


def test_a_long_go_function_is_seen(tmp_path):
    body = "\n".join(f"\tx{i} := {i}" for i in range(80))
    _write(tmp_path, "main.go", f"package main\n\nfunc handle() {{\n{body}\n}}\n")
    report = scan_project(tmp_path, persist=False)
    assert any(i.kind == "long_function" for i in report.items)
