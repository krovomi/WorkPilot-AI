"""Every stack's manifest gives the registry packages it declares, and only those.

A path, a git URL, a workspace link or a platform requirement is not a name a
registry can confirm: reported as missing, it would block a build that is
fine, which is the one thing the guard must never do.
"""

from __future__ import annotations

import pytest
from dependency_guard.manifests import Package, is_manifest, parse_manifest


def names(path: str, text: str) -> set[tuple[str, str]]:
    return {(p.ecosystem, p.name) for p in parse_manifest(path, text)}


def test_package_json_keeps_registry_names_and_follows_aliases():
    text = """{
      "dependencies": {"react": "^18", "@scope/ui": "1.0.0",
                       "local": "file:../local", "linked": "workspace:*",
                       "fork": "github:me/fork", "tarball": "https://x.test/a.tgz",
                       "alias": "npm:lodash-es@^4"},
      "devDependencies": {"vitest": "^2"}
    }"""
    assert names("package.json", text) == {
        ("npm", "react"),
        ("npm", "@scope/ui"),
        ("npm", "lodash-es"),
        ("npm", "vitest"),
    }


def test_requirements_txt_reads_names_and_skips_options_and_urls():
    text = (
        "requests>=2  # http\n"
        "Django[argon2]==5.0 ; python_version > '3.10'\n"
        "-r other.txt\n"
        "-e ./local\n"
        "--index-url https://pypi.org/simple\n"
        "pkg @ https://example.test/pkg.whl\n"
        "\n"
    )
    found = names("requirements-dev.txt", text)
    assert ("pypi", "requests") in found
    assert ("pypi", "Django") in found
    assert not any(n in ("pkg", "other.txt", "./local") for _, n in found)


def test_pyproject_reads_pep621_groups_and_poetry_minus_uv_sources():
    text = """
[project]
dependencies = ["httpx>=0.27", "mylib"]
[project.optional-dependencies]
dev = ["pytest"]
[dependency-groups]
lint = ["ruff"]
[tool.poetry.dependencies]
python = "^3.12"
rich = "^13"
[tool.uv.sources]
mylib = { path = "../mylib" }
"""
    found = names("pyproject.toml", text)
    assert {
        ("pypi", "httpx"),
        ("pypi", "pytest"),
        ("pypi", "ruff"),
        ("pypi", "rich"),
    } <= found
    assert ("pypi", "mylib") not in found
    assert ("pypi", "python") not in found


def test_cargo_skips_path_git_and_workspace():
    text = """
[dependencies]
serde = "1"
tokio = { version = "1", features = ["full"] }
local = { path = "../local" }
forked = { git = "https://github.com/x/y" }
shared = { workspace = true }
[dev-dependencies]
proptest = "1"
"""
    assert names("Cargo.toml", text) == {
        ("cargo", "serde"),
        ("cargo", "tokio"),
        ("cargo", "proptest"),
    }


def test_go_mod_reads_require_blocks_minus_replaced_modules():
    text = """module example.com/app

go 1.23

require (
    github.com/gin-gonic/gin v1.10.0
    example.com/internal v0.0.0 // indirect
)
require golang.org/x/text v0.14.0

replace example.com/internal => ../internal
"""
    assert names("go.mod", text) == {
        ("go", "github.com/gin-gonic/gin"),
        ("go", "golang.org/x/text"),
    }


def test_dotnet_project_files_and_packages_config():
    csproj = """<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="MediatR" Version="12.0.0" />
    <PackageReference Include="Serilog"><Version>4.0.0</Version></PackageReference>
    <ProjectReference Include="..\\Domain\\Domain.csproj" />
  </ItemGroup>
</Project>"""
    assert names("src/Api/Api.csproj", csproj) == {
        ("nuget", "MediatR"),
        ("nuget", "Serilog"),
    }
    central = """<Project><ItemGroup>
      <PackageVersion Include="FluentValidation" Version="11.0.0" />
    </ItemGroup></Project>"""
    assert names("Directory.Packages.props", central) == {("nuget", "FluentValidation")}
    config = '<packages><package id="Newtonsoft.Json" version="13.0.3" /></packages>'
    assert names("packages.config", config) == {("nuget", "Newtonsoft.Json")}


def test_maven_and_gradle_coordinates():
    pom = """<project xmlns="http://maven.apache.org/POM/4.0.0">
  <dependencies>
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency>
    <dependency><groupId>${project.groupId}</groupId><artifactId>core</artifactId></dependency>
    <dependency><groupId>com.x</groupId><artifactId>sys</artifactId><scope>system</scope></dependency>
  </dependencies>
</project>"""
    assert names("pom.xml", pom) == {("maven", "org.slf4j:slf4j-api")}
    gradle = """dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation 'junit:junit:4.13.2'
    implementation project(':core')
}"""
    assert names("app/build.gradle.kts", gradle) == {
        ("maven", "com.squareup.okhttp3:okhttp"),
        ("maven", "junit:junit"),
    }


def test_composer_pubspec_and_gemfile():
    composer = """{"require": {"php": ">=8.2", "ext-json": "*",
                   "laravel/framework": "^11"},
                   "require-dev": {"phpunit/phpunit": "^11"}}"""
    assert names("composer.json", composer) == {
        ("packagist", "laravel/framework"),
        ("packagist", "phpunit/phpunit"),
    }
    pubspec = """name: app
dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
  local:
    path: ../local
dev_dependencies:
  mocktail: ^1.0.0
"""
    assert names("pubspec.yaml", pubspec) == {("pub", "http"), ("pub", "mocktail")}
    gemfile = """source "https://rubygems.org"
gem "rails", "~> 7.1"
gem "mine", path: "../mine"
gem "edge", git: "https://github.com/x/edge"
group :test do
  gem 'rspec'
end
"""
    assert names("Gemfile", gemfile) == {("rubygems", "rails"), ("rubygems", "rspec")}


def test_vendored_and_build_directories_are_not_manifests():
    assert is_manifest("package.json")
    assert is_manifest("src/App/App.csproj")
    assert not is_manifest("node_modules/react/package.json")
    assert not is_manifest("src/App/obj/project.assets.json")
    assert not is_manifest("vendor/laravel/framework/composer.json")
    assert not is_manifest("README.md")


@pytest.mark.parametrize(
    ("path", "text"),
    [
        ("package.json", "{not json"),
        ("pyproject.toml", "[project\n"),
        ("App.csproj", "<Project><ItemGroup>"),
    ],
)
def test_an_unparseable_manifest_raises_instead_of_reading_empty(path, text):
    with pytest.raises(ValueError):
        parse_manifest(path, text)


def test_an_xml_bomb_is_refused():
    bomb = (
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">'
        '<!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><Project>&lol2;</Project>'
    )
    with pytest.raises(ValueError):
        parse_manifest("App.csproj", bomb)


def test_names_compare_the_way_their_registry_does():
    assert (
        Package("pypi", "Python_Dateutil").key == Package("pypi", "python-dateutil").key
    )
    assert Package("nuget", "Serilog").key == Package("nuget", "serilog").key
    assert Package("npm", "React").key != Package("npm", "react").key
