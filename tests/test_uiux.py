"""ui-ux-pro-max in the build pipeline: vendored portably, used only on UI tasks.

The engine is the real vendored one, run through the backend's own interpreter
— the property the integration rests on is that it works without `python3` on
PATH, so a fake would test our idea of it. Projects and plans are fabricated
the way the planner writes them.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from uiux import engine  # noqa: E402
from uiux.integration import (  # noqa: E402
    MCP_TOOL_NAMES,
    active_for,
    tool_definitions,
)
from uiux.mcp_server import TOOL_NAMES, handle  # noqa: E402
from uiux.preflight import read_result, run_preflight  # noqa: E402
from uiux.prompt import uiux_section  # noqa: E402
from uiux.relevance import assess, write_override  # noqa: E402
from uiux.runtime import doctor  # noqa: E402
from uiux.stack import detect_ui_stack  # noqa: E402
from uiux.surface import UI_GLOBS, is_ui_path  # noqa: E402
from workflows.engine import _touched, narrow_to_forecast, resolve_profile  # noqa: E402
from workflows.forecast import planned_files  # noqa: E402
from workflows.spec import load_workflow  # noqa: E402

SKILL_SOURCE = REPO_ROOT / "skills" / "ui-ux-pro-max" / "ui-ux-pro-max"
SKILL_EMITTED = REPO_ROOT / ".agents" / "skills" / "ui-ux-pro-max"
WORKFLOW = REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    for key in ("UIUX_ENABLED", "UIUX_PERSIST_MASTER", "UIUX_MAX_GUIDELINES"):
        monkeypatch.delenv(key, raising=False)


def _spec(project: Path, description: str, files: list[list[str]] | None) -> Path:
    spec = project / ".workpilot" / "specs" / "001-task"
    spec.mkdir(parents=True)
    (spec / "requirements.json").write_text(
        json.dumps({"task_description": description}), encoding="utf-8"
    )
    if files is not None:
        plan = {
            "phases": [
                {
                    "subtasks": [
                        {"id": str(i), "files_to_modify": group}
                        for i, group in enumerate(files)
                    ]
                }
            ]
        }
        (spec / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
    return spec


@pytest.fixture
def react_project(tmp_path) -> Path:
    project = tmp_path / "shop"
    project.mkdir()
    (project / "package.json").write_text(
        json.dumps({"dependencies": {"react": "19", "next": "15"}}), encoding="utf-8"
    )
    return project


@pytest.fixture
def api_project(tmp_path) -> Path:
    project = tmp_path / "billing"
    project.mkdir()
    (project / "Billing.Api.csproj").write_text(
        '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>', encoding="utf-8"
    )
    return project


# ---------------------------------------------------------------------------
# Vendoring: portable, licensed, and the same bytes in every mirror
# ---------------------------------------------------------------------------


class TestVendoredSkill:
    def test_the_receipt_matches_the_tree(self):
        sys.path.insert(0, str(REPO_ROOT / "scripts"))
        import vendor_ui_ux_pro_max as vendor

        assert vendor.check(vendor.DEFAULT_REF) == 0

    def test_the_licence_travels_with_the_skill(self):
        assert (SKILL_SOURCE / "LICENSE").is_file()
        assert (SKILL_EMITTED / "LICENSE").is_file()

    @pytest.mark.parametrize("root", [SKILL_SOURCE, SKILL_EMITTED])
    def test_no_claude_only_path_survives(self, root):
        text = (root / "SKILL.md").read_text(encoding="utf-8")
        assert "CLAUDE_PLUGIN_ROOT" not in text
        assert ".claude/skills/ui-ux-pro-max/scripts" not in text
        assert '"<skill-dir>/scripts/search.py"' in text
        assert "## Portability (WorkPilot)" in text
        # Every harness that reads `.agents/skills` is named, Antigravity included.
        assert "Antigravity" in text and ".agents/skills/ui-ux-pro-max" in text

    def test_the_gemini_command_names_the_skill_directory(self):
        toml = (REPO_ROOT / ".gemini" / "commands" / "ui-ux-pro-max.toml").read_text(
            encoding="utf-8"
        )
        assert ".agents/skills/ui-ux-pro-max" in toml

    def test_what_nothing_reads_is_not_vendored(self):
        assert not (SKILL_SOURCE / "scripts" / "tests").exists()
        assert not (SKILL_SOURCE / "scripts" / "validate_data.py").exists()
        assert not (SKILL_SOURCE / "data" / "phosphor-icons-upstream.json").exists()
        assert not list(SKILL_EMITTED.rglob("__pycache__"))

    def test_the_rewrite_refuses_a_path_it_does_not_know(self):
        sys.path.insert(0, str(REPO_ROOT / "scripts"))
        import vendor_ui_ux_pro_max as vendor

        document = "---\nname: x\ndescription: y\n---\n\n# T\n\nrun `.claude/skills/other/x.py`\n"
        with pytest.raises(ValueError):
            vendor.make_portable(document)

    def test_the_skill_ships_with_the_packaged_app(self):
        package = json.loads(
            (REPO_ROOT / "apps" / "frontend" / "package.json").read_text(
                encoding="utf-8"
            )
        )
        resources = package["build"]["extraResources"]
        assert any(
            r.get("from") == "../../.agents/skills/ui-ux-pro-max" for r in resources
        )

    def test_the_doctor_finds_it(self):
        assert doctor().installed


# ---------------------------------------------------------------------------
# One answer to "is this file UI?", and the workflow uses the same one
# ---------------------------------------------------------------------------


class TestSurface:
    @pytest.mark.parametrize(
        "path",
        [
            "App.tsx",
            "index.html",
            "src/pages/Settings.vue",
            "Pages/Orders.razor",
            "Views/Home/Index.cshtml",
            "MainWindow.xaml",
            "Views/Shell.axaml",
            "lib/screens/home.dart",
            "app/src/main/res/layout/activity_main.xml",
        ],
    )
    def test_ui_files(self, path):
        assert is_ui_path(path)

    @pytest.mark.parametrize(
        "path",
        [
            "Controllers/OrdersController.cs",
            "src/api/orders.ts",
            "migrations/001.sql",
            "README.md",
        ],
    )
    def test_not_ui_files(self, path):
        assert not is_ui_path(path)

    def test_the_workflow_anchor_is_this_list(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        match = re.search(r'&ui_surface touches\("([^"]+)"\)', text)
        assert match, "workflow.yaml declares no &ui_surface anchor"
        assert tuple(match.group(1).split(",")) == UI_GLOBS, (
            "run `python3 scripts/sync_surface_globs.py` to rewrite the anchor"
        )

    def test_the_frontend_gate_is_a_subset_of_the_ui_surface(self):
        """`design-check` is narrower on purpose, never wider (see its description)."""
        text = WORKFLOW.read_text(encoding="utf-8")
        match = re.search(r'&frontend_surface touches\("([^"]+)"\)', text)
        assert match, "workflow.yaml declares no &frontend_surface anchor"
        assert set(match.group(1).split(",")) <= set(UI_GLOBS)

    def test_both_mobile_phases_share_one_list(self):
        workflow = load_workflow(WORKFLOW)
        by_id = {p.id: p for p in workflow.phases}
        assert by_id["mobile-design"].when_globs == by_id["store-readiness"].when_globs
        assert by_id["mobile-design"].when_globs
        text = WORKFLOW.read_text(encoding="utf-8")
        assert text.count("&mobile_surface touches(") == 1
        assert text.count("**/AndroidManifest.xml") == 1


class TestRootFilesMatch:
    """`**/*.tsx` must see a root `App.tsx` — fnmatch's `*` wants a separator."""

    def test_a_root_file_touches_a_double_star_glob(self):
        assert _touched(("**/*.tsx",), ["App.tsx"])
        assert _touched(("**/*.html",), ["index.html"])

    def test_a_backend_change_does_not(self):
        assert not _touched(("**/*.tsx", "**/*.css"), ["src/api/orders.ts"])


