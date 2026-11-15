"""
Context Discovery Module
=========================

Discovers relevant files and context for the task.
"""

import json
from datetime import datetime
from pathlib import Path


def run_context_discovery(
    project_dir: Path,
    spec_dir: Path,
    task_description: str,
    services: list[str],
) -> tuple[bool, str]:
    """Run context.py script to discover relevant files.

    Args:
        project_dir: Project root directory
        spec_dir: Spec directory
        task_description: Task description string
        services: List of service names involved

    Returns:
        (success, output_message)
    """
    context_file = spec_dir / "context.json"

    if context_file.exists():
        return True, "context.json already exists"

    script_path = project_dir / ".workpilot" / "context.py"
    if not script_path.exists():
        return False, f"Script not found: {script_path}"

    args = [
        sys.executable,
        str(script_path),
        "--task",
        task_description or "unknown task",
        "--output",
        str(context_file),
    ]

    if services:
        args.extend(["--services", ",".join(services)])

    try:
        result = subprocess.run(
            args,
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=300,
        )

        if result.returncode == 0 and context_file.exists():
            # Validate and fix common schema issues
            try:
                with open(context_file, encoding="utf-8") as f:
                    ctx = json.load(f)

                # Check for required field and fix common issues
                if "task_description" not in ctx:
                    # Common issue: field named "task" instead of "task_description"
                    if "task" in ctx:
                        ctx["task_description"] = ctx.pop("task")
                    else:
                        ctx["task_description"] = task_description or "unknown task"

                    with open(context_file, "w", encoding="utf-8") as f:
                        json.dump(ctx, f, indent=2)
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                context_file.unlink(missing_ok=True)
                return False, "Invalid context.json created"

            return True, "Created context.json"
        else:
            return False, result.stderr or result.stdout

    except subprocess.TimeoutExpired:
        return False, "Script timed out"
    except Exception as e:
        return False, str(e)


# Extensions a file named in a task description may carry, across the stacks
# WorkPilot builds (not only Python and TypeScript).
_FILE_SUFFIXES = (
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".cs", ".csproj", ".fs", ".vb", ".java", ".kt", ".kts", ".gradle", ".scala",
    ".go", ".rs", ".rb", ".php", ".swift", ".m", ".dart", ".ex", ".exs",
    ".c", ".h", ".cpp", ".hpp", ".html", ".css", ".scss", ".sql", ".sh", ".ps1",
    ".json", ".md", ".yaml", ".yml", ".toml", ".xml",
)  # fmt: skip


def _files_named_in(task_description: str) -> list[str]:
    """The file paths a task description names, in order, once each."""
    found: list[str] = []
    for word in task_description.split():
        candidate = word.strip("`'\"").rstrip(".,;:!?)(").strip("`'\"")
        if candidate.lower().endswith(_FILE_SUFFIXES) and candidate not in found:
            found.append(candidate)
    return found


def create_minimal_context(
    spec_dir: Path,
    task_description: str,
    services: list[str],
) -> Path:
    """Create minimal context.json when context discovery fails.

    It holds what is known: the task, its services, and the files the task
    names. It used to add files and patterns guessed from keywords ("api",
    "auth", "database", "bdd"...), always Python paths such as
    ``src/api/auth.py``, whatever the project's stack. A guessed list also hid
    the spec writer's "minimal context" guidance, which shows only when
    ``files_to_modify`` is empty, so a C# task asking for an API endpoint was
    specified against Python files that did not exist.
    """
    context_file = spec_dir / "context.json"

    minimal_context = {
        "task_description": task_description or "unknown task",
        "scoped_services": list(services),
        "files_to_modify": _files_named_in(task_description or ""),
        "files_to_reference": [],
        "patterns": {},
        "created_at": datetime.now().isoformat(),
        "fallback_mode": True,  # Flag to indicate this is fallback context
    }

    with open(context_file, "w", encoding="utf-8") as f:
        json.dump(minimal_context, f, indent=2)

    return context_file
