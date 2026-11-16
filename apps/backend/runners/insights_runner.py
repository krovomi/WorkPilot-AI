#!/usr/bin/env python3
"""
Insights Runner - AI chat about a codebase, on the project's provider

The app asks a question (with the conversation so far); the runner answers on
stdout, line by line, with the markers the app reads: ``__TOOL_START__`` and
``__TOOL_END__`` around each tool, ``__EXPLANATION__`` in Learning Mode, and a
``__TASK_SUGGESTION__`` the model writes itself. Every provider goes through
``create_agent_client``. A chat that cannot be answered says why on stderr
and exits with 1: the app shows that, never a made-up answer.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

# Add auto-claude to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Validate platform-specific dependencies BEFORE any imports that might
# trigger a pywintypes import (the MCP library imports win32api; ACS-253)
from cli.utils import import_dotenv
from core.dependency_validator import validate_platform_dependencies
from foundation.debug import debug, debug_error, debug_section, debug_success
from learning import ExplanationLevel, LearningMode, LearningModeConfig
from phase_config import get_thinking_budget, resolve_model_id

validate_platform_dependencies()

# Load .env file with centralized error handling
load_dotenv = import_dotenv()

env_file = Path(__file__).parent.parent.parent.parent / ".env-files" / ".env"
if env_file.exists():
    load_dotenv(env_file)


def _read_json(path: Path) -> dict | None:
    """A JSON object from a .workpilot file, or None if it is missing or unreadable."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def load_project_context(project_dir: str) -> str:
    """Load project context for the AI."""
    context_parts = []
    workpilot = Path(project_dir) / ".workpilot"

    # Project index (from .workpilot - the installed instance)
    index = _read_json(workpilot / "project_index.json")
    if index is not None:
        services = index.get("services")
        summary = {
            "project_root": index.get("project_root", ""),
            "project_type": index.get("project_type", "unknown"),
            "services": list(services) if isinstance(services, dict) else [],
            "infrastructure": index.get("infrastructure", {}),
        }
        context_parts.append(
            f"## Project Structure\n```json\n{json.dumps(summary, indent=2)}\n```"
        )

    roadmap = _read_json(workpilot / "roadmap" / "roadmap.json")
    features = roadmap.get("features") if roadmap is not None else None
    if isinstance(features, list):
        feature_summary = [
            {"title": f.get("title", ""), "status": f.get("status", "")}
            for f in features[:10]
            if isinstance(f, dict)
        ]
        context_parts.append(
            f"## Roadmap Features\n```json\n{json.dumps(feature_summary, indent=2)}\n```"
        )

    # Existing tasks
    try:
        task_names = sorted(
            d.name for d in (workpilot / "specs").iterdir() if d.is_dir()
        )
    except OSError:
        task_names = []
    if task_names:
        context_parts.append(
            "## Existing Tasks/Specs\n- " + "\n- ".join(task_names[:10])
        )

    return (
        "\n\n".join(context_parts)
        if context_parts
        else "No project context available yet."
    )


def build_system_prompt(project_dir: str) -> str:
    """Build the system prompt for the insights agent."""
    context = load_project_context(project_dir)

    return f"""You are an AI assistant helping developers understand and work with their codebase.
You have access to the following project context:

{context}

Your capabilities:
1. Answer questions about the codebase structure, patterns, and architecture
2. Suggest improvements, features, or bug fixes based on the code
3. Help plan implementation of new features
4. Provide code examples and explanations

When the user asks you to create a task, wants to turn the conversation into a task, or when you believe creating a task would be helpful, output a task suggestion in this exact format on a SINGLE LINE:
__TASK_SUGGESTION__:{{"title": "Task title here", "description": "Detailed description of what the task involves", "metadata": {{"category": "feature", "complexity": "medium", "impact": "medium"}}}}

Valid categories: feature, bug_fix, refactoring, documentation, security, performance, ui_ux, infrastructure, testing
Valid complexity: trivial, small, medium, large, complex
Valid impact: low, medium, high, critical

Be conversational and helpful. Focus on providing actionable insights and clear explanations.
Keep responses concise but informative."""


