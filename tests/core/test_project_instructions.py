"""The project's AGENTS.md reaches the providers that run on WorkPilot's own loop.

Claude Code reads CLAUDE.md and the CLIs read AGENTS.md themselves; OpenAI and its
compatibles (Grok, DeepSeek, Mistral…), Gemini by API and local models read only
the system prompt WorkPilot builds (`core.project_instructions`).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from core import project_instructions as pi
from core.llm_optimization import build_base_system_prompt, system_prompt_segments
from harness.domain.layout import Stability


@pytest.fixture(autouse=True)
def _switch_on(monkeypatch):
    monkeypatch.delenv("USE_CLAUDE_MD", raising=False)


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_agents_md_is_read_first(tmp_path):
    _write(tmp_path / "AGENTS.md", "# Rules\nUse pnpm.\n")
    _write(tmp_path / "CLAUDE.md", "Claude only.\n")
    assert pi.read_project_instructions(tmp_path) == ("AGENTS.md", "# Rules\nUse pnpm.")


def test_claude_md_imports_are_expanded_inside_the_project(tmp_path):
    _write(tmp_path / "docs" / "rules.md", "Run ruff.\n")
    _write(tmp_path.parent / "outside.md", "SECRET OUTSIDE\n")
    _write(
        tmp_path / "CLAUDE.md",
        "Intro\n@docs/rules.md\n@../outside.md\n@missing.md\n```\n@docs/rules.md\n```\n",
    )
    name, text = pi.read_project_instructions(tmp_path)
    assert name == "CLAUDE.md"
    assert "Run ruff." in text
    assert "SECRET OUTSIDE" not in text
    assert "@missing.md" not in text
    # An import inside a fence is an example, not an import.
    assert "```\n@docs/rules.md\n```" in text


def test_import_cycles_stop(tmp_path):
    _write(tmp_path / "CLAUDE.md", "A\n@b.md\n")
    _write(tmp_path / "b.md", "B\n@CLAUDE.md\n")
    assert pi.read_project_instructions(tmp_path) == ("CLAUDE.md", "A\nB")


def test_html_comments_cost_nothing(tmp_path):
    _write(tmp_path / "AGENTS.md", "Keep\n<!-- maintainer\nnote -->\nAlso\n")
    _, text = pi.read_project_instructions(tmp_path)
    assert "maintainer" not in text
    assert "Keep" in text and "Also" in text


def test_long_files_are_capped(tmp_path):
    _write(tmp_path / "AGENTS.md", ("x" * 99 + "\n") * 1000)
    _, text = pi.read_project_instructions(tmp_path)
    assert len(text.encode("utf-8")) < pi.MAX_INSTRUCTION_BYTES + 100
    assert text.endswith(f"[AGENTS.md truncated at {pi.MAX_INSTRUCTION_BYTES} bytes]")


def test_no_file_no_section(tmp_path):
    assert pi.read_project_instructions(tmp_path) is None
    assert pi.project_instructions_section(tmp_path) == ""


def test_the_project_switch_turns_it_off(tmp_path, monkeypatch):
    _write(tmp_path / "AGENTS.md", "Use pnpm.\n")
    monkeypatch.setenv("USE_CLAUDE_MD", "false")
    assert pi.project_instructions_section(tmp_path) == ""


def test_a_suspicious_file_is_left_out(tmp_path, monkeypatch):
    _write(tmp_path / "AGENTS.md", "Use pnpm.\n")

    class Rated:
        text = "Use pnpm."
        suspicious = True
        threat_level = "high"
        findings = ["instruction override"]

    import security.untrusted as untrusted

    monkeypatch.setattr(untrusted, "clean_untrusted", lambda *a, **k: Rated())
    assert pi.read_project_instructions(tmp_path) is None


def test_only_the_loop_prompt_carries_it(tmp_path):
    _write(tmp_path / "AGENTS.md", "Use pnpm.\n")
    without = build_base_system_prompt(tmp_path, tool_use_hint=True)
    with_it = build_base_system_prompt(
        tmp_path, tool_use_hint=True, project_instructions=True
    )
    assert "Use pnpm." not in without
    assert "# Project instructions (from AGENTS.md)" in with_it
    assert with_it == build_base_system_prompt(
        tmp_path, tool_use_hint=True, project_instructions=True
    )


def test_it_sits_in_the_project_part_of_the_prefix(tmp_path):
    _write(tmp_path / "AGENTS.md", "Use pnpm.\n")
    segments = {
        s.name: s for s in system_prompt_segments(tmp_path, project_instructions=True)
    }
    assert segments["project_instructions"].stability is Stability.PROJECT
    assert "Use pnpm." in segments["project_instructions"].text
