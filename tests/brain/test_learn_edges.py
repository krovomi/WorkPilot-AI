"""What the brain files about a build, a merge and a feature, from the specs
and failures the round trips in ``test_brain_integration`` do not use."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from brain import Brain, learn
from brain.graph import graph_path


@pytest.fixture
def brain(tmp_path, monkeypatch):
    root = tmp_path / "brain"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    made = Brain(root)
    made.init()
    return made


@pytest.fixture
def project(tmp_path):
    return tmp_path / "shop"


def spec(project, spec_id: str = "001-auth", **files: str):
    folder = project / ".workpilot" / "specs" / spec_id
    folder.mkdir(parents=True)
    for name, text in files.items():
        (folder / name.replace("_", ".", 1)).write_text(text, encoding="utf-8")
    return folder


class TestBuildNote:
    def test_the_task_description_names_and_sums_up_the_task(self, brain, project):
        folder = spec(
            project,
            requirements_json=json.dumps(
                {"task_description": "Add JWT login\nWith refresh tokens."}
            ),
        )

        rel = learn.record_build(folder, project, brain=brain)

        note = brain.read(rel)
        assert note["frontmatter"]["title"] == "Add JWT login"
        assert "## Demande\n\nAdd JWT login\nWith refresh tokens." in note["body"]

    def test_a_spec_with_only_a_heading_has_no_request_section(self, brain, project):
        folder = spec(project, spec_md="# Specification: Logout\n")

        note = brain.read(learn.record_build(folder, project, brain=brain))

        assert note["frontmatter"]["title"] == "Logout"
        assert "## Demande" not in note["body"]

    def test_a_long_request_is_cut_and_an_unreadable_spec_is_skipped(
        self, brain, project
    ):
        folder = spec(
            project,
            "002-long",
            requirements_json=json.dumps({"task_description": "word " * 400}),
        )
        (folder / "spec.md").mkdir()  # there, and not readable as a file

        note = brain.read(learn.record_build(folder, project, brain=brain))

        request = note["body"].split("## Demande\n\n", 1)[1].split("\n\n", 1)[0]
        assert len(request) == learn._MAX_SUMMARY and request.endswith("…")

    def test_an_empty_description_leaves_the_title_to_the_spec(self, brain, project):
        folder = spec(
            project,
            requirements_json=json.dumps({"task_description": "  "}),
            spec_md="Drafted by the planner.\n# Specification: Logout\n\nEnd sessions.\n",
        )

        note = brain.read(learn.record_build(folder, project, brain=brain))

        assert note["frontmatter"]["title"] == "Logout"

    def test_many_files_are_listed_up_to_the_cap(self, brain, project):
        folder = spec(project, spec_md="# T\n\nBody.\n")
        files = [f"src/f{n:02}.py" for n in range(learn._MAX_FILES + 3)]

        note = brain.read(
            learn.record_build(folder, project, changed_files=files, brain=brain)
        )

        assert note["body"].count("- `src/f") == learn._MAX_FILES
        assert "- … et 3 autre(s)" in note["body"]

    def test_a_build_that_cannot_be_filed_does_not_fail(
        self, brain, project, monkeypatch, caplog
    ):
        folder = spec(project, spec_md="# T\n")

        def full(*_a, **_k):
            raise OSError("disk full")

        monkeypatch.setattr(learn, "write_note", full)

        assert learn.record_build(folder, project, brain=brain) is None
        assert "could not record the build" in caplog.text


class TestMergeNote:
    def test_a_merge_without_its_build_note_files_nothing(self, brain, project):
        assert learn.record_merge(project, "009-never-built", brain=brain) is None

    def test_a_merge_that_cannot_be_filed_does_not_fail(
        self, brain, project, monkeypatch, caplog
    ):
        learn.record_build(spec(project, spec_md="# T\n"), project, brain=brain)

        def unreadable(*_a, **_k):
            raise ValueError("broken frontmatter")

        monkeypatch.setattr(learn, "read_note", unreadable)

        assert learn.record_merge(project, "001-auth", brain=brain) is None
        assert "could not record the merge" in caplog.text

    def test_the_merge_event_says_where_it_was_recorded(
        self, brain, project, monkeypatch, capsys
    ):
        learn.record_build(spec(project, spec_md="# T\n"), project, brain=brain)

        learn.on_merge(SimpleNamespace(project_dir=project, spec_name="001-auth"))
        learn.on_merge(SimpleNamespace(project_dir=project, spec_name="404-none"))

        out = capsys.readouterr().out.splitlines()
        assert out == [
            "  brain: merge recorded in knowledge/projects/shop/builds/001-auth.md"
        ]


class TestFeatureNote:
    def test_a_note_that_cannot_be_filed_logs_only_the_error_type(
        self, brain, monkeypatch, caplog
    ):
        def refused(*_a, **_k):
            raise PermissionError("C:/Users/someone/secret title")

        monkeypatch.setattr(Brain, "write", refused)

        assert learn.record("verify", "secret title", "b", brain=brain) is None
        assert "PermissionError" in caplog.text
        assert "secret title" not in caplog.text


class TestTaskLearning:
    def test_notes_of_a_task_without_a_build_note_after_a_stale_graph(self, brain):
        brain.write("Keys", "Rotate them.", task="shop/001-auth", sync=False)
        brain.write("Other", "Elsewhere.", task="shop/002-x", sync=False)
        graph_path(brain.root).unlink()

        learned = learn.task_learning("shop", "001-auth", brain=brain)

        assert learned["build"] is None
        assert [n["title"] for n in learned["notes"]] == ["Keys"]
        assert graph_path(brain.root).is_file()

    def test_the_build_note_of_a_task_from_a_fresh_graph(self, brain, project):
        learn.record_build(
            spec(project, spec_md="# T\n"), project, qa_approved=True, brain=brain
        )
        assert not brain.graph_is_stale()

        learned = learn.task_learning("shop", "001-auth", brain=brain)

        assert learned["build"]["qa"] is True and learned["build"]["status"] == "built"

    def test_a_brain_switched_off_has_nothing_on_the_task(self, brain, monkeypatch):
        monkeypatch.setenv("BRAIN_ENABLED", "false")

        assert learn.task_learning("shop", "001-auth", brain=brain) == {
            "active": False,
            "task": "shop/001-auth",
            "build": None,
            "notes": [],
            "proposals": [],
        }
