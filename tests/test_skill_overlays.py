"""Tests for provider overlays on a skill body (`skills_registry.overlays`).

One skill, read by every provider, specialised where — and only where — the
provider changes what the procedure can do. The rules pinned here:

* the family comes from `capabilities/providers.yaml`, so a provider added
  there is classified without anyone touching a skill;
* a provider without an adapter inherits what it degrades to;
* merging replaces a section, appends a new one, or extends one marked
  ``<!-- append -->`` — never patches a line;
* a heading inside a code fence is not a section.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.overlays import (  # noqa: E402
    EXECUTOR_FAMILY,
    SDK_FAMILY,
    merge_sections,
    overlay_chain,
    provider_family,
    resolve_skill_body,
    resolve_skill_file,
)

BASE = """Intro line.

## Launch

Start the app.

## Browser

Use any browser you have.

```md
## Not a section
```

## Report

Say what happened.
"""


class TestFamily:
    def test_claude_and_aliases_are_sdk(self):
        assert provider_family("claude") == SDK_FAMILY
        assert provider_family("anthropic") == SDK_FAMILY
        assert provider_family(None) == SDK_FAMILY

    def test_tool_executor_adapters(self):
        for name in ("openai", "google", "ollama", "copilot", "windsurf", "mistral"):
            assert provider_family(name) == EXECUTOR_FAMILY, name

    def test_no_adapter_follows_degradation(self):
        # aws/custom have no adapter and degrade to claude: the SDK runs.
        assert provider_family("aws") == SDK_FAMILY
        assert provider_family("custom") == SDK_FAMILY

    def test_chain_inherits_through_degrades_to(self):
        assert overlay_chain("aws") == [SDK_FAMILY, "claude", "aws"]
        assert overlay_chain("ollama") == [EXECUTOR_FAMILY, "ollama"]
        assert overlay_chain(None) == [SDK_FAMILY, "claude"]
        assert overlay_chain("gemini") == [EXECUTOR_FAMILY, "google"]


class TestMerge:
    def test_same_heading_replaces(self):
        out = merge_sections(BASE, "## Browser\n\nUse verify_browser.\n")
        assert "Use verify_browser." in out
        assert "Use any browser you have." not in out
        # Order of the base is kept.
        assert out.index("## Launch") < out.index("## Browser") < out.index("## Report")

    def test_heading_match_is_case_and_space_insensitive(self):
        out = merge_sections(BASE, "##   browser  \n\nOverridden.\n")
        assert "Overridden." in out and "any browser" not in out

    def test_new_heading_is_appended(self):
        out = merge_sections(BASE, "## Limits\n\nNo MCP here.\n")
        assert out.rstrip().endswith("No MCP here.")
        assert "Use any browser you have." in out

    def test_append_marker_extends(self):
        out = merge_sections(BASE, "## Launch\n<!-- append -->\nThen wait.\n")
        launch = out[out.index("## Launch") : out.index("## Browser")]
        assert "Start the app." in launch and "Then wait." in launch
        assert "<!-- append -->" not in out

    def test_fenced_heading_is_not_a_section(self):
        out = merge_sections(BASE, "## Not a section\n\nX\n")
        # The fenced line stayed in the Browser section, and the overlay
        # heading was appended as a new section.
        assert out.count("## Not a section") == 2

    def test_overlay_preamble_kept(self):
        out = merge_sections(BASE, "Read this first.\n\n## Report\n\nShort.\n")
        assert out.index("Intro line.") < out.index("Read this first.")


class TestResolve:
    def _skill(self, tmp_path: Path) -> Path:
        skill = tmp_path / "verify"
        (skill / "providers").mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: verify\ndescription: d\n---\n" + BASE, encoding="utf-8"
        )
        (skill / "providers" / "_executor.md").write_text(
            "---\nextends: verify\n---\n## Browser\n\nUse verify_browser.\n",
            encoding="utf-8",
        )
        (skill / "providers" / "ollama.md").write_text(
            "## Browser\n<!-- append -->\nOne action per step.\n", encoding="utf-8"
        )
        (skill / "providers" / "_sdk.md").write_text(
            "## Browser\n\nUse mcp__chrome-devtools__*.\n", encoding="utf-8"
        )
        return skill

    def test_no_overlay_dir_is_the_base(self, tmp_path):
        skill = tmp_path / "plain"
        skill.mkdir()
        (skill / "SKILL.md").write_text(
            "---\nname: plain\n---\nBody.\n", encoding="utf-8"
        )
        body, applied = resolve_skill_body(skill, "ollama")
        assert body.strip() == "Body." and applied == ()

    def test_family_then_provider(self, tmp_path):
        body, applied = resolve_skill_body(self._skill(tmp_path), "ollama")
        assert applied == (EXECUTOR_FAMILY, "ollama")
        assert "Use verify_browser." in body
        assert "One action per step." in body
        assert "mcp__chrome-devtools" not in body

    def test_sdk_family_for_claude(self, tmp_path):
        body, applied = resolve_skill_body(self._skill(tmp_path), "claude")
        assert applied == (SDK_FAMILY,)
        assert "mcp__chrome-devtools" in body

    def test_provider_without_file_gets_its_family(self, tmp_path):
        body, applied = resolve_skill_body(self._skill(tmp_path), "openai")
        assert applied == (EXECUTOR_FAMILY,)
        assert "One action per step." not in body

    def test_overlay_for_another_skill_is_ignored(self, tmp_path):
        skill = self._skill(tmp_path)
        (skill / "providers" / "openai.md").write_text(
            "---\nextends: other\n---\n## Report\n\nHijacked.\n",
            encoding="utf-8",
        )
        body, applied = resolve_skill_body(skill, "openai")
        assert "Hijacked." not in body and "openai" not in applied

    def test_metadata_is_the_base_frontmatter(self, tmp_path):
        resolved = resolve_skill_file(self._skill(tmp_path) / "SKILL.md", "ollama")
        assert resolved.meta["name"] == "verify"
        assert resolved.specialised


class TestRealSkill:
    def test_verify_skill_resolves_for_every_listed_provider(self):
        skill = REPO_ROOT / "skills" / "tooling" / "verify"
        if not skill.is_dir():  # pragma: no cover - before the skill exists
            return
        for provider in (
            "claude",
            "copilot",
            "openai",
            "google",
            "ollama",
            "windsurf",
            "mistral",
            "aws",
        ):
            body, applied = resolve_skill_body(skill, provider)
            assert "## Report" in body, provider
            assert applied, provider
