"""A spec must answer the task's current description (report of 2 November).

A duplicated "Create toto.txt" task, re-described to ask for tata.txt, ran on
the copied spec: QA judged against it and had tata.txt deleted. The spec now
records the description it was written from (the frontend regenerates it when
that changes, see stale-spec.ts), and QA reads the user's request first.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from spec.source import SPEC_SOURCE_FILE, record_spec_source


def _write_requirements(spec_dir: Path, description: str) -> None:
    (spec_dir / "requirements.json").write_text(
        json.dumps({"task_description": description}), encoding="utf-8"
    )


def test_a_finished_spec_records_its_description(tmp_path):
    _write_requirements(tmp_path, 'Créer un fichier "toto.txt"')

    assert record_spec_source(tmp_path) is True

    record = json.loads((tmp_path / SPEC_SOURCE_FILE).read_text(encoding="utf-8"))
    assert record["task_description"] == 'Créer un fichier "toto.txt"'
    assert record["recorded_at"]


def test_no_description_means_no_record(tmp_path):
    assert record_spec_source(tmp_path) is False
    (tmp_path / "requirements.json").write_text("{oops", encoding="utf-8")
    assert record_spec_source(tmp_path) is False
    _write_requirements(tmp_path, "   ")
    assert record_spec_source(tmp_path) is False
    assert not (tmp_path / SPEC_SOURCE_FILE).exists()


def test_the_source_file_name_matches_the_frontend():
    frontend = (
        Path(__file__).resolve().parents[1]
        / "apps/frontend/src/main/ipc-handlers/task/stale-spec.ts"
    ).read_text(encoding="utf-8")
    assert f'SPEC_SOURCE_FILE = "{SPEC_SOURCE_FILE}"' in frontend


def test_the_orchestrator_records_the_source_when_the_spec_is_done():
    source = (
        Path(__file__).resolve().parents[1]
        / "apps/backend/spec/pipeline/orchestrator.py"
    ).read_text(encoding="utf-8")
    done = source.index('message="Spec creation complete"')
    assert "record_spec_source(self.spec_dir)" in source[done : done + 300]


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def test_the_light_qa_prompt_puts_the_users_request_above_the_spec(tmp_path):
    from foundation.change_scope import change_scope
    from prompts_pkg import get_qa_reviewer_light_prompt

    repo = tmp_path
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    (repo / "README.md").write_text("hi\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-qm", "init")
    spec_dir = repo / ".workpilot" / "specs" / "006"
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text("# Create toto.txt\n", encoding="utf-8")
    (spec_dir / "implementation_plan.json").write_text("{}", encoding="utf-8")
    _write_requirements(spec_dir, 'Créer un fichier "tata.txt" {{SPEC}} ```')
    (repo / "tata.txt").write_text("OK\n", encoding="utf-8")

    prompt = get_qa_reviewer_light_prompt(spec_dir, repo, change_scope(repo, "main"))

    assert 'Créer un fichier "tata.txt"' in prompt
    assert prompt.index("tata.txt") < prompt.index("THE CHANGE")
    assert "the request wins" in prompt
    assert "{{" not in prompt


def test_the_full_qa_prompts_read_the_users_request():
    from prompts_pkg.prompts import _load_prompt_file

    for name in ("qa_reviewer.md", "qa_fixer.md"):
        prompt = _load_prompt_file(name)
        assert "requirements.json" in prompt, name
        assert "outranks the spec" in prompt, name
