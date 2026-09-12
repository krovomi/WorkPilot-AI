"""Id continuity, and the evidence that must not be half-pinned."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from architecture_visualizer.archify import ir as ir_module


def model(*component_ids: str, sources: dict[str, list[str]] | None = None) -> dict:
    sources = sources or {}
    return {
        "schema_version": 1,
        "diagram_type": "architecture",
        "meta": {"title": "Test"},
        "components": [
            {
                "id": cid,
                "type": "backend",
                "label": cid,
                **(
                    {"sources": [{"path": p} for p in sources[cid]]}
                    if cid in sources
                    else {}
                ),
            }
            for cid in component_ids
        ],
    }


class TestIdContinuity:
    def test_identical_models_are_fully_continuous(self):
        result = ir_module.check_id_continuity(model("a", "b"), model("a", "b"))
        assert result.reliable
        assert result.ratio == 1.0
        assert result.lost == []

    def test_added_components_do_not_reduce_continuity(self):
        """Continuity is about what the base had, not about what the head added.

        A task that adds a component is the ordinary case; measuring the ratio
        against the head would make every addition look like drift.
        """
        result = ir_module.check_id_continuity(model("a", "b"), model("a", "b", "c"))
        assert result.reliable
        assert result.ratio == 1.0

    def test_one_removal_out_of_eight_stays_reliable(self):
        base = model(*[f"c{i}" for i in range(8)])
        head = model(*[f"c{i}" for i in range(1, 8)])
        result = ir_module.check_id_continuity(base, head)
        assert result.reliable
        assert result.kept == 7
        assert result.total == 8
        assert result.lost == ["c0"]

    def test_wholesale_renaming_is_refused(self):
        """The failure this exists for: a head model that renamed everything.

        Every base id would read as removed and every head id as added, which is
        a delta that describes the author's naming rather than the code.
        """
        base = model("a", "b", "c")
        head = model("x", "y", "z")
        result = ir_module.check_id_continuity(base, head)
        assert not result.reliable
        assert result.ratio == 0.0
        assert sorted(result.lost) == ["a", "b", "c"]

    def test_empty_base_is_reliable(self):
        """A project's first model is legitimately all-new."""
        result = ir_module.check_id_continuity(model(), model("a"))
        assert result.reliable
        assert result.total == 0

    def test_threshold_is_inclusive(self):
        base = model("a", "b", "c", "d", "e")
        head = model("a", "b", "c")
        result = ir_module.check_id_continuity(base, head, threshold=0.6)
        assert result.ratio == pytest.approx(0.6)
        assert result.reliable


class TestLoad:
    def test_rejects_a_non_architecture_diagram(self, tmp_path: Path):
        path = tmp_path / "m.json"
        path.write_text(json.dumps({"diagram_type": "workflow"}), encoding="utf-8")
        with pytest.raises(ir_module.IRError, match="workflow"):
            ir_module.load(path)

    def test_reports_a_missing_file_by_name(self, tmp_path: Path):
        with pytest.raises(ir_module.IRError, match="absent.json"):
            ir_module.load(tmp_path / "absent.json")

    def test_round_trips(self, tmp_path: Path):
        path = tmp_path / "m.json"
        ir_module.save(path, model("a"))
        assert ir_module.component_ids(ir_module.load(path)) == {"a"}


def _git_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    run = lambda *a: subprocess.run(  # noqa: E731
        ["git", *a], cwd=repo, check=True, capture_output=True
    )
    run("init", "-q")
    run("config", "user.email", "t@example.com")
    run("config", "user.name", "T")
    run("remote", "add", "origin", "https://github.com/acme/widget.git")
    (repo / "app.py").write_text("x = 1\n", encoding="utf-8")
    run("add", "app.py")
    run("commit", "-q", "-m", "first")
    return repo


class TestPinRepository:
    def test_pins_a_source_that_exists_at_the_revision(self, tmp_path: Path):
        repo = _git_repo(tmp_path)
        pinned, revision = ir_module.pin_repository(
            model("a", sources={"a": ["app.py"]}), repo
        )
        assert revision and len(revision) == 40
        assert pinned["meta"]["repository"]["url"].endswith("acme/widget.git")
        assert pinned["components"][0]["sources"] == [{"path": "app.py"}]

    def test_drops_a_source_with_no_blob_at_that_commit(self, tmp_path: Path):
        """An uncommitted file has nothing to verify against.

        archify reads blobs, not the working tree, so leaving the citation in
        would refuse the whole render rather than lose one link.
        """
        repo = _git_repo(tmp_path)
        (repo / "new.py").write_text("y = 2\n", encoding="utf-8")
        pinned, revision = ir_module.pin_repository(
            model("a", sources={"a": ["app.py", "new.py"]}), repo
        )
        assert revision
        assert pinned["components"][0]["sources"] == [{"path": "app.py"}]

    def test_strips_everything_when_no_source_is_committed(self, tmp_path: Path):
        repo = _git_repo(tmp_path)
        pinned, revision = ir_module.pin_repository(
            model("a", sources={"a": ["not-committed.py"]}), repo
        )
        assert revision is None
        assert "repository" not in pinned["meta"]
        assert "sources" not in pinned["components"][0]

    def test_strips_everything_outside_a_repository(self, tmp_path: Path):
        pinned, revision = ir_module.pin_repository(
            model("a", sources={"a": ["app.py"]}), tmp_path
        )
        assert revision is None
        assert "repository" not in pinned["meta"]
        assert "sources" not in pinned["components"][0]

    def test_marks_a_non_github_forge_local_only(self, tmp_path: Path):
        """archify can only build revision links for GitHub and Gitee.

        Anywhere else, `web` mode would render links that 404; `local-only`
        keeps the SRC markers and drops the hyperlinks.
        """
        repo = _git_repo(tmp_path)
        subprocess.run(
            ["git", "remote", "set-url", "origin", "https://git.internal:3000/t/s"],
            cwd=repo,
            check=True,
            capture_output=True,
        )
        pinned, _ = ir_module.pin_repository(
            model("a", sources={"a": ["app.py"]}), repo
        )
        assert pinned["meta"]["repository"]["link_mode"] == "local-only"

    def test_redacts_credentials_from_the_origin(self, tmp_path: Path):
        repo = _git_repo(tmp_path)
        subprocess.run(
            [
                "git",
                "remote",
                "set-url",
                "origin",
                "https://user:secret@github.com/acme/widget.git",
            ],
            cwd=repo,
            check=True,
            capture_output=True,
        )
        pinned, _ = ir_module.pin_repository(
            model("a", sources={"a": ["app.py"]}), repo
        )
        url = pinned["meta"]["repository"]["url"]
        assert "secret" not in url
        assert url == "https://github.com/acme/widget.git"
