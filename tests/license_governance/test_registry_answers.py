"""What the licence resolvers make of the registries' answers.

A registry is a remote service: its answer is read as it comes, and an answer
of the wrong shape (a list where an object was expected, one licence as a bare
string, a binary body) must give "no licence" rather than a crash or a licence
spelled one letter at a time. The transport is replaced at `urlopen`, so the
fetch itself is exercised too; nothing reaches the network.
"""

from __future__ import annotations

import urllib.error

import pytest
from license_governance import resolvers
from license_governance.resolvers import (
    LicenseResolution,
    _TtlCache,
    deps_dev_resolver,
    make_registry_resolver,
    npm_resolver,
    packagist_resolver,
    pub_resolver,
    pypi_resolver,
    registry_lookup,
    rubygems_resolver,
)
from license_governance.scanner import DependencyRecord


def a_dep(name: str, ecosystem: str, version: str = "1.0.0", **kw) -> DependencyRecord:
    return DependencyRecord(name=name, version=version, ecosystem=ecosystem, **kw)


@pytest.fixture(autouse=True)
def _fresh_cache():
    resolvers.reset_cache_for_tests()
    yield
    resolvers.reset_cache_for_tests()


@pytest.fixture
def registry(monkeypatch):
    """Answer each URL from a dict; record the URLs asked for."""
    answers: dict[str, object] = {}
    asked: list[str] = []

    def fetch(url: str):
        asked.append(url)
        return answers.get(url)

    monkeypatch.setattr(resolvers, "_http_get_json", fetch)
    return answers, asked


# ---------------------------------------------------------------------------
# the fetch


class _Response:
    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestTheFetch:
    @pytest.fixture
    def serve(self, monkeypatch):
        seen = {}

        def install(answer):
            def urlopen(request, timeout=None):
                seen["url"] = request.full_url
                seen["agent"] = request.get_header("User-agent")
                seen["timeout"] = timeout
                if isinstance(answer, BaseException):
                    raise answer
                return answer

            monkeypatch.setattr(resolvers.urllib.request, "urlopen", urlopen)
            return seen

        return install

    def test_an_object_is_returned_parsed(self, serve):
        seen = serve(_Response(b'{"license": "MIT"}'))

        assert resolvers._http_get_json("https://registry.test/x") == {"license": "MIT"}
        assert seen["url"] == "https://registry.test/x"
        assert seen["agent"].startswith("WorkPilotAI-license-scanner")
        assert seen["timeout"] == resolvers._TIMEOUT

    @pytest.mark.parametrize(
        "answer",
        [
            _Response(b'{"license": "MIT"}', status=404),
            _Response(b""),
            _Response(b"<html>not json</html>"),
            _Response(b"\xff\xfe\x00binary"),
            _Response(b'["a", "list"]'),
            _Response(b'"a string"'),
            urllib.error.URLError("no route"),
            TimeoutError("slow"),
            ConnectionResetError("reset"),
        ],
    )
    def test_anything_but_an_object_is_no_answer(self, serve, answer):
        serve(answer)

        assert resolvers._http_get_json("https://registry.test/x") is None


class TestTheCache:
    def test_an_entry_older_than_the_ttl_is_gone(self, monkeypatch):
        cache = _TtlCache(ttl_seconds=10)
        clock = [1000.0]
        monkeypatch.setattr(resolvers.time, "time", lambda: clock[0])
        cache.put("k", "MIT")

        clock[0] += 5
        assert cache.get("k") == "MIT"
        clock[0] += 6
        assert cache.get("k") is resolvers._MISS
        assert cache.get("k") is resolvers._MISS


# ---------------------------------------------------------------------------
# npm and PyPI