# ---------------------------------------------------------------------------
# Relevance: override -> plan -> description (only on a project with a UI)
# ---------------------------------------------------------------------------


class TestRelevance:
    def test_a_plan_with_ui_files_is_a_ui_task(self, react_project):
        spec = _spec(react_project, "Add an endpoint", [["src/api/x.ts"], ["App.tsx"]])
        verdict = assess(react_project, spec)
        assert verdict.is_ui and verdict.reason == "planned-ui-files"
        assert verdict.ui_files == ["App.tsx"]

    def test_a_plan_without_ui_files_is_not_whatever_the_words_say(self, react_project):
        spec = _spec(
            react_project,
            "Redesign the dashboard page colours",
            [["src/api/orders.ts"]],
        )
        assert assess(react_project, spec).reason == "planned-no-ui-files"

    def test_words_are_not_believed_on_a_project_without_a_ui(self, api_project):
        spec = _spec(api_project, "Paginate the invoices page endpoint", None)
        verdict = assess(api_project, spec)
        assert not verdict.is_ui and verdict.reason == "no-ui-stack"

    def test_words_decide_before_a_plan_on_a_ui_project(self, react_project):
        spec = _spec(
            react_project, "Ajouter un écran de paramètres avec un formulaire", None
        )
        verdict = assess(react_project, spec)
        assert verdict.is_ui and verdict.reason == "description"

    def test_one_stray_word_does_not_make_a_backend_task_ui(self, react_project):
        spec = _spec(
            react_project, "Add an API endpoint returning the page count", None
        )
        assert not assess(react_project, spec).is_ui

    def test_a_person_overrides_both_ways(self, api_project, react_project):
        spec = _spec(api_project, "anything", [["Controllers/X.cs"]])
        write_override(spec, "force")
        assert assess(api_project, spec).reason == "override-force"
        spec2 = _spec(react_project, "anything", [["App.tsx"]])
        write_override(spec2, "skip")
        assert assess(react_project, spec2).reason == "override-skip"
        write_override(spec2, "auto")
        assert assess(react_project, spec2).is_ui

    def test_the_switch_turns_it_off(self, react_project, monkeypatch):
        monkeypatch.setenv("UIUX_ENABLED", "false")
        spec = _spec(react_project, "x", [["App.tsx"]])
        assert assess(react_project, spec).reason == "disabled"


