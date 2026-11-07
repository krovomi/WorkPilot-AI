"""
AI Architecture Reviewer
==========================

Uses a Claude agent to review git diff for subtle architectural
violations that the deterministic engine cannot catch.
"""

from __future__ import annotations

import json
from pathlib import Path

from foundation.base_branch import detect_base_branch
from foundation.debug import debug, debug_error, debug_warning

from .models import ArchitectureConfig, ArchitectureReport, ArchitectureViolation

# apps/backend/prompts, where every agent's system prompt lives.
_PROMPT_FILE = Path(__file__).parent.parent / "prompts" / "architecture_reviewer.md"


def architecture_reviewer_prompt(
    spec_dir: Path,
    project_dir: Path,
    architecture_rules: str,
    deterministic_report: str,
) -> str:
    """The architecture reviewer's prompt, with the spec's context filled in.

    Built here rather than in ``prompts_pkg``, which the QA loop imports: the
    reviewer's prompt has no other reader.
    """
    prompt = _PROMPT_FILE.read_text(encoding="utf-8")
    prompt = prompt.replace("{{SPEC_DIR}}", str(spec_dir))
    prompt = prompt.replace(
        "{{BASE_BRANCH}}", detect_base_branch(spec_dir, project_dir)
    )
    prompt = prompt.replace("{{PROJECT_DIR}}", str(project_dir))
    prompt = prompt.replace("{{ARCHITECTURE_RULES}}", architecture_rules)
    return prompt.replace("{{DETERMINISTIC_REPORT}}", deterministic_report)


async def run_architecture_ai_review(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    deterministic_report: ArchitectureReport,
    config: ArchitectureConfig,
    verbose: bool = False,
) -> list[ArchitectureViolation]:
    """
    Run AI-powered architecture analysis for subtle violations.

    Uses a Claude agent to review git diff against architectural intent.
    This is a single-shot review pass (no multi-turn conversation).

    Args:
        project_dir: Root directory of the project
        spec_dir: Directory containing the spec files
        model: Model identifier for the AI agent
        deterministic_report: Results from the rules engine (to avoid duplication)
        config: Architecture configuration
        verbose: Enable verbose output

    Returns:
        List of additional ArchitectureViolation objects found by AI.
    """
    # Through the agent_runtime port: the QA loop imports architecture, and
    # core and agents import the QA loop.
    import agent_runtime
    from phase_config import get_phase_thinking_budget

    runtime = agent_runtime.current()
    if runtime is None:
        debug_warning("architecture_ai", "No agent runtime installed")
        return []

    # Serialize config and report for prompt injection
    architecture_rules = _serialize_config(config)
    det_report_str = _serialize_deterministic_report(deterministic_report)

    prompt = architecture_reviewer_prompt(
        spec_dir=spec_dir,
        project_dir=project_dir,
        architecture_rules=architecture_rules,
        deterministic_report=det_report_str,
    )

    # Create agent client
    thinking_budget = get_phase_thinking_budget(spec_dir, "qa")
    try:
        client = runtime.create_agent_client(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=model,
            agent_type="architecture_reviewer",
            max_thinking_tokens=thinking_budget,
        )
    except Exception as e:
        debug_error(
            "architecture_ai", f"Failed to create architecture reviewer client: {e}"
        )
        return []

    # Run the review session
    debug("architecture_ai", "Starting AI architecture review session...")
    try:
        async with client:
            from task_logger import LogPhase

            # The reviewer writes its report to the spec directory, read below;
            # the session's own answer is not used.
            await runtime.run_agent_session(
                client,
                prompt,
                spec_dir,
                verbose=verbose,
                phase=LogPhase.VALIDATION,
            )
    except Exception as e:
        debug_error("architecture_ai", f"AI review session failed: {e}")
        return []

    # Parse the AI output
    violations = _parse_ai_report(spec_dir)
    if not violations:
        debug("architecture_ai", "AI review found no additional violations")

    return violations


def _parse_ai_report(spec_dir: Path) -> list[ArchitectureViolation]:
    """
    Parse the architecture_report.json written by the AI agent.

    Returns violations found by the AI.
    """
    report_path = spec_dir / "architecture_report.json"
    if not report_path.exists():
        return []

    try:
        with open(report_path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return []

    violations = []

    for v_data in data.get("ai_violations", []):
        violations.append(
            ArchitectureViolation(
                type=v_data.get("type", "ai_finding"),
                severity=v_data.get("severity", "warning"),
                file=v_data.get("file", ""),
                line=v_data.get("line"),
                import_target=v_data.get("import_target", ""),
                rule=v_data.get("rule", "AI-detected violation"),
                description=v_data.get("description", ""),
                suggestion=v_data.get("suggestion", ""),
            )
        )

    return violations


def _serialize_config(config: ArchitectureConfig) -> str:
    """Serialize architecture config for prompt injection."""
    parts = [f"Architecture Style: {config.architecture_style}"]

    if config.layers:
        parts.append("\nLayers:")
        for layer in config.layers:
            parts.append(f"  - {layer.name}:")
            parts.append(f"    Patterns: {', '.join(layer.patterns)}")
            if layer.allowed_imports:
                parts.append(
                    f"    Allowed imports from: {', '.join(layer.allowed_imports)}"
                )
            if layer.forbidden_imports:
                parts.append(
                    f"    Forbidden imports from: {', '.join(layer.forbidden_imports)}"
                )

    if config.bounded_contexts:
        parts.append("\nBounded Contexts:")
        for ctx in config.bounded_contexts:
            parts.append(f"  - {ctx.name}:")
            parts.append(f"    Patterns: {', '.join(ctx.patterns)}")
            if ctx.allowed_cross_context_imports:
                parts.append(
                    f"    Allowed cross-context: {', '.join(ctx.allowed_cross_context_imports)}"
                )

    if config.rules.forbidden_patterns:
        parts.append("\nForbidden Patterns:")
        for fp in config.rules.forbidden_patterns:
            parts.append(f"  - From: {fp.from_pattern}")
            parts.append(f"    Import: {fp.import_pattern}")
            if fp.description:
                parts.append(f"    Reason: {fp.description}")

    return "\n".join(parts)


def _serialize_deterministic_report(report: ArchitectureReport) -> str:
    """Serialize deterministic report for prompt injection."""
    if report.passed and not report.warnings:
        return "No violations found by the static rules engine."

    parts = [report.summary]

    if report.warnings:
        parts.append("\nWarnings (static analysis):")
        for w in report.warnings[:10]:
            parts.append(f"  - [{w.type}] {w.file}: {w.description}")
        if len(report.warnings) > 10:
            parts.append(f"  ... and {len(report.warnings) - 10} more warnings")

    return "\n".join(parts)
