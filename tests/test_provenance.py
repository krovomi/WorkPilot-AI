"""The provenance dossier of a task's pull request (prospective P5).

Each test pins a rule:

* every ecosystem the dependency guard reads gets a package URL, and none is
  invented for one it does not;
* the SBOM lists exactly the packages the diff adds against the merge base,
  without a version, since manifests declare none;
* a part whose source is absent is recorded as absent, never guessed, and the
  dossier carries no code;
* the dossier is kept in the spec copy that survives the merge, never through
  a link; the gates' report is the build's, round-tripped as written;
* the PR block and the compliance sources say the same thing as the dossier.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

import agent_trace  # noqa: E402
from compliance_collector import (  # noqa: E402
    ComplianceFramework,
    EvidenceCollector,
    EvidenceType,
)
from provenance import (  # noqa: E402
    DOSSIER_DIR,
    DOSSIER_FILE,
    SBOM_FILE,
    build_dossier,
    evidence_sources,
    pr_block,
    purl,
    write_dossier,
)
from workflows.hard_gates import (  # noqa: E402
    HardGateReport,
    HardGateResult,
    load_gate_record,
    write_gate_record,
)

CODE_LINE = "const marker = 'never-in-a-dossier';"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(  # noqa: S603 - fixed argv
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


@pytest.fixture
def task(tmp_path, monkeypatch):
    monkeypatch.delenv("DEFAULT_BRANCH", raising=False)
    root = tmp_path / "project"
    root.mkdir()
    _git(root, "init", "-q", "-b", "develop")
    (root / ".gitignore").write_text(".workpilot/\n", encoding="utf-8")
    (root / "package.json").write_text(
        json.dumps({"dependencies": {"left-pad": "1.0.0"}}), encoding="utf-8"
    )
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "base")
    base = _git(root, "rev-parse", "HEAD")
    _git(root, "checkout", "-q", "-b", "task")
    (root / "package.json").write_text(
        json.dumps(
            {"dependencies": {"left-pad": "1.0.0", "lodash": "^4", "@scope/ui": "2"}}
        ),
        encoding="utf-8",
    )
    (root / "requirements.txt").write_text("Requests_Toolbelt==1.0\n", encoding="utf-8")
    (root / "app.js").write_text(CODE_LINE + "\n", encoding="utf-8")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "task")
    spec = root / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    return root, spec, base


class TestPurl:
    @pytest.mark.parametrize(
        ("ecosystem", "name", "expected"),
        [
            ("npm", "lodash", "pkg:npm/lodash"),
            ("npm", "@scope/ui", "pkg:npm/%40scope/ui"),
            ("pypi", "Requests_Toolbelt", "pkg:pypi/requests-toolbelt"),
            ("nuget", "Newtonsoft.Json", "pkg:nuget/Newtonsoft.Json"),
            ("maven", "org.slf4j:slf4j-api", "pkg:maven/org.slf4j/slf4j-api"),
            ("cargo", "serde", "pkg:cargo/serde"),
            ("go", "github.com/pkg/errors", "pkg:golang/github.com/pkg/errors"),
            ("packagist", "monolog/monolog", "pkg:composer/monolog/monolog"),
            ("pub", "http", "pkg:pub/http"),
            ("rubygems", "rails", "pkg:gem/rails"),
        ],
    )
    def test_every_ecosystem_of_the_guard(self, ecosystem, name, expected):
        assert purl(ecosystem, name) == expected

    def test_none_for_what_it_cannot_name(self):
        assert purl("conda", "numpy") is None
        assert purl("maven", "no-group") is None
        assert purl("npm", "") is None


class TestDossier:
    def test_sbom_lists_what_the_diff_adds(self, task):
        root, spec, base = task
        dossier = build_dossier(root, [spec])
        assert dossier["base"] == base
        assert dossier["head"] == _git(root, "rev-parse", "HEAD")
        sbom = dossier["sbom"]
        assert sbom["bomFormat"] == "CycloneDX" and sbom["specVersion"] == "1.6"
        purls = sorted(c["purl"] for c in sbom["components"])
        assert purls == [
            "pkg:npm/%40scope/ui",
            "pkg:npm/lodash",
            "pkg:pypi/requests-toolbelt",
        ]
        assert all("version" not in c for c in sbom["components"])

    def test_absent_sources_are_absent(self, task):
        root, spec, _base = task
        dossier = build_dossier(root, [spec])
        for part in ("attribution", "dependencies", "gates", "verification"):
            assert dossier[part] is None
        block = pr_block(dossier)
        assert "no Agent Trace record" in block
        assert "dependency guard did not run" in block
        assert "**Gates**: not recorded" in block
        assert CODE_LINE not in json.dumps(dossier)

    def test_reads_each_source_from_the_first_copy_that_has_it(self, task, monkeypatch):
        root, spec, _base = task
        kept = root / "kept-spec"
        (kept / "verify").mkdir(parents=True)
        (spec / "dependency_guard.json").write_text(
            json.dumps(
                {
                    "base": "",
                    "status": "pass",
                    "findings": [
                        {
                            "ecosystem": "npm",
                            "name": "lodash",
                            "manifest": "package.json",
                            "verdict": "ok",
                            "reason": "found",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        (kept / "verify" / "verify.json").write_text(
            json.dumps({"status": "pass", "score": 92}), encoding="utf-8"
        )
        write_gate_record(
            kept,
            HardGateReport(
                [
                    HardGateResult("verify", "tests-pass", True),
                    HardGateResult("qa", "deps-exist", None, "unknown — offline"),
                ]
            ),
        )
        monkeypatch.setattr(
            agent_trace,
            "summarize",
            lambda project, spec_dir: (
                {
                    "base": "",
                    "files": {"app.js": {}},
                    "totals": {"added": 10, "ai": 8, "human": 1, "unknown": 1},
                    "models": {"anthropic/claude-sonnet-5-5": 8},
                }
                if spec_dir == spec
                else None
            ),
        )
        dossier = build_dossier(root, [spec, kept])
        assert dossier["dependencies"]["status"] == "pass"
        assert dossier["verification"] == {"status": "pass", "reason": "", "score": 92}
        assert [(r["gate"], r["held"]) for r in dossier["gates"]["results"]] == [
            ("tests-pass", True),
            ("deps-exist", None),
        ]
        block = pr_block(dossier)
        assert "80 % of the 10 added lines" in block
        assert "`anthropic/claude-sonnet-5-5`" in block
        assert "✓ tests-pass, ? deps-exist" in block
        assert "guard verdict `pass`" in block

        sources = evidence_sources(dossier)
        assert set(sources) == {
            EvidenceType.CHANGE_LOG,
            EvidenceType.CODE_REVIEW,
            EvidenceType.SECURITY_SCAN,
            EvidenceType.TEST_RESULTS,
        }
        report = EvidenceCollector().collect(ComplianceFramework.SOC2, sources)
        assert report.coverage > 0

    def test_written_where_it_survives_the_merge_never_through_a_link(
        self, task, tmp_path
    ):
        root, spec, _base = task
        kept = tmp_path / "kept"
        kept.mkdir()
        assert write_dossier(root, [spec], kept) is not None
        folder = kept / DOSSIER_DIR
        assert {p.name for p in folder.iterdir()} == {
            DOSSIER_FILE,
            SBOM_FILE,
            "dossier.md",
        }
        assert not (spec / DOSSIER_DIR).exists()
        assert CODE_LINE not in (folder / "dossier.md").read_text(encoding="utf-8")

        linked = tmp_path / "linked"
        linked.mkdir()
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        (linked / DOSSIER_DIR).symlink_to(elsewhere, target_is_directory=True)
        assert write_dossier(root, [spec], linked) is None
        assert list(elsewhere.iterdir()) == []

    def test_nothing_to_say_no_block(self):
        assert pr_block(None) == ""
        assert pr_block({"attribution": None, "sbom": None}) == ""


def test_gate_record_round_trips(tmp_path):
    report = HardGateReport([HardGateResult("verify", "app-verified", False, "fail")])
    write_gate_record(tmp_path, report)
    record = load_gate_record(tmp_path)
    assert record["blocking"] is True
    assert record["results"] == [
        {
            "phase_id": "verify",
            "gate": "app-verified",
            "held": False,
            "detail": "fail",
        }
    ]
    assert load_gate_record(tmp_path / "missing") is None


def test_the_compliance_scan_reads_the_dossiers(task):
    root, spec, _base = task
    sys.path.insert(0, str(REPO_ROOT / "apps" / "backend" / "runners"))
    import compliance_runner

    assert write_dossier(root, [spec]) is not None
    broken = root / ".workpilot" / "specs" / "002-y" / DOSSIER_DIR
    broken.mkdir(parents=True)
    (broken / DOSSIER_FILE).write_text(
        json.dumps({"attribution": {"totals": None}}), encoding="utf-8"
    )
    sources = compliance_runner._collect_sources(root)
    change_log = sources[EvidenceType.CHANGE_LOG]
    assert any(item["source"] == f"provenance/{DOSSIER_FILE}" for item in change_log)
    assert any(
        "SBOM of the diff: 3 component(s)" in item["description"]
        for item in sources[EvidenceType.SECURITY_SCAN]
    )
