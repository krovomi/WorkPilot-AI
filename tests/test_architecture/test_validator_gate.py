"""The architecture gate the QA loop runs (`architecture/validator.py`), and its
optional AI reviewer (`architecture/ai_reviewer.py`).

The project is a real git repository; the reviewer's model is a stand-in
runtime installed through the `agent_runtime` port, which writes the report a
real reviewer would write.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path

import agent_runtime
import pytest
from architecture import ai_reviewer, validator
from architecture.config import infer_architecture_config, load_architecture_config
from architecture.models import (
    ArchitectureConfig,
    ArchitectureReport,
    ArchitectureViolation,
    BoundedContextConfig,
    ForbiddenPattern,
    LayerConfig,
    RulesConfig,
)
from security.content_sanitizer import ContentSanitizer

RULES = {
    "architecture_style": "layered",
    "layers": [
        {"name": "domain", "patterns": ["domain/**"], "forbidden_imports": ["infra"]},
        {"name": "infra", "patterns": ["infra/**"], "allowed_imports": ["domain"]},
    ],
    "ai_review": False,
}


def _git(repo: Path, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME="t",
        GIT_AUTHOR_EMAIL="t@example.com",
        GIT_COMMITTER_NAME="t",
        GIT_COMMITTER_EMAIL="t@example.com",
    )
    return subprocess.run(
        ["git", *args], cwd=repo, env=env, check=True, capture_output=True, text=True
    ).stdout


def _project(tmp_path: Path, rules: dict | None = RULES) -> tuple[Path, Path]:
    repo = tmp_path / "shop"
    (repo / "domain").mkdir(parents=True)
    (repo / "infra").mkdir()
    (repo / "domain" / "__init__.py").write_text("", encoding="utf-8")
    (repo / "infra" / "__init__.py").write_text("", encoding="utf-8")
    (repo / "infra" / "db.py").write_text("CONNECTION = 1\n", encoding="utf-8")
    if rules is not None:
        (repo / ".workpilot").mkdir()
        (repo / ".workpilot" / "architecture_rules.json").write_text(
            json.dumps(rules), encoding="utf-8"
        )
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "base")
    _git(repo, "checkout", "-q", "-b", "task")
    spec_dir = repo / ".workpilot" / "specs" / "001-orders"
    spec_dir.mkdir(parents=True)
    (spec_dir / "task_metadata.json").write_text(
        json.dumps({"baseBranch": "main"}), encoding="utf-8"
    )
    return repo, spec_dir


def _commit(repo: Path, path: str, text: str) -> None:
    (repo / path).write_text(text, encoding="utf-8")
    _git(repo, "add", path)
    _git(repo, "commit", "-q", "-m", f"change {path}")


def _run(repo: Path, spec_dir: Path, verbose: bool = False):
    return asyncio.run(
        validator.run_architecture_validation(repo, spec_dir, "model-x", verbose)
    )


# --- the deterministic gate --------------------------------------------------


def test_a_domain_file_importing_infra_fails_the_gate(tmp_path, capsys):
    repo, spec_dir = _project(tmp_path)
    _commit(repo, "domain/orders.py", "from infra.db import CONNECTION\n")

    passed, report = _run(repo, spec_dir, verbose=True)

    assert passed is False
    assert [v["file"] for v in report["violations"]] == ["domain/orders.py"]
    assert report["violations"][0]["type"] == "layer_violation"
    assert "layer_violation" in capsys.readouterr().out


def test_a_clean_change_passes(tmp_path):
    repo, spec_dir = _project(tmp_path)
    _commit(repo, "infra/repo.py", "from domain import orders\n")

    passed, report = _run(repo, spec_dir)

    assert passed is True
    assert report["violations"] == []


def test_without_any_rule_the_gate_is_skipped(tmp_path):
    repo = tmp_path / "empty"
    repo.mkdir()
    _git(repo, "init", "-q")

    passed, report = _run(repo, repo / "spec")

    assert passed is True
    assert report["config_source"] == "none"


def test_outside_a_git_repository_every_file_is_analyzed(tmp_path):
    repo = tmp_path / "plain"
    (repo / "domain").mkdir(parents=True)
    (repo / "infra").mkdir()
    (repo / "domain" / "orders.py").write_text("import infra.db\n", encoding="utf-8")
    (repo / "infra" / "db.py").write_text("X = 1\n", encoding="utf-8")
    (repo / ".workpilot").mkdir()
    (repo / ".workpilot" / "architecture_rules.json").write_text(
        json.dumps(RULES), encoding="utf-8"
    )

    assert validator._get_changed_files(repo, repo / "spec") is None
    passed, report = _run(repo, repo / "spec")

    assert passed is False
    assert report["violations"][0]["file"] == "domain/orders.py"


def test_a_slow_git_falls_back_to_analyzing_everything(tmp_path, monkeypatch):
    def slow(*_a, **_k):
        raise subprocess.TimeoutExpired("git", 10)

    monkeypatch.setattr(validator.subprocess, "run", slow)

    assert validator._get_changed_files(tmp_path, tmp_path) is None


def test_the_base_branch_comes_from_the_task(tmp_path):
    repo, spec_dir = _project(tmp_path)
    (spec_dir / "task_metadata.json").write_text(
        json.dumps({"baseBranch": "develop"}), encoding="utf-8"
    )

    assert validator._detect_base_branch(spec_dir, repo) == "develop"


@pytest.mark.parametrize("content", ["[1, 2]", '"rules"', "{broken"])
def test_a_rules_file_that_is_not_an_object_is_ignored(tmp_path, content):
    (tmp_path / ".workpilot").mkdir()
    (tmp_path / ".workpilot" / "architecture_rules.json").write_text(
        content, encoding="utf-8"
    )

    assert load_architecture_config(tmp_path) is None


# --- the AI reviewer ------------------------------------------------------------


class StandInRuntime:
    """Writes what a reviewer would write; records what it was asked."""

    def __init__(self, findings=None, *, fail_create=False, fail_run=False):
        self.findings = findings
        self.fail_create = fail_create
        self.fail_run = fail_run
        self.prompts: list[str] = []
        self.clients: list[dict] = []

    def create_agent_client(self, **kwargs):
        if self.fail_create:
            raise RuntimeError("no provider")
        self.clients.append(kwargs)
        return _Session()

    async def run_agent_session(self, client, message, spec_dir, **kwargs):
        self.prompts.append(message)
        if self.fail_run:
            raise RuntimeError("session died")
        if self.findings is not None:
            (Path(spec_dir) / ai_reviewer.REPORT_FILE).write_text(
                json.dumps(self.findings), encoding="utf-8"
            )
        return "complete", "", {}


class _Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


@pytest.fixture
def runtime(monkeypatch):
    def install(stand_in):
        monkeypatch.setattr(agent_runtime, "_runtime", stand_in)
        return stand_in

    return install


def _ai_rules(repo: Path) -> None:
    rules = dict(RULES, ai_review=True)
    (repo / ".workpilot" / "architecture_rules.json").write_text(
        json.dumps(rules), encoding="utf-8"
    )


def test_an_ai_error_fails_a_change_the_rules_let_through(tmp_path, runtime):
    repo, spec_dir = _project(tmp_path)
    _ai_rules(repo)
    _commit(repo, "infra/repo.py", "from domain import orders\n")
    stand_in = runtime(
        StandInRuntime(
            {
                "ai_violations": [
                    {"type": "leak", "severity": "error", "file": "infra/repo.py"},
                    {"severity": "critical", "file": "infra/x.py"},
                    {"severity": "warning", "description": "naming"},
                    "not a finding",
                ]
            }
        )
    )

    passed, report = _run(repo, spec_dir)

    assert passed is False
    assert [v["type"] for v in report["violations"]] == ["leak"]
    # An unknown severity shows as a warning instead of disappearing.
    assert sorted(w["file"] for w in report["warnings"]) == ["", "infra/x.py"]
    assert "AI review found 1 additional error(s)" in report["summary"]
    assert stand_in.clients[0]["agent_type"] == "architecture_reviewer"


def test_the_rules_reach_the_reviewer_as_quoted_data(tmp_path, runtime):
    repo, spec_dir = _project(tmp_path)
    _ai_rules(repo)
    stand_in = runtime(StandInRuntime({"ai_violations": []}))

    passed, _ = _run(repo, spec_dir)

    assert passed is True
    prompt = stand_in.prompts[0]
    rules_at = prompt.index("Architecture Style: layered")
    assert prompt.rfind(ContentSanitizer.USER_CONTENT_START, 0, rules_at) != -1
    assert str(spec_dir) in prompt and "main" in prompt


def test_a_report_from_an_earlier_round_is_not_read_again(tmp_path, runtime):
    repo, spec_dir = _project(tmp_path)
    _ai_rules(repo)
    (spec_dir / ai_reviewer.REPORT_FILE).write_text(
        json.dumps({"ai_violations": [{"severity": "error", "file": "old.py"}]}),
        encoding="utf-8",
    )
    runtime(StandInRuntime(findings=None))  # this round writes nothing

    passed, report = _run(repo, spec_dir)

    assert passed is True
    assert report["violations"] == []


@pytest.mark.parametrize(
    "stand_in",
    [None, StandInRuntime(fail_create=True), StandInRuntime(fail_run=True)],
    ids=["no-runtime", "no-client", "session-fails"],
)
def test_a_reviewer_that_cannot_run_does_not_block(tmp_path, runtime, stand_in):
    repo, spec_dir = _project(tmp_path)
    _ai_rules(repo)
    runtime(stand_in)

    passed, report = _run(repo, spec_dir)

    assert passed is True
    assert report["violations"] == []


def test_a_crashing_reviewer_is_reported_as_a_warning(tmp_path, monkeypatch):
    repo, spec_dir = _project(tmp_path)
    _ai_rules(repo)

    async def crash(**_kwargs):
        raise ValueError("bad config")

    monkeypatch.setattr(ai_reviewer, "run_architecture_ai_review", crash)

    passed, report = _run(repo, spec_dir)

    assert passed is True
    assert report["warnings"][-1]["type"] == "ai_review_error"
    assert "bad config" in report["warnings"][-1]["description"]


@pytest.mark.parametrize("content", ["{broken", "[]", '{"ai_violations": "x"}'])
def test_an_unreadable_ai_report_has_no_finding(tmp_path, content):
    (tmp_path / ai_reviewer.REPORT_FILE).write_text(content, encoding="utf-8")

    assert ai_reviewer._parse_ai_report(tmp_path) == []


def test_the_rules_are_written_out_for_the_reviewer():
    config = ArchitectureConfig(
        layers=[
            LayerConfig(
                "domain", ["domain/**"], allowed_imports=["x"], forbidden_imports=["y"]
            )
        ],
        bounded_contexts=[
            BoundedContextConfig("billing", ["billing/**"], ["shared"]),
        ],
        rules=RulesConfig(
            forbidden_patterns=[ForbiddenPattern("ui/**", "sql", "No SQL in UI")]
        ),
    )

    text = ai_reviewer._serialize_config(config)

    for expected in (
        "Allowed imports from: x",
        "Forbidden imports from: y",
        "Bounded Contexts:",
        "Allowed cross-context: shared",
        "Import: sql",
        "Reason: No SQL in UI",
    ):
        assert expected in text


def test_the_static_report_is_summarized_for_the_reviewer():
    clean = ArchitectureReport(passed=True)
    assert "No violations" in ai_reviewer._serialize_deterministic_report(clean)

    warned = ArchitectureReport(
        passed=True,
        summary="12 warnings",
        warnings=[
            ArchitectureViolation("drift", "warning", f"f{i}.py", description="d")
            for i in range(12)
        ],
    )
    text = ai_reviewer._serialize_deterministic_report(warned)
    assert "[drift] f9.py: d" in text and "f10.py" not in text
    assert "... and 2 more warnings" in text


# --- the fix request ------------------------------------------------------------


def test_violations_are_appended_to_the_fix_request(tmp_path):
    (tmp_path / "QA_FIX_REQUEST.md").write_text("# Earlier request", encoding="utf-8")
    report = {
        "violations": [
            {
                "type": "layer_violation",
                "severity": "error",
                "file": "domain/orders.py",
                "line": 3,
                "import_target": "infra.db",
                "rule": "domain -> infra",
                "description": "Domain imports infrastructure.",
                "suggestion": "Use a port.",
            },
            {"description": "No file"},
        ]
    }

    validator.write_architecture_fix_request(tmp_path, report)

    text = (tmp_path / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert text.startswith("# Earlier request\n\n# Architecture Violation Fix Request")
    assert "**File:** `domain/orders.py` (line 3)" in text
    assert "**Import:** `infra.db`" in text
    assert "**Suggestion:** Use a port." in text
    assert "### 2. unknown (error)" in text


def test_no_violation_writes_nothing(tmp_path):
    validator.write_architecture_fix_request(tmp_path, {"violations": []})

    assert not (tmp_path / "QA_FIX_REQUEST.md").exists()


def test_a_fix_request_that_cannot_be_written_is_logged(tmp_path, monkeypatch):
    warnings: list[str] = []
    monkeypatch.setattr(
        validator, "debug_warning", lambda _m, msg, **_k: warnings.append(msg)
    )
    (tmp_path / "QA_FIX_REQUEST.md").mkdir()

    validator.write_architecture_fix_request(tmp_path, {"violations": [{"type": "x"}]})

    assert warnings and "Could not write" in warnings[0]


MONOREPO = {
    "project_type": "monorepo",
    "services": {
        "api": {"path": "apps/api"},
        "web": {"path": "apps/web"},
    },
}


def test_inferred_rules_only_warn(tmp_path, capsys):
    repo, spec_dir = _project(tmp_path, rules=None)
    (repo / "apps" / "api").mkdir(parents=True)
    (repo / "apps" / "web").mkdir(parents=True)
    (repo / "apps" / "web" / "page.ts").write_text(
        "export const p = 1\n", encoding="utf-8"
    )
    (spec_dir.parent.parent / "project_index.json").write_text(
        json.dumps(MONOREPO), encoding="utf-8"
    )
    _commit(repo, "apps/api/handler.ts", 'import { p } from "../web/page"\n')

    passed, report = _run(repo, spec_dir, verbose=True)

    assert passed is True
    assert report["violations"] == []
    assert report["warnings"], "a cross-service import is a warning when inferred"
    assert "\u26a0" in capsys.readouterr().out


@pytest.mark.parametrize("content", ["[1]", "{broken"])
def test_an_unreadable_project_index_infers_nothing(tmp_path, content):
    (tmp_path / ".workpilot").mkdir()
    (tmp_path / ".workpilot" / "project_index.json").write_text(
        content, encoding="utf-8"
    )

    config = infer_architecture_config(tmp_path)

    assert config.bounded_contexts == []
