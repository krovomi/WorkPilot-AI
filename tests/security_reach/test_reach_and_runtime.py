"""Reach, dependencies and production use of a scan's findings (issue #364).

The fixture project mixes languages on purpose: the analysis reads text, and
must rank a Python route, a TypeScript handler, a Go binary and a C#
controller the same way.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from security.finding_priority import Reach
from security.vulnerability_scanner import Severity, Vulnerability, VulnerabilitySource
from security_reach import NO_ENTRY_NOTE, RUNTIME_OFF_NOTE, TRUNCATED_NOTE, evidence_for
from security_reach import sources as sources_module
from security_reach.dependencies import (
    declared_packages,
    dependency_name,
    is_imported,
    normalize,
)
from security_reach.graph import build_graph
from security_reach.runtime import read_runtime
from security_reach.sources import Sources, is_test_path, read_sources

FILES = {
    # Python: a route reaches the service it imports, not the legacy module.
    "api/app.py": "from api.services import billing\nimport requests\n"
    "@app.post('/pay')\ndef pay():\n    return billing.charge()\n",
    "api/services/billing.py": "import yaml\nfrom .tax import rate\ndef charge(): ...\n",
    "api/services/tax.py": "rate = 1\n",
    "api/legacy/old_report.py": "import requests\ndef run(): ...\n",
    # TypeScript: a Lambda handler reaches its util through a relative path.
    "web/src/lambda.ts": "import { clean } from './util/sanitize';\n"
    "export async function handler(event) { return clean(event); }\n",
    "web/src/util/sanitize.ts": "import lodash from 'lodash';\nexport const clean = (x) => x;\n",
    "web/src/unused/widget.ts": "export const w = 1;\n",
    # Go: main reaches its whole package folder.
    "cmd/tool/main.go": 'package main\nimport "fmt"\nfunc main() { fmt.Println(Helper()) }\n',
    "cmd/tool/helper.go": 'package main\nfunc Helper() string { return "" }\n',
    # C#: a controller reaches the class it names, without an import.
    "Shop/Controllers/OrdersController.cs": "[ApiController]\npublic class OrdersController {\n"
    "  private readonly OrderStore _store = new OrderStore();\n}\n",
    "Shop/Data/OrderStore.cs": "public class OrderStore { }\n",
    "Shop/Legacy/Unused.cs": "public class Unused { }\n",
    # Tests are never entry points and never reached.
    "tests/test_billing.py": "from api.services import billing\nimport pytest\n",
    "web/src/util/sanitize.test.ts": "import { clean } from './sanitize';\n",
    # Ignored folders.
    "node_modules/lodash/index.js": "module.exports = {};\n",
    "build/out.py": "x = 1\n",
    "notes.txt": "not code\n",
}
MANIFESTS = {
    "package.json": json.dumps(
        {"dependencies": {"lodash": "^4"}, "devDependencies": {"@types/node": "*"}}
    ),
    "requirements.txt": "requests==2.31\nPyYAML>=6  # import yaml\n\n# comment\n",
}


def _write(root: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    _write(root, {**FILES, **MANIFESTS})
    return root


def _vuln(
    file=None,
    dependency=None,
    severity=Severity.HIGH,
    source=VulnerabilitySource.BANDIT,
):
    return Vulnerability(
        id="V",
        severity=severity,
        source=source,
        title="t",
        description="d",
        file=file,
        dependency=dependency,
    )


def _incident(root: Path, name: str, payload: dict, age_days: float = 0) -> Path:
    inbox = root / ".workpilot" / "incidents"
    inbox.mkdir(parents=True, exist_ok=True)
    path = inbox / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    when = time.time() - age_days * 86_400
    os.utime(path, (when, when))
    return path


def _sentry(*filenames: str, **extra) -> dict:
    frames = [{"filename": name, "lineno": 3} for name in filenames]
    return {
        "event": {"exception": {"values": [{"stacktrace": {"frames": frames}}]}},
        **extra,
    }


# ── sources ─────────────────────────────────────────────────────────────


def test_the_walk_reads_code_and_manifests_and_skips_the_rest(project):
    sources = read_sources(project)
    assert "api/app.py" in sources.files and "cmd/tool/main.go" in sources.files
    assert not any(rel.startswith(("node_modules/", "build/")) for rel in sources.files)
    assert "notes.txt" not in sources.files
    assert set(sources.manifests) == {"package.json", "requirements.txt"}
    assert not sources.truncated


def test_the_walk_follows_no_link_and_skips_large_files(project, monkeypatch, tmp_path):
    outside = tmp_path / "outside.py"
    outside.write_text("secret = 1\n", encoding="utf-8")
    try:
        (project / "api" / "link.py").symlink_to(outside)
    except OSError:
        pytest.skip("this system cannot create a symbolic link")
    monkeypatch.setattr(sources_module, "MAX_FILE_BYTES", 30)
    files = read_sources(project).files
    assert "api/link.py" not in files
    assert "api/app.py" not in files  # larger than the bound
    assert "api/services/tax.py" in files


def test_the_walk_stops_at_its_bound(project, monkeypatch):
    monkeypatch.setattr(sources_module, "MAX_FILES", 3)
    sources = read_sources(project)
    assert sources.truncated and len(sources.files) + len(sources.manifests) == 3


def test_an_unreadable_file_is_passed_over(project, monkeypatch):
    real = Path.read_text

    def refuse(self, *args, **kwargs):
        if self.name == "tax.py":
            raise OSError("denied")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", refuse)
    assert "api/services/tax.py" not in read_sources(project).files


@pytest.mark.parametrize(
    ("rel", "expected"),
    [
        ("tests/test_x.py", True),
        ("src/__tests__/a.ts", True),
        ("pkg/x_test.go", True),
        ("src/a.spec.tsx", True),
        ("Shop.Tests/OrderTests.cs", True),
        ("spec/models/user_spec.rb", True),
        ("src/contest.py", False),
        ("src/app.ts", False),
    ],
)
def test_test_code_is_recognised_in_every_language(rel, expected):
    assert is_test_path(rel) is expected


# ── reach graph ─────────────────────────────────────────────────────────


def test_entry_points_reach_what_they_import_name_or_share_a_package_with(project):
    graph = build_graph(read_sources(project))
    assert {"api/app.py", "web/src/lambda.ts", "cmd/tool/main.go"} <= graph.entries
    assert "Shop/Controllers/OrdersController.cs" in graph.entries
    assert {
        "api/services/billing.py",
        "api/services/tax.py",
        "web/src/util/sanitize.ts",
        "cmd/tool/helper.go",
        "Shop/Data/OrderStore.cs",
    } <= graph.reached
    unreached = {
        "api/legacy/old_report.py",
        "web/src/unused/widget.ts",
        "Shop/Legacy/Unused.cs",
    }
    assert not unreached & graph.reached
    assert {"tests/test_billing.py", "web/src/util/sanitize.test.ts"} == graph.tests
    assert not graph.tests & graph.reached
    assert not graph.dynamic


def test_a_manifest_names_entry_points_by_file_and_by_module():
    sources = Sources(
        files={
            "src/serve.js": "x()\n",
            "pkg/jobs/run.py": "x = 1\n",
            "pkg/cli/__main__.py": "x = 1\n",
            "other.js": "y()\n",
        },
        manifests={
            "package.json": '{"scripts": {"start": "node ./src/serve.js"}}',
            "pyproject.toml": '[project.scripts]\nrun = "pkg.jobs.run:main"\ncli = "cli:go"\n',
        },
    )
    assert build_graph(sources).entries == {
        "src/serve.js",
        "pkg/jobs/run.py",
        "pkg/cli/__main__.py",
    }


@pytest.mark.parametrize(
    "text",
    [
        "m = importlib.import_module(name)\n",
        "fn = eval(code)\n",
        "exec(code)\n",
        "const m = require(name);\n",
        "Type t = Type.GetType(name);\n",
    ],
)
def test_code_loaded_by_name_makes_reach_uncertain(text):
    sources = Sources(files={"main.py": text, "lonely.py": "x = 1\n"})
    graph = build_graph(sources)
    assert graph.dynamic and "lonely.py" not in graph.reached


def test_a_word_ending_in_eval_is_not_code_loaded_by_name():
    sources = Sources(files={"main.py": "retrieval(x)\nself.exec(y)\n"})
    assert not build_graph(sources).dynamic


# ── dependencies ────────────────────────────────────────────────────────


def test_dependency_names_are_read_from_each_scanner_and_normalized():
    assert dependency_name("requests==2.0") == "requests"
    assert dependency_name("lodash@<4.17.21") == "lodash"
    assert dependency_name("@babel/core@^7") == "@babel/core"
    assert dependency_name("plain") == "plain"
    assert dependency_name(None) == dependency_name("  ") == ""
    assert normalize("Py_YAML.Ext") == "py-yaml-ext"


def test_every_ecosystem_declares_its_packages():
    manifests = {
        "package.json": '{"dependencies": {"a-js": "1"}, "require": {"b/php": "1"}, "x": 1}',
        "composer.json": "[1, 2]",
        "broken.json": "{",
        "pyproject.toml": "\n".join(
            [
                '[project]\ndependencies = ["c-py>=1", "!bad"]',
                '[project.optional-dependencies]\ndev = ["d-py"]',
                '[dependency-groups]\ntest = ["e-py"]',
                '[tool.poetry.dependencies]\nf-py = "*"',
                "[dependencies]\ng-rs = '1'",
            ]
        ),
        "bad.toml": "[[",
        "Cargo.toml": 'project = "not a table"\ntool = "nor this"\n',
        "requirements-dev.txt": "h-py[extra]==1\n-r base.txt\n",
        "go.mod": "module x\nrequire (\n\tgithub.com/i/go v1.2.0\n)\nrequire golang.org/x/j v0.1.0\n",
        "Gemfile": "gem 'k-rb'\n",
        "Api.csproj": '<PackageReference Include="L.Net" Version="1" />',
        "pom.xml": "<artifactId>m-java</artifactId>",
        "build.gradle": "implementation 'org.n:n-kt:1.0'",
        "Procfile": "web: run",
    }
    assert declared_packages(manifests) == {
        "a-js",
        "b/php",
        "c-py",
        "d-py",
        "e-py",
        "f-py",
        "g-rs",
        "h-py",
        "github-com/i/go",
        "golang-org/x/j",
        "k-rb",
        "l-net",
        "m-java",
        "n-kt",
    }


def test_a_package_is_imported_only_when_its_name_is():
    assert is_imported("lodash", "import lodash from 'lodash';")
    assert is_imported("python-dateutil", "from python_dateutil import x")
    assert is_imported("@babel/core", "require('@babel/core')")
    assert not is_imported("dash", "import plotly_dash")
    assert not is_imported("core", "require('@babel/core')")


# ── runtime ─────────────────────────────────────────────────────────────


def test_recent_incidents_name_the_files_and_packages_that_ran(project):
    files = set(read_sources(project).files)
    _incident(
        project,
        "a.json",
        _sentry(
            "/srv/app/api/services/billing.py",
            "C:\\deploy\\web\\src\\util\\sanitize.ts",
            "/srv/app/node_modules/lodash/index.js",
            "/usr/lib/python3/site-packages/requests/api.py",
            "/gems/rack-2.2.3/lib/rack.rb",
            "",
            data={"issue": {"userCount": 12}},
        ),
    )
    _incident(
        project, "b.json", _sentry("/srv/app/api/services/billing.py", userCount=3)
    )
    _incident(
        project, "c.json", {"stacktrace": 'File "/srv/app/api/app.py", line 4, in pay'}
    )
    _incident(
        project, "old.json", _sentry("/srv/app/api/legacy/old_report.py"), age_days=40
    )
    runtime = read_runtime(project, files)
    assert runtime.available and runtime.incidents == 3
    assert runtime.file_hits == {
        "api/services/billing.py": 2,
        "web/src/util/sanitize.ts": 1,
        "api/app.py": 1,
    }
    assert runtime.file_users["api/services/billing.py"] == 12
    assert runtime.package_hits == {"lodash": 1, "requests": 1, "rack": 1}
    assert runtime.package_users["lodash"] == 12


@pytest.mark.parametrize(
    "payload",
    [
        {"userCount": True},
        {"userCount": -4},
        {"data": "y", "issue": {"affected_users": 0}},
    ],
)
def test_a_user_count_that_is_not_a_count_is_none(project, payload):
    _incident(project, "a.json", {**_sentry("/x/api/app.py"), **payload})
    assert read_runtime(project, {"api/app.py"}).file_users["api/app.py"] == 0


def test_payloads_that_cannot_be_read_are_passed_over(project, monkeypatch):
    from security_reach import runtime as runtime_module

    _incident(project, "list.json", [1, 2])
    (project / ".workpilot" / "incidents" / "broken.json").write_text(
        "{", encoding="utf-8"
    )
    _incident(project, "big.json", {"title": "x" * 400})
    _incident(project, "bad.json", {"event": {"exception": {"values": "nope"}}})
    monkeypatch.setattr(runtime_module, "MAX_PAYLOAD_BYTES", 300)
    runtime = read_runtime(project, set())
    assert not runtime.available and runtime.incidents == 0


def test_an_inbox_that_is_a_link_or_leads_outside_is_not_read(project, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "a.json").write_text(
        json.dumps(_sentry("/x/api/app.py")), encoding="utf-8"
    )
    (project / ".workpilot").mkdir()
    try:
        (project / ".workpilot" / "incidents").symlink_to(
            elsewhere, target_is_directory=True
        )
    except OSError:
        pytest.skip("this system cannot create a symbolic link")
    assert not read_runtime(project, {"api/app.py"}).available

    (project / ".workpilot" / "incidents").unlink()
    (project / ".workpilot").rmdir()
    (project / ".workpilot").symlink_to(tmp_path, target_is_directory=True)
    (tmp_path / "incidents").mkdir()
    (tmp_path / "incidents" / "a.json").write_text("{}", encoding="utf-8")
    assert not read_runtime(project, {"api/app.py"}).available


def test_an_incident_file_that_vanishes_is_passed_over(project, monkeypatch):
    path = _incident(project, "a.json", _sentry("/x/api/app.py"))
    real = Path.stat
    calls = []

    def gone(self, *args, **kwargs):
        # The listing still sees the file; it is gone when it is read.
        if self == path and not kwargs:
            calls.append(1)
            if len(calls) > 1:
                raise OSError("gone")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", gone)
    assert read_runtime(project, {"api/app.py"}).incidents == 0


# ── evidence for a scan ─────────────────────────────────────────────────


def test_each_finding_gets_its_evidence(project):
    _incident(
        project, "a.json", _sentry("/srv/api/app.py", "/srv/node_modules/lodash/x.js")
    )
    findings = [
        _vuln(file="api/app.py"),
        _vuln(file=str(project / "api" / "legacy" / "old_report.py")),
        _vuln(file="./tests/test_billing.py"),
        _vuln(file="config/settings.yaml"),
        _vuln(file="spec/fixtures/key.yaml"),
        _vuln(file="/elsewhere/app.py"),
        _vuln(),
        _vuln(dependency="lodash@<4"),
        _vuln(dependency="requests==2.0"),
        _vuln(dependency="PyYAML==5"),
        _vuln(dependency="minimist@<1"),
    ]
    context = evidence_for(project, findings)
    assert context.runtime_available and context.entry_points >= 4
    assert context.notes == []
    reach = [e.reach for e in context.evidence]
    assert reach == [
        Reach.REACHED,
        Reach.UNREACHED,
        Reach.TEST,
        Reach.UNKNOWN,
        Reach.TEST,
        Reach.UNKNOWN,
        Reach.UNKNOWN,
        Reach.REACHED,
        Reach.REACHED,
        Reach.UNCERTAIN,  # declared, imported as ``yaml``
        Reach.UNCERTAIN,  # not declared: transitive
    ]
    assert context.evidence[0].runtime_hits == 1
    assert context.evidence[7].runtime_hits == 1
    assert context.evidence[10].transitive and not context.evidence[9].transitive


def test_dependencies_only_imported_by_unreached_or_test_code(tmp_path):
    root = tmp_path / "p"
    _write(
        root,
        {
            "main.py": "print(1)\n",
            "legacy.py": "import requests\n",
            "tests/test_x.py": "import pytest\n",
            "requirements.txt": "requests\npytest\n",
        },
    )
    context = evidence_for(
        root, [_vuln(dependency="requests==1"), _vuln(dependency="pytest==1")]
    )
    assert [e.reach for e in context.evidence] == [Reach.UNREACHED, Reach.TEST]
    assert context.notes == [RUNTIME_OFF_NOTE]

    (root / "main.py").write_text("exec(code)\n", encoding="utf-8")
    evidence = evidence_for(
        root, [_vuln(dependency="requests==1"), _vuln(file="legacy.py")]
    )
    assert [(e.reach, e.dynamic) for e in evidence.evidence] == [
        (Reach.UNCERTAIN, True),
        (Reach.UNCERTAIN, True),
    ]


def test_without_an_entry_point_nothing_is_moved_down(tmp_path, monkeypatch):
    root = tmp_path / "lib"
    _write(root, {"lib/util.py": "import requests\n", "requirements.txt": "requests\n"})
    context = evidence_for(
        root, [_vuln(file="lib/util.py"), _vuln(dependency="requests==1")]
    )
    assert [e.reach for e in context.evidence] == [Reach.UNKNOWN, Reach.UNKNOWN]
    assert NO_ENTRY_NOTE in context.notes

    monkeypatch.setattr(sources_module, "MAX_FILES", 1)
    assert TRUNCATED_NOTE in evidence_for(root, []).notes
