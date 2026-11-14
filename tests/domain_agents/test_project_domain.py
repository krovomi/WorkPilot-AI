"""A project's domain reaches its agents, and library advice follows its stack."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from agents.feature_wiring import load_domain_addendum
from domain_agents import DomainAgentFactory
from domain_agents.api import (
    ProjectRequest,
    SetProjectDomainRequest,
    project_domain,
    set_project_domain,
)
from domain_agents.project_domain import (
    DOMAIN_FILE,
    project_root_of,
    read_project_domain,
    write_project_domain,
)


def _spec(root: Path, *parts: str) -> Path:
    spec = root.joinpath(*parts)
    spec.mkdir(parents=True)
    return spec


class TestProjectRoot:
    def test_main_checkout(self, tmp_path):
        spec = _spec(tmp_path, ".workpilot", "specs", "001-x")
        assert project_root_of(spec) == tmp_path.resolve()

    def test_task_worktree(self, tmp_path):
        spec = _spec(
            tmp_path,
            ".workpilot",
            "worktrees",
            "tasks",
            "001-x",
            ".workpilot",
            "specs",
            "001-x",
        )
        assert project_root_of(spec) == tmp_path.resolve()

    def test_not_a_spec(self, tmp_path):
        assert project_root_of(tmp_path) is None


class TestReadWrite:
    def test_round_trip_and_clear(self, tmp_path):
        assert write_project_domain(tmp_path, "fintech") == "fintech"
        assert read_project_domain(tmp_path) == "fintech"
        assert write_project_domain(tmp_path, None) is None
        assert not (tmp_path / DOMAIN_FILE).exists()

    def test_generic_clears(self, tmp_path):
        write_project_domain(tmp_path, "iot")
        write_project_domain(tmp_path, "generic")
        assert read_project_domain(tmp_path) is None

    def test_unknown_domain_is_refused(self, tmp_path):
        with pytest.raises(ValueError):
            write_project_domain(tmp_path, "casino")

    def test_garbage_file_reads_as_none(self, tmp_path):
        (tmp_path / ".workpilot").mkdir()
        (tmp_path / DOMAIN_FILE).write_text("{not json", encoding="utf-8")
        assert read_project_domain(tmp_path) is None
        (tmp_path / DOMAIN_FILE).write_text('{"domain": "casino"}', encoding="utf-8")
        assert read_project_domain(tmp_path) is None


class TestAgentsGetTheProjectDomain:
    def test_project_domain_reaches_a_worktree_task(self, tmp_path):
        write_project_domain(tmp_path, "healthcare")
        spec = _spec(
            tmp_path,
            ".workpilot",
            "worktrees",
            "tasks",
            "001-x",
            ".workpilot",
            "specs",
            "001-x",
        )
        addendum = load_domain_addendum(spec, role="coder")
        assert "Healthcare" in addendum

    def test_spec_domain_wins(self, tmp_path):
        write_project_domain(tmp_path, "healthcare")
        spec = _spec(tmp_path, ".workpilot", "specs", "001-x")
        (spec / "requirements.json").write_text(
            json.dumps({"domain": "gaming"}), encoding="utf-8"
        )
        assert "Gaming" in load_domain_addendum(spec, role="coder")

    def test_no_domain_no_addendum(self, tmp_path):
        spec = _spec(tmp_path, ".workpilot", "specs", "001-x")
        assert load_domain_addendum(spec, role="coder") == ""

    def test_libraries_follow_the_worktree_stack(self, tmp_path):
        write_project_domain(tmp_path, "ecommerce")
        worktree = tmp_path / ".workpilot" / "worktrees" / "tasks" / "001-x"
        spec = _spec(worktree, ".workpilot", "specs", "001-x")
        (worktree / "Shop.csproj").write_text("<Project />", encoding="utf-8")
        addendum = load_domain_addendum(spec, role="coder")
        assert "Stripe.net" in addendum
        assert "py-moneyed" not in addendum


class TestLibrariesPerStack:
    def test_preview_lists_every_stack(self):
        bundle = DomainAgentFactory().build("iot", "coder")
        assert bundle.suggested_libraries["c#"] == ["MQTTnet"]
        assert bundle.suggested_libraries["python"] == ["paho-mqtt"]
        assert "c#: `MQTTnet`" in bundle.prompt_addendum

    def test_a_stack_gets_only_its_own(self):
        bundle = DomainAgentFactory().build("iot", "coder", languages=["go"])
        assert bundle.suggested_libraries == {
            "go": ["github.com/eclipse/paho.mqtt.golang"]
        }
        assert "paho-mqtt`" not in bundle.prompt_addendum

    def test_unknown_stack_gets_no_library_advice(self):
        bundle = DomainAgentFactory().build("fintech", "coder", languages=[])
        assert bundle.suggested_libraries == {}
        assert "Suggested libraries" not in bundle.prompt_addendum

    def test_every_profile_keys_known_stacks(self):
        known = {
            "python",
            "c#",
            "javascript/typescript",
            "java/kotlin",
            "go",
            "rust",
            "php",
            "ruby",
            "dart",
            "swift",
            "elixir",
        }
        for entry in DomainAgentFactory().list_domains():
            profile = DomainAgentFactory().get_profile(entry["tag"])
            assert set(profile.suggested_libraries) <= known, entry["tag"]


class TestRoutes:
    def test_set_then_read(self, tmp_path):
        (tmp_path / "go.mod").write_text("module x\n", encoding="utf-8")
        saved = set_project_domain(
            SetProjectDomainRequest(project_path=str(tmp_path), domain="saas")
        )
        assert saved == {"success": True, "domain": "saas"}
        read = project_domain(ProjectRequest(project_path=str(tmp_path)))
        assert read["domain"] == "saas"
        assert "go" in read["languages"]

    def test_unknown_domain_is_an_error(self, tmp_path):
        result = set_project_domain(
            SetProjectDomainRequest(project_path=str(tmp_path), domain="casino")
        )
        assert result["success"] is False

    def test_missing_folder_is_an_error(self, tmp_path):
        result = project_domain(ProjectRequest(project_path=str(tmp_path / "nope")))
        assert result["success"] is False