class TestNpmAnswers:
    URL = "https://registry.npmjs.org/@scope/pkg"

    def test_a_scoped_name_keeps_its_slash(self, registry):
        answers, asked = registry
        answers[self.URL] = {"license": "ISC"}

        assert npm_resolver(a_dep("@scope/pkg", "npm")) == "ISC"
        assert asked == [self.URL]

    @pytest.mark.parametrize(
        "payload",
        [
            {"dist-tags": ["latest"], "versions": [], "license": "MIT"},
            {"dist-tags": {"latest": 3}, "license": "MIT"},
            {
                "dist-tags": {"latest": "2.0.0"},
                "versions": {"2.0.0": "x"},
                "license": "MIT",
            },
        ],
    )
    def test_odd_version_sections_fall_back_to_the_top_level_licence(
        self, registry, payload
    ):
        answers, _ = registry
        answers[self.URL] = payload

        assert npm_resolver(a_dep("@scope/pkg", "npm")) == "MIT"

    def test_no_licence_anywhere_is_remembered_as_none(self, registry):
        answers, asked = registry
        answers[self.URL] = {"name": "pkg"}

        assert npm_resolver(a_dep("@scope/pkg", "npm")) is None
        assert npm_resolver(a_dep("@scope/pkg", "npm")) is None
        assert len(asked) == 1


class TestPypiAnswers:
    URL = "https://pypi.org/pypi/requests/json"

    @pytest.mark.parametrize(
        ("info", "expected"),
        [
            ("not an object", None),
            ({"license": {"text": "MIT"}}, None),
            ({"license": "", "classifiers": "License :: MIT"}, None),
            (
                {"classifiers": [7, "License :: OSI Approved :: BSD License"]},
                "BSD License",
            ),
            ({"classifiers": ["License :: OSI Approved :: "]}, None),
        ],
    )
    def test_the_licence_is_read_from_string_fields_only(
        self, registry, info, expected
    ):
        answers, _ = registry
        answers[self.URL] = {"info": info}

        assert pypi_resolver(a_dep("requests", "pypi")) == expected

    def test_a_cached_answer_is_served_without_asking_again(self, registry):
        answers, asked = registry
        answers[self.URL] = {"info": {"license": "Apache-2.0"}}

        assert pypi_resolver(a_dep("requests", "pypi")) == "Apache-2.0"
        assert pypi_resolver(a_dep("requests", "pypi")) == "Apache-2.0"
        assert asked == [self.URL]

    def test_a_failed_lookup_is_not_remembered(self, registry):
        answers, asked = registry

        assert pypi_resolver(a_dep("requests", "pypi")) is None
        answers[self.URL] = {"info": {"license": "MIT"}}
        assert pypi_resolver(a_dep("requests", "pypi")) == "MIT"
        assert len(asked) == 2


# ---------------------------------------------------------------------------
# deps.dev


class TestDepsDevAnswers:
    BASE = "https://api.deps.dev/v3/systems/GO/packages/github.com%2Fa%2Fb"

    def test_an_unknown_ecosystem_or_a_nameless_dep_asks_nobody(self, registry):
        _, asked = registry

        assert deps_dev_resolver(a_dep("x", "hex")) is None
        assert deps_dev_resolver(a_dep("", "npm")) is None
        assert asked == []

    def test_a_go_version_gets_its_v_prefix(self, registry):
        answers, asked = registry
        answers[f"{self.BASE}/versions/v1.4.0"] = {"licenses": ["BSD-3-Clause"]}

        assert deps_dev_resolver(a_dep("github.com/a/b", "go", "1.4.0")) == (
            "BSD-3-Clause"
        )
        assert asked == [f"{self.BASE}/versions/v1.4.0"]

    def test_a_single_licence_string_is_not_read_letter_by_letter(self, registry):
        answers, _ = registry
        answers[f"{self.BASE}/versions/v1.4.0"] = {"licenses": "MIT"}

        assert deps_dev_resolver(a_dep("github.com/a/b", "go", "v1.4.0")) is None

    def test_only_non_standard_licences_are_no_licence(self, registry):
        answers, _ = registry
        answers[f"{self.BASE}/versions/v1.4.0"] = {"licenses": ["non-standard"]}

        assert deps_dev_resolver(a_dep("github.com/a/b", "go", "v1.4.0")) is None

    @pytest.mark.parametrize(
        "package",
        [
            None,
            {"versions": []},
            {"versions": ["v1", 3]},
            {"versions": [{"versionKey": "v1"}]},
            {"versions": [{"isDefault": True, "versionKey": {"version": 7}}]},
        ],
    )
    def test_a_range_with_no_readable_default_version_is_unresolved(
        self, registry, package
    ):
        answers, asked = registry
        answers[self.BASE] = package

        assert deps_dev_resolver(a_dep("github.com/a/b", "go", "^1.2")) is None
        assert asked == [self.BASE]

    def test_the_version_lookup_failing_is_unresolved(self, registry):
        answers, _ = registry
        answers[self.BASE] = {
            "versions": [{"isDefault": True, "versionKey": {"version": "v1.0.0"}}]
        }

        assert deps_dev_resolver(a_dep("github.com/a/b", "go", "latest")) is None

    def test_an_answer_is_cached_per_version(self, registry):
        answers, asked = registry
        answers[f"{self.BASE}/versions/v1.4.0"] = {"licenses": ["MIT"]}
        dep = a_dep("github.com/a/b", "go", "v1.4.0")

        assert deps_dev_resolver(dep) == deps_dev_resolver(dep) == "MIT"
        assert len(asked) == 1