def _build_full_prompt(message: str, history: list) -> str:
    """Build the prompt from the latest message + prior conversation."""
    conversation_context = ""
    for msg in history[:-1]:  # Exclude the latest message
        if not isinstance(msg, dict):
            continue
        role = "User" if msg.get("role") == "user" else "Assistant"
        conversation_context += f"\n{role}: {msg.get('content', '')}\n"
    if conversation_context.strip():
        return f"""Previous conversation:
{conversation_context}

Current question: {message}"""
    return message


_LEVELS = {
    "beginner": ExplanationLevel.BEGINNER,
    "intermediate": ExplanationLevel.INTERMEDIATE,
    "advanced": ExplanationLevel.ADVANCED,
    "expert": ExplanationLevel.EXPERT,
}


def _init_learning_mode(enabled: bool, explanation_level: str) -> LearningMode | None:
    """Learning Mode at the chosen level, or None when it is off."""
    if not enabled:
        return None
    level = _LEVELS.get(explanation_level, ExplanationLevel.INTERMEDIATE)
    return LearningMode(LearningModeConfig(enabled=True, explanation_level=level))


def _tool_input(inp: object) -> str:
    """What a tool works on, as the app shows it beside the tool's name."""
    if not isinstance(inp, dict):
        return ""
    if "pattern" in inp:
        return f"pattern: {inp['pattern']}"
    if "file_path" in inp:
        # The whole path, so the app shows exactly which file is read.
        fp = str(inp["file_path"])
        return ("..." + fp[-1997:]) if len(fp) > 2000 else fp
    if "path" in inp:
        return str(inp["path"])
    return ""


def _explain(learning_mode: LearningMode, tool_name: str, tool_input: str) -> None:
    """Learning Mode's explanation of a tool call, as an ``__EXPLANATION__`` line."""
    explanation = learning_mode.explain_tool_use(
        tool_name=tool_name,
        tool_input={"input": tool_input} if tool_input else {},
        reason="Exploring codebase to answer user question",
        expected_outcome="Find relevant information",
    )
    if explanation:
        explanation_json = json.dumps(
            {
                "category": explanation.category,
                "title": explanation.title,
                "explanation": explanation.explanation,
                "difficulty": explanation.difficulty.value,
            }
        )
        print(f"__EXPLANATION__:{explanation_json}", flush=True)


def _record_usage(
    client: object, spec_dir: Path, project_path: Path, model: str, provider: str
) -> None:
    """What the chat cost, in the same usage view as the builds (best effort)."""
    usage = getattr(client, "last_usage", None)
    if not isinstance(usage, dict):
        return
    try:
        from core.usage_tracker import record_session_usage

        record_session_usage(
            spec_dir=spec_dir,
            project_dir=project_path,
            phase="insights",
            agent_type="insights",
            model=resolve_model_id(model) or model,
            provider=provider,
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cost_usd=usage.get("cost_usd", 0.0),
            cache_creation_input_tokens=usage.get("cache_creation_input_tokens", 0),
            cache_read_input_tokens=usage.get("cache_read_input_tokens", 0),
        )
    except Exception as exc:  # usage is bookkeeping: the answer is already out
        debug_error("insights_runner", f"usage tracking skipped: {exc}")