class TestStack:
    def test_a_monorepo_app_gets_its_own_guide(self, tmp_path):
        (tmp_path / "apps" / "admin").mkdir(parents=True)
        (tmp_path / "apps" / "admin" / "package.json").write_text(
            json.dumps({"dependencies": {"vue": "3"}}), encoding="utf-8"
        )
        (tmp_path / "apps" / "site").mkdir(parents=True)
        (tmp_path / "apps" / "site" / "package.json").write_text(
            json.dumps({"dependencies": {"react": "19", "next": "15"}}),
            encoding="utf-8",
        )
        stack = detect_ui_stack(tmp_path)
        assert stack.guide_for(["apps/admin/src/App.vue"]).guide == "vue"
        assert stack.guide_for(["apps/site/app/page.tsx"]).guide == "nextjs"

    @pytest.mark.parametrize(
        ("csproj", "guide", "name"),
        [
            ("<PropertyGroup><UseWPF>true</UseWPF></PropertyGroup>", "wpf", "wpf"),
            (
                '<PackageReference Include="Avalonia" Version="11" />',
                "avalonia",
                "avalonia",
            ),
            ('<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly" />', None, "blazor"),
        ],
    )
    def test_dotnet_desktop_and_web_toolkits(self, tmp_path, csproj, guide, name):
        (tmp_path / "App.csproj").write_text(csproj, encoding="utf-8")
        kit = detect_ui_stack(tmp_path).guide_for()
        assert kit.name == name and kit.guide == guide

    def test_a_web_api_has_no_ui(self, api_project):
        assert not detect_ui_stack(api_project).has_ui


# ---------------------------------------------------------------------------
# The engine, through the backend's interpreter
# ---------------------------------------------------------------------------