# ---------------------------------------------------------------------------
# Packagist, RubyGems, pub.dev


class TestPackagistAnswers:
    URL = "https://repo.packagist.org/p2/monolog/monolog.json"

    def test_the_latest_release_gives_the_licence(self, registry):
        answers, asked = registry
        answers[self.URL] = {
            "packages": {
                "monolog/monolog": [{"license": ["MIT"]}, {"license": ["GPL"]}]
            }
        }

        assert packagist_resolver(a_dep("Monolog/Monolog", "composer")) == "MIT"
        assert packagist_resolver(a_dep("Monolog/Monolog", "composer")) == "MIT"
        assert asked == [self.URL]

    def test_a_name_is_quoted_into_the_path(self, registry):
        _, asked = registry

        packagist_resolver(a_dep("vendor/pkg?x=1#y", "composer"))

        assert asked == ["https://repo.packagist.org/p2/vendor/pkg%3Fx%3D1%23y.json"]

    @pytest.mark.parametrize(
        "payload",
        [
            {"packages": []},
            {"packages": {"monolog/monolog": "1.0"}},
            {"packages": {"monolog/monolog": []}},
            {"packages": {"monolog/monolog": ["release"]}},
            {"packages": {"monolog/monolog": [{"license": "MIT"}]}},
        ],
    )
    def test_odd_release_lists_are_unresolved(self, registry, payload):
        answers, _ = registry
        answers[self.URL] = payload

        assert packagist_resolver(a_dep("monolog/monolog", "composer")) is None

    def test_a_name_without_a_vendor_asks_nobody(self, registry):
        _, asked = registry

        assert packagist_resolver(a_dep("monolog", "composer")) is None
        assert packagist_resolver(a_dep("a/b", "npm")) is None
        assert asked == []

    def test_a_failed_lookup_is_unresolved(self, registry):
        assert packagist_resolver(a_dep("monolog/monolog", "composer")) is None


class TestRubygemsAnswers:
    URL = "https://rubygems.org/api/v1/gems/rails.json"

    @pytest.mark.parametrize(
        ("licenses", "expected"),
        [
            (["MIT", 3], "MIT"),
            (["MIT", "Ruby"], "MIT OR Ruby"),
            ("MIT", None),
            ([], None),
        ],
    )
    def test_the_licence_list_is_joined(self, registry, licenses, expected):
        answers, _ = registry
        answers[self.URL] = {"licenses": licenses}

        assert rubygems_resolver(a_dep("rails", "rubygems")) == expected

    def test_a_cached_answer_and_a_failure(self, registry):
        answers, asked = registry
        assert rubygems_resolver(a_dep("rails", "rubygems")) is None
        answers[self.URL] = {"licenses": ["MIT"]}
        assert rubygems_resolver(a_dep("rails", "rubygems")) == "MIT"
        assert rubygems_resolver(a_dep("rails", "rubygems")) == "MIT"
        assert len(asked) == 2

    def test_another_ecosystem_asks_nobody(self, registry):
        assert rubygems_resolver(a_dep("rails", "npm")) is None
        assert registry[1] == []


