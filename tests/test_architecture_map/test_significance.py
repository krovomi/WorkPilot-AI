"""Tests for architectural significance assessment."""

from pathlib import Path

import pytest

from architecture_visualizer.archify import significance


def baseline(tmp_path: Path, sources: list[str]) -> Path:
    """Create a test baseline architecture model."""
    import json

    model = {
        "version": "1.0",
        "components": [
            {
                "id": "api",
                "name": "API",
                "sources": sources,
            },
        ],
    }
    path = tmp_path / "baseline.json"
    path.write_text(json.dumps(model), encoding="utf-8")
    return path


class TestSignificanceAssessment:
    """Tests for assessing architectural significance of changes."""

    def test_no_changes_is_not_significant(self, tmp_path: Path):
        result = significance.assess([], baseline(tmp_path, ["src"]))
        assert not result.significant

    def test_a_directory_source_matches_files_under_it(self, tmp_path: Path):
        """A component declared against a package owns the files in it."""
        result = significance.assess(
            ["apps/backend/agents/coder.py"],
            baseline(tmp_path, ["apps/backend/agents"]),
        )
        assert result.significant
        assert result.matched_components == ["api"]

    def test_a_file_source_matches_exactly(self, tmp_path: Path):
        """A component may also declare individual files."""
        result = significance.assess(
            ["src/utils/helper.py"],
            baseline(tmp_path, ["src/utils/helper.py"]),
        )
        assert result.significant
        assert result.matched_components == ["api"]

    def test_non_matching_changes_are_not_significant(self, tmp_path: Path):
        result = significance.assess(
            ["docs/readme.md"],
            baseline(tmp_path, ["src"]),
        )
        assert not result.significant

    def test_structural_files_are_always_significant(self, tmp_path: Path):
        result = significance.assess(
            ["package.json", "docker-compose.yml"],
            baseline(tmp_path, ["src"]),
        )
        assert result.significant
        assert "structural files" in result.reason.lower()

    def test_changes_outside_components_suggest_new_areas(self, tmp_path: Path):
        result = significance.assess(
            [
                "new_service/main.py",
                "new_service/utils.py",
                "new_service/models.py",
                "new_service/config.py",
            ],
            baseline(tmp_path, ["src"]),
        )
        assert result.significant
        assert "outside every modelled component" in result.reason

    def test_no_baseline_means_map_it(self, tmp_path: Path):
        result = significance.assess(["apps/backend/api.py"], tmp_path / "absent.json")
        assert result.significant
        assert "no baseline" in result.reason