class TestEngine:
    def test_stack_guidelines_for_a_dotnet_desktop_stack(self):
        text = engine.stack_guidelines("form validation", "wpf", n=1).text
        assert "wpf" in text.lower()

    def test_a_design_system_is_markdown(self):
        text = engine.design_system("saas billing dashboard", "Acme").text
        assert "Design System" in text and "#" in text

    @pytest.mark.parametrize("bad", ["--force", "  ", "-p /etc"])
    def test_a_query_cannot_become_an_option(self, bad):
        try:
            cleaned = engine.clean_query(bad)
        except ValueError:
            return
        assert not cleaned.startswith("-")

    def test_unknown_choices_are_refused_before_the_process_starts(self):
        with pytest.raises(ValueError):
            engine.search("x", domain="../../etc")
        with pytest.raises(ValueError):
            engine.stack_guidelines("x", "cobol")

    def test_the_choices_are_upstreams(self):
        scripts = SKILL_SOURCE / "scripts"
        core = (scripts / "core.py").read_text(encoding="utf-8")
        for domain in engine.DOMAINS:
            assert f'"{domain}"' in core
        assert set(engine.STACKS) == {
            p.stem for p in (SKILL_SOURCE / "data" / "stacks").glob("*.csv")
        }

    def test_an_absent_engine_is_an_error_not_a_crash(self, monkeypatch):
        monkeypatch.setattr(engine, "skill_dir", lambda: None)
        with pytest.raises(engine.EngineError):
            engine.search("x")


# ---------------------------------------------------------------------------
# Preflight, prompt and tools: everything for a UI task, nothing for the rest
# ---------------------------------------------------------------------------


class TestPreflight:
    def test_a_ui_task_gets_a_design_system_written_to_the_worktree(
        self, react_project
    ):
        spec = _spec(
            react_project,
            "Billing settings page for a SaaS",
            [["src/api/s.ts"], ["app/settings/page.tsx"]],
        )
        result = run_preflight(react_project, spec)
        assert result.status == "ready" and result.source == "generated"
        assert result.master_written
        assert (react_project / result.master_path).is_file()
        assert result.guide == "nextjs"
        assert (spec / "uiux" / "design-system.md").is_file()

    def test_the_projects_master_is_the_design_system_and_is_never_rewritten(
        self, react_project
    ):
        master = react_project / "design-system" / "shop" / "MASTER.md"
        master.parent.mkdir(parents=True)
        master.write_text("# Ours\n| Primary | `#123456` | `--p` |\n", encoding="utf-8")
        spec = _spec(react_project, "settings page", [["App.tsx"]])
        result = run_preflight(react_project, spec)
        assert result.source == "project" and not result.master_written
        assert master.read_text(encoding="utf-8").startswith("# Ours")
        assert "#123456" in (spec / "uiux" / "design-system.md").read_text(
            encoding="utf-8"
        )

    def test_persisting_can_be_switched_off(self, react_project, monkeypatch):
        monkeypatch.setenv("UIUX_PERSIST_MASTER", "false")
        spec = _spec(react_project, "settings page", [["App.tsx"]])
        result = run_preflight(react_project, spec)
        assert result.status == "ready" and not result.master_written
        assert not (react_project / "design-system").exists()

    def test_a_backend_task_writes_nothing_in_the_project(self, api_project):
        spec = _spec(api_project, "endpoint", [["Controllers/X.cs"]])
        result = run_preflight(api_project, spec)
        assert result.status == "skipped"
        assert not (api_project / "design-system").exists()
        assert read_result(spec)["relevance"]["verdict"] == "not-ui"

    def test_an_absent_engine_does_not_fail_the_build(self, react_project, monkeypatch):
        import uiux.preflight as preflight
        from uiux.runtime import Doctor

        monkeypatch.setattr(
            preflight, "doctor", lambda: Doctor(False, None, None, "not vendored")
        )
        spec = _spec(react_project, "page", [["App.tsx"]])
        assert run_preflight(react_project, spec).status == "not-installed"