class TestPubAnswers:
    URL = "https://pub.dev/api/packages/http/score"

    def test_the_licence_tags_give_the_licence(self, registry):
        answers, _ = registry
        answers[self.URL] = {
            "tags": [
                "sdk:flutter",
                "license:bsd-3-clause",
                "license:mit",
                "license:osi-approved",
                "license:fsf-libre",
                "license:unknown",
                9,
            ]
        }

        assert pub_resolver(a_dep("http", "pub")) == "bsd-3-clause OR MIT"

    def test_tags_that_are_not_a_list_are_no_licence(self, registry):
        answers, _ = registry
        answers[self.URL] = {"tags": "license:mit"}

        assert pub_resolver(a_dep("http", "pub")) is None

    def test_a_cached_answer_and_a_failure(self, registry):
        answers, asked = registry
        assert pub_resolver(a_dep("http", "pub")) is None
        answers[self.URL] = {"tags": ["license:isc"]}
        assert pub_resolver(a_dep("http", "pub")) == "ISC"
        assert pub_resolver(a_dep("http", "pub")) == "ISC"
        assert len(asked) == 2

    def test_another_ecosystem_asks_nobody(self, registry):
        assert pub_resolver(a_dep("http", "npm")) is None
        assert registry[1] == []


# ---------------------------------------------------------------------------
# routing


class TestRouting:
    def test_the_second_registry_answers_when_the_first_has_nothing(self, registry):
        answers, asked = registry
        answers["https://pypi.org/pypi/flask/json"] = {"info": {}}
        answers[
            "https://api.deps.dev/v3/systems/PYPI/packages/flask/versions/3.0.0"
        ] = {"licenses": ["BSD-3-Clause"]}

        assert registry_lookup(a_dep("flask", "pypi", "3.0.0")) == "BSD-3-Clause"
        assert len(asked) == 2

    def test_nobody_answering_is_unresolved(self, registry):
        assert registry_lookup(a_dep("flask", "pypi", "3.0.0")) is None
        assert registry_lookup(a_dep("x", "hex")) is None

    def test_a_licence_list_naming_nothing_is_no_licence(self, registry):
        answers, _ = registry
        answers["https://registry.npmjs.org/old"] = {"license": [{"url": "x"}, 4]}

        assert npm_resolver(a_dep("old", "npm")) is None

    def test_without_a_local_reader_the_registry_answers(self):
        resolution = LicenseResolution(registry=lambda dep: "MIT")
        dep = a_dep("x", "npm")

        assert resolution(dep) == "MIT"
        assert resolution.source_of(dep) == "registry"

    def test_the_resolution_falls_through_to_nothing(self):
        resolution = LicenseResolution(
            local=lambda dep: None, registry=lambda dep: None, overrides={"x": None}
        )
        dep = a_dep("x", "npm")

        assert resolution(dep) is None
        assert resolution.source_of(dep) == ""

    def test_the_composed_resolver_skips_a_disabled_registry(self, registry):
        _, asked = registry
        resolve = make_registry_resolver(enable_npm=False, enable_pypi=False)

        assert resolve(a_dep("a", "npm", declared_license="MIT")) == "MIT"
        assert resolve(a_dep("b", "pypi")) is None
        assert asked == []

    def test_the_composed_resolver_falls_back_when_pypi_has_nothing(self, registry):
        answers, _ = registry
        answers["https://pypi.org/pypi/flask/json"] = {"info": {}}
        resolve = make_registry_resolver(fallback=lambda dep: "from-fallback")

        assert resolve(a_dep("flask", "pypi")) == "from-fallback"