async def run_chat(
    project_dir: str,
    message: str,
    history: list,
    model: str = "sonnet",  # Shorthand - resolved via API Profile if configured
    thinking_level: str = "medium",
    learning_mode_enabled: bool = False,
    explanation_level: str = "intermediate",
) -> None:
    """Answer one chat turn on the project's provider, streaming to stdout.

    Raises when the turn cannot be answered (no client, no sign-in, the
    provider failing): the caller reports it. The chat never moves to another
    provider than the one the project uses.
    """
    from core.agent_client import ContentBlockType
    from core.client import create_agent_client, peek_active_provider

    project_path = Path(project_dir).resolve()
    # Peeked: a chat turn is not the session a "resume with X" was for.
    provider = peek_active_provider(project_path)
    learning_mode = _init_learning_mode(learning_mode_enabled, explanation_level)

    # Usage is recorded against a spec folder; a chat has none of its own.
    spec_dir = project_path / ".workpilot" / "insights"
    try:
        spec_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        spec_dir = project_path

    debug("insights_runner", "Answering", provider=provider, model=model)
    client = create_agent_client(
        project_dir=project_path,
        spec_dir=spec_dir,
        model=resolve_model_id(model),
        agent_type="insights",
        max_thinking_tokens=get_thinking_budget(thinking_level),
        provider=provider,
        system_prompt=build_system_prompt(project_dir),
        # A chat answers by itself, with the read tools its type declares.
        use_subagents=False,
    )

    ends_with_newline = True
    current_tool = None
    async with client:
        await client.query(_build_full_prompt(message, history))
        async for msg in client.receive_response():
            for block in getattr(msg, "content", None) or []:
                btype = getattr(block, "type", None)
                if btype == ContentBlockType.TEXT and getattr(block, "text", None):
                    print(block.text, flush=True)
                    ends_with_newline = block.text.endswith("\n")
                elif btype == ContentBlockType.TOOL_USE:
                    tool_name = getattr(block, "tool_name", "") or ""
                    tool_input = _tool_input(getattr(block, "tool_input", None))
                    current_tool = tool_name
                    marker = json.dumps({"name": tool_name, "input": tool_input})
                    print(f"__TOOL_START__:{marker}", flush=True)
                    if learning_mode:
                        _explain(learning_mode, tool_name, tool_input)
                elif btype == ContentBlockType.TOOL_RESULT and current_tool:
                    marker = json.dumps({"name": current_tool})
                    print(f"__TOOL_END__:{marker}", flush=True)
                    current_tool = None

    if not ends_with_newline:
        print()
    _record_usage(client, spec_dir, project_path, model, provider)


def _load_history(args: argparse.Namespace) -> list:
    """The conversation so far, from --history-file or --history; [] if unreadable."""
    try:
        if args.history_file:
            with open(args.history_file, encoding="utf-8") as f:
                history = json.load(f)
        else:
            history = json.loads(args.history)
    except (ValueError, OSError) as e:
        debug_error("insights_runner", f"Failed to load history: {e}")
        return []
    return history if isinstance(history, list) else []


def main() -> int:
    parser = argparse.ArgumentParser(description="Insights AI Chat Runner")
    parser.add_argument("--project-dir", required=True, help="Project directory path")
    parser.add_argument("--message", required=True, help="User message")
    parser.add_argument("--history", default="[]", help="JSON conversation history")
    parser.add_argument(
        "--history-file", help="Path to JSON file containing conversation history"
    )
    parser.add_argument(
        "--model",
        default="sonnet",
        help="Model to use (haiku, sonnet, opus, or full model ID)",
    )
    parser.add_argument(
        "--thinking-level",
        default="medium",
        choices=["none", "low", "medium", "high", "ultrathink"],
        help="Thinking level for extended reasoning (default: medium)",
    )
    parser.add_argument(
        "--learning-mode",
        action="store_true",
        help="Enable Learning Mode to get detailed explanations of AI actions",
    )
    parser.add_argument(
        "--explanation-level",
        default="intermediate",
        choices=["beginner", "intermediate", "advanced", "expert"],
        help="Level of detail for Learning Mode explanations (default: intermediate)",
    )
    args = parser.parse_args()

    debug_section("insights_runner", "Starting Insights Chat")
    debug(
        "insights_runner",
        "Arguments",
        project_dir=args.project_dir,
        message_length=len(args.message),
        model=args.model,
        thinking_level=args.thinking_level,
        learning_mode=args.learning_mode,
        explanation_level=args.explanation_level,
    )
    try:
        asyncio.run(
            run_chat(
                args.project_dir,
                args.message,
                _load_history(args),
                args.model,
                args.thinking_level,
                args.learning_mode,
                args.explanation_level,
            )
        )
    except Exception as e:  # every failure ends as the one line the app shows
        print(f"Insights could not answer: {e}", file=sys.stderr)
        return 1
    debug_success("insights_runner", "Query completed")
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