class TestPromptAndTools:
    def test_the_section_reaches_ui_subtasks_only(self, react_project):
        spec = _spec(react_project, "settings page", [["src/api/s.ts"], ["App.tsx"]])
        run_preflight(react_project, spec)
        assert "UI/UX DESIGN SYSTEM" in uiux_section(
            spec, {"files_to_modify": ["App.tsx"]}
        )
        assert uiux_section(spec, {"files_to_modify": ["src/api/s.ts"]}) == ""
        qa = uiux_section(spec, role="qa")
        assert "Pre-Delivery Checklist" in qa

    def test_a_backend_task_gets_no_section_and_no_tool(self, api_project):
        spec = _spec(api_project, "endpoint", [["Controllers/X.cs"]])
        run_preflight(api_project, spec)
        assert uiux_section(spec) == ""
        assert not active_for(spec)
        assert tool_definitions(spec) == []

    def test_a_ui_task_gets_the_tools_under_one_server(self, react_project):
        spec = _spec(react_project, "settings page", [["App.tsx"]])
        run_preflight(react_project, spec)
        assert [t["name"] for t in tool_definitions(spec)] == list(TOOL_NAMES)
        assert all(n.startswith("mcp__workpilot-uiux__") for n in MCP_TOOL_NAMES)

    def test_the_mcp_server_answers_and_refuses(self, react_project):
        listed = handle(
            react_project, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        assert {t["name"] for t in listed["result"]["tools"]} == set(TOOL_NAMES)
        bad = handle(
            react_project,
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "uiux_stack_guidelines",
                    "arguments": {"query": "x", "stack": "cobol"},
                },
            },
        )
        assert bad["result"]["isError"]


# ---------------------------------------------------------------------------
# The workflow: the phase runs before coding, and the plan narrows the window
# ---------------------------------------------------------------------------


class TestWorkflow:
    def test_the_phase_is_never_pruned_by_effort(self):
        workflow = load_workflow(WORKFLOW)
        for effort in ("none", "low", "medium", "ultrathink"):
            assert resolve_profile(workflow, effort).will_run("ui-design-system")

    def test_the_plan_takes_frontend_phases_off_a_backend_task(self, api_project):
        spec = _spec(api_project, "endpoint", [["Controllers/X.cs"]])
        profile = resolve_profile(load_workflow(WORKFLOW), "high")
        assert profile.will_run("mobile-design")
        assert profile.will_run("ui-design-system")
        narrowed = narrow_to_forecast(profile, planned_files(spec))
        assert not narrowed.will_run("mobile-design")
        assert not narrowed.will_run("ui-design-system")
        assert narrowed.will_run("analyze")  # unconditional phases are untouched

    def test_no_forecast_keeps_the_profile(self):
        profile = resolve_profile(load_workflow(WORKFLOW), "high")
        assert narrow_to_forecast(profile, None) is profile


# ---------------------------------------------------------------------------
# The shared brain: the merged design system, as knowledge
# ---------------------------------------------------------------------------


@pytest.fixture
def brain_env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(home))
    monkeypatch.setenv("WORKPILOT_BRAIN_CONFIG", str(home / "brain.json"))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    monkeypatch.setenv("BRAIN_AUTO_PUSH", "false")
    monkeypatch.setenv("BRAIN_AUTO_PULL", "false")
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "brain"))
    real_which = shutil.which
    monkeypatch.setattr(
        shutil,
        "which",
        lambda name, *a, **k: None if name == "claude" else real_which(name, *a, **k),
    )
    return tmp_path / "brain"


class TestBrain:
    def test_nothing_is_filed_without_a_brain(self, brain_env, react_project):
        from uiux.knowledge import record_merged_design_system

        spec = _spec(react_project, "settings page", [["App.tsx"]])
        run_preflight(react_project, spec)
        assert record_merged_design_system(react_project, spec.name) is None
        assert not brain_env.exists()

    def test_the_merged_design_system_is_knowledge(self, brain_env, react_project):
        from brain import Brain
        from brain.notes import read_note
        from uiux.knowledge import record_merged_design_system

        brain = Brain(brain_env)
        brain.init()
        spec = _spec(react_project, "settings page", [["App.tsx"]])
        run_preflight(react_project, spec)
        rel = record_merged_design_system(react_project, spec.name)
        assert rel and rel.startswith("knowledge/projects/shop/uiux/")
        note = read_note(brain.root, Path(rel))
        assert "uiux" in note.meta["tags"]
        assert "not an instruction" in note.body
        assert not list((brain.root / "instructions").glob("*design*"))
        # Unchanged: not rewritten.
        assert record_merged_design_system(react_project, spec.name) == rel
