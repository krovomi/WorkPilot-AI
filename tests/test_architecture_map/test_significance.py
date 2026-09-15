"""Is this task worth mapping? Decided from paths, before any API call."""

from __future__ import annotations

import json
from pathlib import Path

from architecture_visualizer.archify import significance


def baseline(tmp_path: Path, sources: list[str]) -> Path:
    path = tmp_path / "baseline.arch.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "diagram_type": "architecture",
                "meta": {"title": "T"},
                "components": [
                    {
                        "id": "api",
                        "type": "backend",
                        "label": "API",
                        "sources": [{"path": p} for p in sources],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


class TestIsStructural:
    def test_source_files_are(self):
        assert significance.is_structural("apps/backend/api.py")
        assert significance.is_structural("src/Main.cs")
        assert significance.is_structural("Dockerfile")
        assert significance.is_structural("infra/main.tf")

    def test_documentation_is_not(self):
        assert not significance.is_structural("README.md")
        assert not significance.is_structural("docs/design.md")

    def test_tests_are_not(self):
        """A task that only edits tests changes the evidence, not the system."""
        assert not significance.is_structural("tests/test_api.py")
        assert not significance.is_structural("apps/web/__tests__/a.tsx")
        assert not significance.is_structural("e2e/checkout.spec.ts")

    def test_a_source_file_whose_name_contains_test_still_is(self):
        """Matched on path segments, not on substrings."""
        assert significance.is_structural("src/tester.py")
        assert significance.is_structural("src/latest.ts")

    def test_vendored_and_generated_trees_are_not(self):
        assert not significance.is_structural("node_modules/lib/index.js")
        assert not significance.is_structural("dist/bundle.js")


class TestAssess:
    def test_documentation_only_is_not_worth_mapping(self, tmp_path: Path):
        result = significance.assess(["README.md", "docs/x.md"], baseline(tmp_path, []))
        assert not result.significant
        assert "carry a component" in result.reason

    def test_an_unknown_change_set_is_mapped(self, tmp_path: Path):
        """Refusing on absent evidence would make some providers unmappable."""
        result = significance.assess(None, baseline(tmp_path, []))
        assert result.significant

    def test_touching_a_modelled_component_is_worth_mapping(self, tmp_path: Path):
        result = significance.assess(
            ["apps/backend/api.py"], baseline(tmp_path, ["apps/backend/api.py"])
        )
        assert result.significant
        assert result.matched_components == ["api"]

    def test_a_directory_source_matches_files_under_it(self, tmp_path: Path):
        """A component declared against a package owns the files in it."""
        result = significance.assess(
            ["apps/backend/agents/coder.py"],
            baseline(tmp_path, ["apps/backend/agents"]),
        )
        assert result.significant
        assert result.matched_components == ["api"]

    def test_one_file_outside_every_component_is_not_a_new_one(self, tmp_path: Path):
        result = significance.assess(
            ["apps/web/util.ts"], baseline(tmp_path, ["apps/backend/api.py"])
        )
        assert not result.significant
        assert "too few" in result.reason

    def test_a_new_area_is_worth_mapping(self, tmp_path: Path):
        result = significance.assess(
            [
                "src/connectors/slack/client.py",
                "src/connectors/slack/models.py",
                "src/connectors/slack/webhook.py",
            ],
            baseline(tmp_path, ["apps/backend/api.py"]),
        )
        assert result.significant
        assert "outside every modelled component" in result.reason

    def test_no_baseline_means_map_it(self, tmp_path: Path):
        result = significance.assess(["apps/backend/api.py"], tmp_path / "absent.json")
        assert result.significant
        assert "no baseline" in result.reason

    def test_an_unreadable_baseline_does_not_crash(self, tmp_path: Path):
        broken = tmp_path / "broken.json"
        broken.write_text("{not json", encoding="utf-8")
        result = significance.assess(["apps/backend/api.py"], broken)
        assert result.significant
