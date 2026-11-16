"""Licences read from installed copies: the edges, and where the lookup reads.

`test_all_stacks.py` reads one installed package per ecosystem. This file holds
the rest: licence texts recognised from their wording, the version picked when
several are installed, metadata of other shapes, and the rule that a lookup
only reads inside the folder it searches (the project's `node_modules`, or
the ecosystem's package cache) whatever the dependency is called.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from license_governance import local_metadata
from license_governance.local_metadata import (
    LocalLicenseResolver,
    detect_license_text,
    license_from_url,
)
from license_governance.scanner import DependencyRecord

MIT_TEXT = "MIT License\n\nPermission is hereby granted, free of charge, to any person"
GPL3_TEXT = "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007"


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _link(link: Path, target: Path) -> bool:
    """A symlink, or False where the platform does not allow one (Windows)."""
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(target, target_is_directory=target.is_dir())
    except OSError:
        return False
    return True


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    for var in ("NUGET_PACKAGES", "CARGO_HOME", "GOPATH", "GOMODCACHE", "PUB_CACHE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    return home


@pytest.fixture
def project(tmp_path: Path) -> Path:
    path = tmp_path / "project"
    path.mkdir()
    return path


@pytest.fixture
def outside(tmp_path: Path) -> Path:
    """A licence that lives outside every folder a lookup may read."""
    folder = tmp_path / "elsewhere"
    _write(folder / "LICENSE", GPL3_TEXT)
    _write(folder / "package.json", '{"license": "GPL-3.0"}')
    _write(folder / "Cargo.toml", 'license = "GPL-3.0"\n')
    return folder


def dep(name: str, ecosystem: str, version: str = "1.0.0") -> DependencyRecord:
    return DependencyRecord(name=name, version=version, ecosystem=ecosystem)


# ---------------------------------------------------------------------------
# licence texts and URLs


@pytest.mark.parametrize(
    ("text", "spdx"),
    [
        ("", None),
        ("GNU AFFERO GENERAL PUBLIC LICENSE Version 3", "AGPL-3.0"),
        ("GNU LESSER GENERAL PUBLIC LICENSE Version 3, 29 June 2007", "LGPL-3.0"),
        ("GNU LIBRARY GENERAL PUBLIC LICENSE Version 2", "LGPL-2.1"),
        (GPL3_TEXT, "GPL-3.0"),
        ("GNU GENERAL PUBLIC LICENSE Version 2, June 1991", "GPL-2.0"),
        ("Mozilla Public License Version 2.0", "MPL-2.0"),
        ("Eclipse Public License - v 2.0", "EPL-2.0"),
        ("Eclipse Public License - v 1.0", "EPL-1.0"),
        (
            "This is free and unencumbered software released into the public domain.",
            "Unlicense",
        ),
        (
            "Permission to use, copy, modify, and/or distribute this software",
            "ISC",
        ),
        (
            "Redistribution and use in source and binary forms ... Neither the name",
            "BSD-3-Clause",
        ),
        ("Redistribution and use in source and binary forms", "BSD-2-Clause"),
        ("Boost Software License - Version 1.0", "BSL-1.0"),
        ("Creative Commons Legal Code CC0 1.0 Universal", "CC0-1.0"),
        ("Apache License (no version given)", None),
    ],
)
def test_a_licence_text_is_named_from_its_wording(text, spdx):
    assert detect_license_text(text) == spdx


@pytest.mark.parametrize(
    ("url", "spdx"),
    [
        ("https://www.apache.org/licenses/LICENSE-2.0", "Apache-2.0"),
        ("https://www.mozilla.org/MPL/2.0/", "MPL-2.0"),
        ("https://example.com/eula", None),
        (None, None),
    ],
)
def test_a_licence_url_is_named_when_it_is_a_known_one(url, spdx):
    assert license_from_url(url) == spdx


# ---------------------------------------------------------------------------
# npm


class TestNpm:
    def test_workspace_packages_have_their_own_node_modules(self, project):
        _write(
            project / "packages" / "web" / "node_modules" / "zod" / "package.json",
            '{"licenses": [{"type": "MIT"}]}',
        )
        _write(project / "apps" / "node_modules", "a file, not a folder")

        assert LocalLicenseResolver(project)(dep("zod", "npm")) == "MIT"

    def test_a_root_without_the_licence_gives_way_to_the_next(self, project):
        _write(project / "node_modules" / "x" / "package.json", "{}")
        _write(
            project / "apps" / "web" / "node_modules" / "x" / "package.json",
            '{"license": "ISC"}',
        )

        assert LocalLicenseResolver(project)(dep("x", "npm")) == "ISC"

    def test_a_manifest_of_another_shape_falls_back_to_the_licence_file(self, project):
        _write(project / "node_modules" / "a" / "package.json", "{broken")
        _write(project / "node_modules" / "b" / "package.json", '["MIT"]')
        _write(project / "node_modules" / "c" / "package.json", '{"license": ""}')
        _write(project / "node_modules" / "c" / "LICENCE", MIT_TEXT)
        local = LocalLicenseResolver(project)

        assert local(dep("a", "npm")) is None
        assert local(dep("b", "npm")) is None
        assert local(dep("c", "npm")) == "MIT"

    def test_a_licence_file_that_names_nothing_known_is_skipped(self, project):
        _write(project / "node_modules" / "d" / "package.json", "{}")
        _write(project / "node_modules" / "d" / "LICENSE", "All rights reserved.")
        _write(project / "node_modules" / "d" / "COPYING", MIT_TEXT)

        assert LocalLicenseResolver(project)(dep("d", "npm")) == "MIT"

    @pytest.mark.parametrize(
        "name",
        [
            "../elsewhere",
            "../../elsewhere",
            "@scope/../../elsewhere",
            "a/b/c",
            "/etc",
            "..\\elsewhere",
            "C:elsewhere",
            "*",
            "",
        ],
    )
    def test_a_name_that_leaves_node_modules_reads_nothing(
        self, project, outside, name
    ):
        _write(project / "node_modules" / "real" / "package.json", '{"license": "MIT"}')

        assert LocalLicenseResolver(project)(dep(name, "npm")) is None

    def test_a_package_linked_out_of_the_project_is_not_read(self, project, outside):
        if not _link(project / "node_modules" / "linked", outside):
            pytest.skip("symlinks are not available here")

        assert LocalLicenseResolver(project)(dep("linked", "npm")) is None

    def test_a_package_linked_within_the_project_is_read(self, project):
        _write(project / "packages" / "ui" / "package.json", '{"license": "MIT"}')
        if not _link(project / "node_modules" / "ui", project / "packages" / "ui"):
            pytest.skip("symlinks are not available here")

        assert LocalLicenseResolver(project)(dep("ui", "npm")) == "MIT"

    def test_roots_are_found_once(self, project, monkeypatch):
        calls = []
        real = local_metadata._npm_roots

        def counting(project_dir):
            calls.append(project_dir)
            return real(project_dir)

        monkeypatch.setattr(local_metadata, "_npm_roots", counting)
        local = LocalLicenseResolver(project)
        local(dep("a", "npm"))
        local(dep("b", "npm"))

        assert len(calls) == 1


# ---------------------------------------------------------------------------
# PyPI


class TestPypi:
    def _dist(self, project: Path, name: str, metadata: str) -> Path:
        dist = project / "venv" / "Lib" / "site-packages" / f"{name}.dist-info"
        _write(dist / "METADATA", metadata)
        return dist

    @pytest.mark.parametrize(
        ("metadata", "found"),
        [
            ("Name: a\nLicense: MIT\nLicense: GPL\n\nLicense: body", "MIT"),
            ("Name: a\nLicense: " + "x" * 300 + "\n\n", None),
            ("Name: a\nLicense: UNKNOWN\n\n", None),
            ("Name: a\nLicense-Expression: Apache-2.0", "Apache-2.0"),
            ("Name: a\nClassifier: License :: OSI Approved\n\n", None),
        ],
    )
    def test_the_headers_give_the_licence(self, project, metadata, found):
        self._dist(project, "a-1.0", metadata)

        assert LocalLicenseResolver(project)(dep("a", "pypi")) == found

    def test_a_licence_file_inside_the_dist_info_answers_last(self, project):
        dist = self._dist(project, "b-2.0", "Name: b\n\n")
        _write(dist / "licenses" / "LICENSE.txt", MIT_TEXT)
        dist_c = self._dist(project, "c-1.0", "Name: c\nLicense: UNKNOWN\n\n")
        _write(dist_c / "LICENSE", GPL3_TEXT)
        local = LocalLicenseResolver(project)

        assert local(dep("b", "pypi")) == "MIT"
        assert local(dep("c", "pypi")) == "GPL-3.0"
        assert local(dep("absent", "pypi")) is None

    def test_a_virtualenv_in_a_workspace_package_counts(self, project):
        _write(
            project
            / "services"
            / "api"
            / ".venv"
            / "lib"
            / "python3.13"
            / "site-packages"
            / "Typing_Extensions-4.12.0.dist-info"
            / "METADATA",
            "Name: typing_extensions\nLicense-Expression: PSF-2.0\n\n",
        )

        assert LocalLicenseResolver(project)(dep("typing.extensions", "pypi")) == (
            "PSF-2.0"
        )


# ---------------------------------------------------------------------------
# the package caches


class TestCaches:
    def test_nuget_honours_its_environment_and_its_licence_file(
        self, home, tmp_path, monkeypatch
    ):
        root = tmp_path / "nuget"
        monkeypatch.setenv("NUGET_PACKAGES", str(root))
        _write(
            root / "serilog" / "3.1.1" / "serilog.nuspec",
            '<package><metadata><license type="file">docs/LICENSE.md</license>'
            "</metadata></package>",
        )
        _write(root / "serilog" / "3.1.1" / "docs" / "LICENSE.md", MIT_TEXT)

        assert LocalLicenseResolver(tmp_path)(dep("Serilog", "nuget", "3.1.1")) == "MIT"

    def test_a_nuspec_naming_a_file_outside_its_package_is_not_followed(
        self, home, project, outside
    ):
        package = home / ".nuget" / "packages" / "evil" / "1.0.0"
        for named in ("../../../../elsewhere/LICENSE", str(outside / "LICENSE")):
            _write(
                package / "evil.nuspec",
                f'<package><metadata><license type="file">{named}</license>'
                "</metadata></package>",
            )

            assert LocalLicenseResolver(project)(dep("Evil", "nuget")) is None

    @pytest.mark.parametrize(
        "nuspec",
        [
            "<package><metadata",
            "<package><metadata><license type='expression'></license>"
            "<licenseUrl>https://example.com/eula</licenseUrl></metadata></package>",
            "<package><metadata><license type='file'>NOTICE</license></metadata></package>",
        ],
    )
    def test_a_nuspec_with_no_licence_falls_back_to_the_licence_file(
        self, home, project, nuspec
    ):
        package = home / ".nuget" / "packages" / "lib" / "2.0.0"
        _write(package / "lib.nuspec", nuspec)
        _write(package / "NOTICE", "no licence wording here")
        _write(package / "LICENSE.txt", MIT_TEXT)

        assert LocalLicenseResolver(project)(dep("Lib", "nuget", "2.0.0")) == "MIT"

    def test_a_package_without_a_nuspec_is_read_from_its_licence_file(
        self, home, project
    ):
        _write(home / ".nuget" / "packages" / "bare" / "1.0.0" / "LICENSE", MIT_TEXT)

        assert LocalLicenseResolver(project)(dep("Bare", "nuget", "1.0.0")) == "MIT"

    def test_nuget_without_any_installed_version(self, home, project):
        (home / ".nuget" / "packages" / "empty").mkdir(parents=True)
        _write(home / ".nuget" / "packages" / "empty" / "notes.txt", "")

        assert LocalLicenseResolver(project)(dep("Empty", "nuget")) is None
        assert LocalLicenseResolver(project)(dep("Absent", "nuget")) is None

    @pytest.mark.parametrize("name", ["../../elsewhere", "a/b", "*"])
    def test_a_nuget_name_that_leaves_the_cache_reads_nothing(
        self, home, project, outside, name
    ):
        assert LocalLicenseResolver(project)(dep(name, "nuget")) is None

    def test_a_version_folder_linked_out_of_the_cache_is_not_read(
        self, home, project, outside
    ):
        if not _link(home / ".nuget" / "packages" / "lnk" / "1.0.0", outside):
            pytest.skip("symlinks are not available here")

        assert LocalLicenseResolver(project)(dep("Lnk", "nuget", "1.0.0")) is None

    def test_cargo_picks_the_exact_version_then_any_other(
        self, home, project, monkeypatch, tmp_path
    ):
        cargo = tmp_path / "cargo-home"
        monkeypatch.setenv("CARGO_HOME", str(cargo))
        index = cargo / "registry" / "src" / "index"
        _write(index / "rand-0.8.5" / "Cargo.toml", 'license = "MIT OR Apache-2.0"\n')
        _write(index / "rand-0.9.0" / "Cargo.toml", "[package]\n")
        _write(index / "rand-0.9.0" / "LICENSE-MIT", "")
        _write(index / "rand-0.9.0" / "LICENSE", MIT_TEXT)
        _write(index / "rand_core-0.6.4" / "Cargo.toml", 'license = "GPL-3.0"\n')
        _write(index / "nolicence-1.0.0" / "Cargo.toml", "[package]\n")
        local = LocalLicenseResolver(project)

        assert local(dep("rand", "cargo", "0.8.5")) == "MIT OR Apache-2.0"
        assert local(dep("rand", "cargo", "0.9.0")) == "MIT"
        assert local(dep("nolicence", "cargo", "^1")) is None

    @pytest.mark.parametrize("name", ["../elsewhere", "*", "a/b"])
    def test_a_cargo_name_that_leaves_the_cache_reads_nothing(
        self, home, project, outside, name
    ):
        _write(
            home
            / ".cargo"
            / "registry"
            / "src"
            / "index"
            / "real-1.0.0"
            / "Cargo.toml",
            'license = "MIT"\n',
        )

        assert LocalLicenseResolver(project)(dep(name, "cargo")) is None

    def test_a_crate_linked_out_of_the_cache_is_not_read(self, home, project, outside):
        index = home / ".cargo" / "registry" / "src" / "index"
        index.mkdir(parents=True)
        if not _link(index / "linked-1.0.0", outside):
            pytest.skip("symlinks are not available here")

        assert LocalLicenseResolver(project)(dep("linked", "cargo", "1.0.0")) is None

    def test_go_honours_its_cache_variables(self, home, project, monkeypatch, tmp_path):
        cache = tmp_path / "modcache"
        monkeypatch.setenv("GOMODCACHE", str(cache))
        _write(cache / "golang.org" / "x" / "text@v0.14.0" / "LICENSE", "BSD-ish?")
        _write(cache / "golang.org" / "x" / "text@v0.13.0" / "LICENSE", MIT_TEXT)

        local = LocalLicenseResolver(project)
        assert local(dep("golang.org/x/text", "go", "v0.14.0")) == "MIT"
        assert local(dep("golang.org/x/text", "go", "v0.15.0")) == "MIT"
        assert local(dep("golang.org/x/absent", "go", "v1.0.0")) is None

    @pytest.mark.parametrize(
        ("name", "version"),
        [
            ("../../elsewhere", "v1.0.0"),
            ("github.com/x/y", "../../../../elsewhere"),
            ("github.com/*", "v1.0.0"),
            ("/etc", "v1.0.0"),
        ],
    )
    def test_a_go_module_that_leaves_the_cache_reads_nothing(
        self, home, project, outside, name, version
    ):
        _write(
            home / "go" / "pkg" / "mod" / "github.com" / "a" / "b@v1" / "LICENSE",
            MIT_TEXT,
        )

        assert LocalLicenseResolver(project)(dep(name, "go", version)) is None

    def test_a_go_module_linked_out_of_the_cache_is_not_read(
        self, home, project, outside
    ):
        if not _link(home / "go" / "pkg" / "mod" / "example.com" / "m@v1.0.0", outside):
            pytest.skip("symlinks are not available here")

        assert (
            LocalLicenseResolver(project)(dep("example.com/m", "go", "v1.0.0")) is None
        )

    def test_maven_reads_the_licence_url_when_no_name_is_given(self, home, project):
        folder = home / ".m2" / "repository" / "com" / "acme" / "core" / "1.2.0"
        _write(
            folder / "core-1.2.0.pom",
            "<project><licenses><license><url>https://opensource.org/licenses/MIT"
            "</url></license><license><name></name><url>x</url></license>"
            "</licenses></project>",
        )

        assert LocalLicenseResolver(project)(
            dep("com.acme:core", "maven", "1.2.0")
        ) == ("MIT")

    @pytest.mark.parametrize(
        "pom",
        [
            None,
            "<project><licenses>",
            "<project><licenses><license><url>x</url></license></licenses></project>",
            "<project><name>no licence</name></project>",
        ],
    )
    def test_maven_without_a_readable_licence(self, home, project, pom):
        folder = home / ".m2" / "repository" / "com" / "acme" / "util" / "1.0.0"
        folder.mkdir(parents=True)
        if pom is not None:
            _write(folder / "util-1.0.0.pom", pom)

        assert LocalLicenseResolver(project)(dep("com.acme:util", "maven")) is None

    @pytest.mark.parametrize(
        "name",
        ["no-colon", "..:elsewhere", "com.acme:../../elsewhere", "com..acme:x", ":x"],
    )
    def test_a_maven_name_that_leaves_the_repository_reads_nothing(
        self, home, project, outside, name
    ):
        assert LocalLicenseResolver(project)(dep(name, "maven")) is None

    def test_a_maven_version_linked_out_of_the_repository_is_not_read(
        self, home, project, outside
    ):
        _write(
            outside / "x-1.0.0.pom",
            "<project><licenses><license><name>GPL</name>"
            "</license></licenses></project>",
        )
        link = home / ".m2" / "repository" / "com" / "acme" / "x" / "1.0.0"
        if not _link(link, outside):
            pytest.skip("symlinks are not available here")

        assert (
            LocalLicenseResolver(project)(dep("com.acme:x", "maven", "1.0.0")) is None
        )

    def test_pub_honours_its_cache_and_skips_files(
        self, home, project, monkeypatch, tmp_path
    ):
        cache = tmp_path / "pub"
        monkeypatch.setenv("PUB_CACHE", str(cache))
        hosted = cache / "hosted" / "pub.dev"
        _write(hosted / "path-1.9.0", "a file, not a package")
        _write(hosted / "path-1.8.0" / "LICENSE", "no wording")
        _write(hosted / "path-1.7.0" / "LICENSE", MIT_TEXT)

        assert LocalLicenseResolver(project)(dep("path", "pub", "1.9.0")) == "MIT"
        assert LocalLicenseResolver(project)(dep("absent", "pub", "^1")) is None

    @pytest.mark.parametrize("name", ["../elsewhere", "*", "a/b"])
    def test_a_pub_name_that_leaves_the_cache_reads_nothing(
        self, home, project, outside, name
    ):
        assert LocalLicenseResolver(project)(dep(name, "pub")) is None

    def test_a_pub_package_linked_out_of_the_cache_is_not_read(
        self, home, project, outside
    ):
        hosted = home / ".pub-cache" / "hosted" / "pub.dev"
        if not _link(hosted / "linked-1.0.0", outside):
            pytest.skip("symlinks are not available here")

        assert LocalLicenseResolver(project)(dep("linked", "pub", "1.0.0")) is None


# ---------------------------------------------------------------------------
# the resolver itself


class TestTheResolver:
    def test_an_ecosystem_without_a_local_reader_is_unresolved(self, project):
        assert LocalLicenseResolver(project)(dep("x", "hex")) is None

    def test_a_filesystem_error_is_no_licence(self, project, monkeypatch, home):
        def broken(*_args):
            raise PermissionError("denied")

        monkeypatch.setattr(local_metadata, "_cargo_license", broken)

        assert LocalLicenseResolver(project)(dep("x", "cargo")) is None

    def test_an_unreadable_licence_file_reads_as_empty(self, tmp_path):
        folder = tmp_path / "pkg"
        (folder / "LICENSE").mkdir(parents=True)  # a folder, not a file

        assert local_metadata._read(folder / "LICENSE") == ""
        assert local_metadata._license_file_in(folder) is None

    def test_the_home_falls_back_to_the_platform_s_own(self, monkeypatch):
        monkeypatch.delenv("USERPROFILE", raising=False)
        monkeypatch.delenv("HOME", raising=False)

        assert local_metadata._home() == Path.home()

    def test_an_unlistable_version_folder_is_no_version(self, tmp_path, monkeypatch):
        parent = tmp_path / "versions"
        parent.mkdir()

        def refuse(self):
            raise PermissionError(self)

        monkeypatch.setattr(Path, "iterdir", refuse)

        assert local_metadata._pick_version_dir(parent, "^1") is None
        assert local_metadata._pick_version_dir(tmp_path / "missing", "1") is None

    def test_a_relative_check_on_an_unresolvable_path_is_outside(
        self, tmp_path, monkeypatch
    ):
        def loop(self, strict=False):
            raise OSError("too many links")

        monkeypatch.setattr(Path, "resolve", loop)

        assert local_metadata._inside(tmp_path, tmp_path / "x") is False


def test_os_separator_is_not_a_package_name_character():
    """On every platform a name is split on `/` only; `os.sep` is refused."""
    assert local_metadata._plain(f"a{os.sep}b") is None
