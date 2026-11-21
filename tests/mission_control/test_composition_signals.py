"""What a Mission Control crew is decided from: words, a spec, the project.

No model is asked; every stack `project.stack` knows is read the same way.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from mission_control import signals as sig
from mission_control.signals import CompositionSignals, read_signals, read_spec_text


def _spec(tmp_path: Path, *, plan: dict | None = None, kind: str | None = None) -> Path:
    spec = tmp_path / "proj" / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text(
        "# Login\n\nAdd a login screen calling the API.", encoding="utf-8"
    )
    if plan is not None:
        (spec / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
    if kind:
        (spec / "task_metadata.json").write_text(
            json.dumps({"kind": kind, "kindSource": "user"}), encoding="utf-8"
        )
    return spec


class TestReadSignals:
    def test_words_domains_tests_and_named_files(self):
        found = read_signals(
            "Fix the crash in src/app.ts and Program.cs when the API returns "
            "an empty table; add a test."
        )
        assert found.kind == "bug_fix"
        assert found.domains == ["backend", "database"]
        assert found.mentions_tests is True
        assert found.touched_files == 2
        assert found.has_spec is False
        assert found.languages == [] and found.has_test_suite is False

    @pytest.mark.parametrize(
        ("text", "files"),
        [
            ("see src/lib/ and /etc/hosts.conf", 0),
            ("a.b/c.py and docs/guide.md-old", 2),
            ("App.TS, notes.markdown and x.b_c", 0),
            ("-" * 100_000 + " app.py", 1),
        ],
    )
    def test_named_files_are_whole_names_at_the_start_of_a_path(self, text, files):
        assert read_signals(text).touched_files == files

    def test_french_words_count_too(self):
        found = read_signals("Corriger l'écran de connexion et la base de données")
        assert found.domains == ["frontend", "database"]

    def test_a_spec_brings_its_plan_and_the_kind_the_user_chose(self, tmp_path):
        plan = {
            "subtasks": [
                {"files": ["a.py", "b.py"], "estimated_loc": 10},
                {"files": ["b.py", "c.py"]},
            ]
        }
        spec = _spec(tmp_path, plan=plan, kind="refactoring")
        found = read_signals("", spec_dir=spec)
        assert found.has_spec and found.subtasks == 2 and found.touched_files == 3
        assert found.kind == "refactoring" and found.kind_confident
        assert found.spec_tokens > 0

    def test_a_spec_without_a_plan_keeps_one_subtask_off(self, tmp_path):
        found = read_signals("", spec_dir=_spec(tmp_path))
        assert found.subtasks == 0 and found.touched_files == 0

    def test_the_project_stack_says_languages_and_test_suite(self, tmp_path):
        (tmp_path / "go.mod").write_text("module x\n", encoding="utf-8")
        found = read_signals("Add an endpoint", project_dir=tmp_path)
        assert "go" in found.languages
        assert found.has_test_suite is True

    def test_a_project_without_tests_says_so(self, tmp_path):
        (tmp_path / "package.json").write_text("{}", encoding="utf-8")
        found = read_signals("Add an endpoint", project_dir=tmp_path)
        assert found.languages == ["javascript/typescript"]
        assert found.has_test_suite is False


class TestSpecText:
    def test_missing_and_unreadable_files_are_skipped(self, tmp_path, monkeypatch):
        (tmp_path / "spec.md").write_text("spec", encoding="utf-8")
        (tmp_path / "requirements.json").write_text("{}", encoding="utf-8")
        real = Path.read_text

        def read(self, *args, **kwargs):
            if self.name == "requirements.json":
                raise OSError("locked")
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", read)
        assert read_spec_text(tmp_path) == "spec"
        assert read_spec_text(tmp_path / "nothing") == ""

    def test_a_huge_spec_is_capped(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sig, "MAX_SPEC_CHARS", 10)
        (tmp_path / "spec.md").write_text("x" * 50, encoding="utf-8")
        assert read_spec_text(tmp_path) == "x" * 10


class TestVagueAndSize:
    @pytest.mark.parametrize(
        ("signals", "vague"),
        [
            (CompositionSignals(words=1, has_spec=True), False),
            (CompositionSignals(words=2, kind_confident=True), True),
            (CompositionSignals(words=4), True),
            (CompositionSignals(words=4, kind_confident=True), False),
            (CompositionSignals(words=12), False),
        ],
    )
    def test_vague(self, signals, vague):
        assert signals.vague is vague

    @pytest.mark.parametrize(
        ("signals", "size"),
        [
            (CompositionSignals(spec_tokens=500), "small"),
            (
                CompositionSignals(touched_files=8, domains=["frontend", "backend"]),
                "medium",
            ),
            (CompositionSignals(spec_tokens=6_000, subtasks=6), "large"),
        ],
    )
    def test_complexity(self, signals, size):
        assert signals.complexity == size

    def test_to_dict_is_plain_data(self):
        data = CompositionSignals(domains=["docs"], languages=["rust"]).to_dict()
        assert data["domains"] == ["docs"] and data["languages"] == ["rust"]
        assert json.dumps(data)
