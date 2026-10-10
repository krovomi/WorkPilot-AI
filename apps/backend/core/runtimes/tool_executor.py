"""
Tool Executor for Agent Runtime
==============================

Handles execution of tools during agent sessions.
"""

import asyncio
import fnmatch
import json
import logging
import os
import re
import signal
from pathlib import Path
from typing import Any

from rtk import rewrite_command as rtk_rewrite
from watermarks import clean_generated
from watermarks import record as watermarks_record

logger = logging.getLogger(__name__)


def _pick_arg(arguments: dict[str, Any], *names: str, default: Any = None) -> Any:
    """First non-empty value among alias ``names`` (case-insensitive).

    Local models are inconsistent about argument keys — e.g. a shell command may
    arrive as ``command``, ``cmd`` or ``shell_command``; a file's body as
    ``content``, ``Content``, ``CodeContent`` or ``text``. Matching a set of
    aliases (and ignoring case) makes the tools tolerant of those variants
    instead of failing with "X is required".
    """
    if not isinstance(arguments, dict):
        return default
    for name in names:  # exact match first
        value = arguments.get(name)
        if value is not None and value != "":
            return value
    lowered = {k.lower(): v for k, v in arguments.items() if isinstance(k, str)}
    for name in names:  # case-insensitive fallback
        value = lowered.get(name.lower())
        if value is not None and value != "":
            return value
    return default


def _as_bool(value: Any) -> bool:
    """Interpret a tool-arg flag as a bool.

    Local models frequently pass the STRING ``"false"``/``"true"`` (or
    ``"0"``/``"1"``) for boolean flags. Python's ``bool("false")`` is ``True``,
    which would wrongly make ``write_file`` create an EMPTY file. Treat the
    common falsey strings as ``False``.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in ("", "false", "0", "no", "none", "null")
    return bool(value)


#: Executor tool -> the declarations (`AGENT_CONFIGS[...]["tools"]`) that
#: grant it. A tool absent from this table is not gated: reading a file,
#: listing a directory, and the brain, ui-ux and verify tools, which decide
#: their own audience.
#:
#: This is the non-Claude half of `undeclared_builtin_tools`. The executor used
#: to offer `write_file` and `run_command` to every agent type and to run any
#: name a model sent, so a `pr_reviewer` reading a hostile pull request on
#: Copilot, OpenAI or a local model could write files and run commands.
EXECUTOR_GRANTS: dict[str, tuple[str, ...]] = {
    "write_file": ("Write", "Edit"),
    "Write": ("Write", "Edit"),
    "create_directory": ("Write", "Edit"),
    "run_command": ("Bash",),
    "search_files": ("Grep",),
    "find_files": ("Glob",),
}


def executor_may_use(agent_type: str | None, tool_name: str) -> bool:
    """Whether `agent_type` may be offered — and may run — `tool_name`.

    ``None``, or a type nobody registered, is permissive: that is a test or a
    caller outside the product (every product agent_type is registered), and
    the executor built from a bare project directory keeps working as before.
    """
    grants = EXECUTOR_GRANTS.get(tool_name)
    if grants is None or agent_type is None:
        return True
    from agents.tools_pkg.permissions import declared_tools

    declared = declared_tools(agent_type)
    if declared is None:
        return True
    return any(grant in declared for grant in grants)


#: Directories a search never descends into: dependencies, caches and VCS
#: internals, where a match is noise and the walk is most of the cost.
_SEARCH_SKIP_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
    }
)
_SEARCH_MAX_FILE_BYTES = 1_000_000
_SEARCH_MAX_RESULTS = 200
_SEARCH_LINE_CHARS = 300


def _glob_matches(relative: str, pattern: str) -> bool:
    """`fnmatch` on a posix relative path, where `**/x` also names a root `x`."""
    name = relative.rsplit("/", 1)[-1]
    bare = pattern[3:] if pattern.startswith("**/") else None
    return (
        fnmatch.fnmatch(relative, pattern)
        or fnmatch.fnmatch(name, pattern)
        or (bare is not None and fnmatch.fnmatch(relative, bare))
    )


class ToolExecutor:
    """Executes tools for agent sessions."""

    def __init__(
        self,
        project_dir: str,
        working_directory: str | None = None,
        spec_dir: str | Path | None = None,
        agent_type: str | None = None,
    ):
        self.command_timeout = float(os.environ.get("LOCAL_COMMAND_TIMEOUT", "120"))
        # Whose rights `execute` enforces. ``None`` keeps the executor
        # permissive, which is what a bare `ToolExecutor(project_dir)` — the
        # terminal, the tests — has always been.
        self.agent_type = agent_type
        self.project_dir = Path(project_dir).resolve()
        # Only for the watermark ledger, and optional because only a build has
        # one: the terminal and the insights runtimes construct an executor from
        # a project directory alone. Without it the content is still cleaned —
        # what is lost is the record of it, not the cleaning.
        self.spec_dir = Path(spec_dir) if spec_dir else None
        self.working_directory = self.project_dir
        if working_directory is not None:
            self.working_directory = self._resolve_within_project(working_directory)
            if not self.working_directory.is_dir():
                raise ValueError("Tool working directory does not exist")

    def _resolve_within_project(self, path: str) -> Path:
        """Resolve a user-supplied path and reject anything outside project_dir.

        Why: agent-supplied paths can be relative ('../etc/passwd') or absolute
        ('/etc/passwd'). Without this guard, Path / userpath happily escapes
        the sandbox, since Path('/safe') / Path('/etc/x') -> Path('/etc/x').
        """
        candidate = (self.working_directory / path).resolve()
        try:
            candidate.relative_to(self.project_dir)
        except ValueError:
            raise ValueError(f"Path '{path}' is outside the project directory")
        return candidate

    async def execute(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        """
        Execute a tool with the given arguments.

        Args:
            tool_name: Name of the tool to execute
            arguments: Arguments to pass to the tool

        Returns:
            Result of the tool execution
        """
        # Tool dispatch. Argument keys are resolved through alias sets so the
        # varied names local models emit (cmd/command, file_path/path,
        # content/Content/CodeContent, …) all map to the right parameter.
        path_aliases = ("path", "file_path", "filepath", "filename", "file")
        content_aliases = ("content", "CodeContent", "text", "data", "file_text")
        dir_aliases = ("directory", "dir", "folder", "path")
        cmd_aliases = ("command", "cmd", "shell_command", "script", "commandline")
        cwd_aliases = ("cwd", "working_directory", "directory", "dir")

        # The gate sits here, not only in the definitions a client offers:
        # native `tool_calls` are not filtered against what was offered, so a
        # model that names `run_command` would otherwise get it run. Refused as
        # a result, not an exception, so the model reads why and carries on.
        if not executor_may_use(self.agent_type, tool_name):
            logger.info(
                "tool %s refused: agent type %s does not declare it",
                tool_name,
                self.agent_type,
            )
            return (
                f"Tool '{tool_name}' is not available to this agent "
                f"({self.agent_type}): its role does not include it. "
                "Work with the tools you were given."
            )

        if tool_name == "read_file":
            return await self._read_file(_pick_arg(arguments, *path_aliases))
        elif tool_name in ("write_file", "Write"):  # "Write" = planner alias
            return await self._write_file(
                _pick_arg(arguments, *path_aliases),
                _pick_arg(arguments, *content_aliases),
                _as_bool(
                    _pick_arg(
                        arguments, "EmptyFile", "empty_file", "empty", default=False
                    )
                ),
            )
        elif tool_name == "search_files":
            return await self._search_files(
                _pick_arg(arguments, "pattern", "regex", "query"),
                _pick_arg(arguments, *dir_aliases, default="."),
                _pick_arg(arguments, "glob", "include", "file_pattern"),
            )
        elif tool_name == "find_files":
            return await self._find_files(
                _pick_arg(arguments, "pattern", "glob", "name"),
                _pick_arg(arguments, *dir_aliases, default="."),
            )
        elif tool_name == "list_files":
            return await self._list_files(
                _pick_arg(arguments, *dir_aliases, default=".")
            )
        elif tool_name == "run_command":
            return await self._run_command(
                _pick_arg(arguments, *cmd_aliases),
                _pick_arg(arguments, *cwd_aliases),
            )
        elif tool_name == "create_directory":
            return await self._create_directory(_pick_arg(arguments, *dir_aliases))
        elif _is_uiux_tool(tool_name):
            # ui-ux-pro-max: the same tools the Claude SDK reaches over MCP,
            # offered only on a task whose preflight said it is about the UI.
            from uiux.integration import execute_tool as uiux_execute

            return await uiux_execute(tool_name, arguments, self.project_dir)
        elif _is_brain_tool(tool_name):
            # The shared brain: the same tools the Claude SDK reaches over MCP,
            # executed in-process for every other provider.
            from brain.runtime import execute_tool, task_ref

            return await execute_tool(
                tool_name, arguments, task=task_ref(self.project_dir, self.spec_dir)
            )
        elif _is_verify_tool(tool_name):
            # The verification loop's tools: the same ones the Claude SDK
            # reaches over the `workpilot-verify` MCP server, executed here so
            # Copilot, OpenAI, Gemini, Ollama… drive the app identically.
            from verify.tools import execute_tool as execute_verify_tool

            return await execute_verify_tool(
                tool_name,
                arguments,
                project_dir=self.project_dir,
                spec_dir=self.spec_dir,
            )
        else:
            raise ValueError(f"Unknown tool: {tool_name}")

    async def _read_file(self, path: str | None) -> str:
        """Read a file and return its contents."""
        if not path:
            raise ValueError("Path is required for read_file")

        file_path = self._resolve_within_project(path)
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {path}")

        try:
            with open(file_path, encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            raise RuntimeError(f"Error reading file {path}: {e}")

    async def _write_file(
        self, path: str | None, content: str | None = None, empty_file: bool = False
    ) -> str:
        """Write content to a file."""
        if not path:
            raise ValueError("Path is required for write_file")

        file_path = self._resolve_within_project(path)

        # The other half of the product. Providers that do not use the Claude
        # SDK never reach `create_client`'s PreToolUse hooks, so the same
        # cleaning is applied at the one place their writes go through —
        # exactly as `rtk_rewrite` is applied to their shell commands a few
        # lines below. Before the JSON branch, not after: an invisible
        # character inside a string value survives `json.loads` and would be
        # written straight back out by `write_json_atomic`.
        if isinstance(content, str) and content:
            cleaning = clean_generated(content)
            if cleaning.changed:
                content = cleaning.text
                watermarks_record(
                    self.spec_dir,
                    file_path=path,
                    tool="write_file",
                    cleaning=cleaning,
                )

        if file_path.name == "implementation_plan.json":
            return self._write_implementation_plan(file_path, path, content, empty_file)
        file_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with open(file_path, "w", encoding="utf-8") as f:
                if empty_file:
                    # Create empty file
                    pass
                elif content is not None:
                    f.write(content)
                else:
                    # Default content if none provided
                    f.write("")
            return f"Successfully wrote to {path}"
        except Exception as e:
            raise RuntimeError(f"Error writing file {path}: {e}")

    def _write_implementation_plan(
        self,
        file_path: Path,
        path: str,
        content: str | None,
        empty_file: bool,
    ) -> str:
        """The plan, parsed before it replaces the one already there.

        Parsed first because the write is destructive: the plan on disk may be a
        good one from an earlier iteration, and letting an unparseable turn
        overwrite it costs work no later step can get back.

        **What it must not do is refuse the plan the model actually wrote.** A
        local model hands back its JSON inside a ```json fence, or with "Here is
        the plan:" in front of it, far more often than it gets the bare document
        right — and `json.loads` refuses all of it. The content was then dropped
        on the floor: the write never happened, so no file existed for
        `auto_fix_plan` to repair, and the plan was in this tool call rather
        than in the response text, so `recover_plan` had nothing to read either.
        Planning failed three times over a plan WorkPilot had been handed and
        thrown away, reporting "the model did not produce a valid
        implementation_plan.json" — which was not true.

        So the fence and the surrounding prose are stripped here, by the same
        `extract_json_document` the file-repair path uses, and the document is
        written. The shape is left to `normalize_plan_shape` downstream: this
        answers "are these bytes a JSON document", never "is this a good plan".
        Only when there is no document at all does the write fail, and the error
        goes back to the model so it can correct itself in the same session.
        """
        from core.file_utils import write_json_atomic
        from spec.plan_recovery import extract_json_document

        if empty_file:
            # Said plainly rather than through the JSON parser: blanking the
            # plan is never what a planner means, and "expecting value at line
            # 1" is a confusing way to be told so.
            raise ValueError(
                "implementation_plan.json cannot be written empty. The existing "
                "file was not changed. Write the complete JSON plan as `content`."
            )

        raw = content or ""
        salvaged = False
        try:
            plan = json.loads(raw)
        except json.JSONDecodeError as error:
            plan = extract_json_document(raw)
            if plan is None:
                raise ValueError(
                    f"Invalid implementation_plan.json: {error}. "
                    "The existing file was not changed. Write the JSON document "
                    "alone — it must start with '{' and end with '}' — and "
                    "escape quotes inside JSON strings."
                ) from error
            salvaged = True

        # A document that is not an object still goes to disk: a bare `phases`
        # array is a plan `normalize_plan_shape` reshapes, and the validator
        # now reports a non-object rather than crashing on one. Refusing it here
        # is the same mistake as refusing the fence — it loses the only copy.
        write_json_atomic(file_path, plan)
        if salvaged:
            logger.info(
                "implementation_plan.json arrived wrapped in text; wrote the "
                "JSON document it contained (%s)",
                path,
            )
        return f"Successfully wrote to {path}"

    async def _list_files(self, directory: str) -> list[str]:
        """List files in a directory."""
        dir_path = self._resolve_within_project(directory)
        if not dir_path.exists():
            raise FileNotFoundError(f"Directory not found: {directory}")

        try:
            files = []
            for item in dir_path.iterdir():
                if item.is_file():
                    files.append(item.name)
                elif item.is_dir():
                    files.append(item.name + "/")
            return sorted(files)
        except Exception as e:
            raise RuntimeError(f"Error listing files in {directory}: {e}")

    def _walk_files(self, directory: str):
        """(posix path relative to the project, absolute path) of every file
        under `directory`, inside the project, links never followed."""
        root = self._resolve_within_project(directory)
        if not root.is_dir():
            raise FileNotFoundError(f"Directory not found: {directory}")
        for current, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = sorted(
                d
                for d in dirnames
                if d not in _SEARCH_SKIP_DIRS
                and not os.path.islink(os.path.join(current, d))
            )
            for filename in sorted(filenames):
                full = Path(current) / filename
                if full.is_symlink():
                    continue
                yield full.relative_to(self.project_dir).as_posix(), full

    async def _search_files(
        self, pattern: str | None, directory: str = ".", glob: str | None = None
    ) -> str:
        """Lines matching a regular expression — the executor's Grep.

        Read-only by construction, so a reviewer that declares Grep and no
        shell can still search the project it reviews: without it, taking
        `run_command` away would have taken search with it.
        """
        if not pattern:
            raise ValueError("pattern is required for search_files")
        try:
            regex = re.compile(pattern)
        except re.error as e:
            raise ValueError(f"Invalid regular expression {pattern!r}: {e}")
        results: list[str] = []
        for relative, full in self._walk_files(directory):
            if glob and not _glob_matches(relative, glob):
                continue
            try:
                if full.stat().st_size > _SEARCH_MAX_FILE_BYTES:
                    continue
                raw = full.read_bytes()
            except OSError:
                continue
            if b"\0" in raw[:8192]:
                continue  # binary
            text = raw.decode("utf-8", errors="replace")
            for number, line in enumerate(text.splitlines(), start=1):
                if regex.search(line):
                    results.append(f"{relative}:{number}: {line[:_SEARCH_LINE_CHARS]}")
                    if len(results) >= _SEARCH_MAX_RESULTS:
                        results.append(
                            f"(stopped at {_SEARCH_MAX_RESULTS} matches; narrow the "
                            "pattern, the directory or the glob)"
                        )
                        return "\n".join(results)
        return "\n".join(results) if results else "(no matches found)"

    async def _find_files(self, pattern: str | None, directory: str = ".") -> str:
        """Files whose project-relative path matches a glob — the executor's Glob."""
        if not pattern:
            raise ValueError("pattern is required for find_files")
        found: list[str] = []
        for relative, _full in self._walk_files(directory):
            if _glob_matches(relative, pattern):
                found.append(relative)
                if len(found) >= _SEARCH_MAX_RESULTS:
                    found.append(
                        f"(stopped at {_SEARCH_MAX_RESULTS} files; narrow the pattern)"
                    )
                    break
        return "\n".join(found) if found else "(no files found)"

    async def _create_directory(self, path: str | None) -> str:
        """Create a directory (and parents)."""
        if not path:
            raise ValueError("Path is required for create_directory")

        dir_path = self._resolve_within_project(path)
        try:
            dir_path.mkdir(parents=True, exist_ok=True)
            return f"Successfully created directory {path}"
        except Exception as e:
            raise RuntimeError(f"Error creating directory {path}: {e}")

    async def _run_command(self, command: str | None, cwd: str | None = None) -> str:
        """Run a shell command.

        Note: uses subprocess shell mode intentionally so the agent can issue
        composite commands (pipes, redirections) needed by the prompt template.
        The cwd is constrained to project_dir; the command itself is not
        sanitized — callers must ensure the LLM is constrained by the system
        prompt and untrusted output is not relayed back into tool args.
        """
        if not command:
            raise ValueError("Command is required for run_command")

        # rtk — the non-Claude half of the same optimisation the SDK gets from
        # `rtk.hook`. Copilot, Windsurf, OpenAI and the local runtimes all
        # execute their shell commands here, and they pay for the output the
        # same way. The rewrite preserves behaviour and exit code; when rtk is
        # absent or has no filter for this command, `command` comes back
        # unchanged.
        command = rtk_rewrite(command).command

        work_dir = self._resolve_within_project(cwd) if cwd else self.working_directory

        try:
            process = await asyncio.create_subprocess_shell(
                command,
                cwd=str(work_dir),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=os.name != "nt",
            )

            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(), timeout=self.command_timeout
                )
            except (TimeoutError, asyncio.CancelledError) as error:
                await self._stop_command(process)
                if isinstance(error, asyncio.CancelledError):
                    raise
                raise RuntimeError(
                    f"Command exceeded {self.command_timeout:g}s and was terminated. "
                    "Commands must be non-interactive; quote paths containing spaces "
                    "or use read_file for file reads."
                ) from error
            stdout = (
                stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
            )
            stderr = (
                stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""
            )

            if process.returncode != 0:
                # Include both stdout and stderr: many tools (dotnet, msbuild,
                # npm, ...) write their diagnostics to stdout, not stderr.
                combined = ""
                if stdout:
                    combined += stdout
                if stderr:
                    combined += ("\n" if combined else "") + stderr

                # Exit code 1 with no output is the "no matches found" behavior
                # for search tools (findstr, grep, etc.). Return a clear message
                # so the agent knows the pattern was not found.
                if process.returncode == 1 and not combined.strip():
                    return "(no matches found)"

                raise RuntimeError(
                    f"Command failed with code {process.returncode}: {combined}"
                )

            return stdout
        except Exception as e:
            raise RuntimeError(f"Error running command {command}: {e}")

    async def _stop_command(self, process) -> None:
        """Reap the shell and its children when a command times out or is cancelled."""
        if os.name == "nt":
            killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/PID",
                str(process.pid),
                "/T",
                "/F",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                # The command may have exited immediately before cleanup.
                pass
        await process.wait()


def _is_brain_tool(name: str) -> bool:
    try:
        from brain.runtime import is_brain_tool

        return is_brain_tool(name)
    except Exception:  # noqa: BLE001 - an optional store never breaks dispatch
        return False


def _is_uiux_tool(name: str) -> bool:
    try:
        from uiux.integration import is_uiux_tool

        return is_uiux_tool(name)
    except Exception:  # noqa: BLE001 - optional design data never breaks dispatch
        return False


def _uiux_tool_definitions(spec_dir: str | Path | None) -> list[dict[str, Any]]:
    """ui-ux-pro-max's tools, when this task's preflight said it is a UI task."""
    try:
        from uiux.integration import tool_definitions

        return tool_definitions(spec_dir)
    except Exception:  # noqa: BLE001 - optional design data never breaks a session
        return []


def _is_verify_tool(name: str) -> bool:
    try:
        from verify.tools import is_verify_tool

        return is_verify_tool(name)
    except Exception:  # noqa: BLE001 - an optional feature never breaks dispatch
        return False


#: The agent types that drive a verification and get the `verify_*` tools.
VERIFY_AGENT_TYPES = frozenset({"verifier"})


def _verify_tool_definitions(agent_type: str) -> list[dict[str, Any]]:
    if agent_type not in VERIFY_AGENT_TYPES:
        return []
    try:
        from verify.tools import tool_definitions

        return tool_definitions()
    except Exception:  # noqa: BLE001
        return []


def _brain_tool_definitions() -> list[dict[str, Any]]:
    """The shared brain's tools, when a brain exists on this machine."""
    try:
        from brain.runtime import tool_definitions

        return tool_definitions()
    except Exception:  # noqa: BLE001 - an optional store never breaks a session
        return []


def get_tool_definitions(
    agent_type: str, spec_dir: str | Path | None = None
) -> list[dict[str, Any]]:
    """
    Get tool definitions for a specific agent type.

    Args:
        agent_type: Type of agent (e.g., 'coder', 'planner')
        spec_dir: The task's spec directory, when there is one — it decides
            whether the ui-ux-pro-max tools are offered

    Returns:
        List of tool definitions
    """
    # Basic tool definitions - can be extended based on agent type
    base_tools = [
        {
            "name": "read_file",
            "description": "Read a file directly, including paths with spaces. Prefer this over shell cat.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file to read",
                    }
                },
                "required": ["path"],
            },
        },
        {
            "name": "write_file",
            "description": "Write content to a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file to write",
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write to the file",
                    },
                },
                "required": ["path", "content"],
            },
        },
        {
            "name": "list_files",
            "description": "List files in a directory",
            "parameters": {
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "Directory to list files from",
                        "default": ".",
                    }
                },
            },
        },
        {
            "name": "search_files",
            "description": "Search the project's text files for a regular expression. Returns path:line: text for each match. Read-only.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regular expression to search for",
                    },
                    "directory": {
                        "type": "string",
                        "description": "Directory to search in",
                        "default": ".",
                    },
                    "glob": {
                        "type": "string",
                        "description": "Only search files matching this glob, e.g. **/*.py",
                    },
                },
                "required": ["pattern"],
            },
        },
        {
            "name": "find_files",
            "description": "Find files whose path matches a glob, e.g. **/*.cs or src/**/test_*.py. Read-only.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern"},
                    "directory": {
                        "type": "string",
                        "description": "Directory to search in",
                        "default": ".",
                    },
                },
                "required": ["pattern"],
            },
        },
        {
            "name": "run_command",
            "description": "Run a non-interactive shell command with a time limit. Quote paths containing spaces. Use read_file to read files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to run"},
                    "cwd": {
                        "type": "string",
                        "description": "Working directory for the command",
                    },
                },
                "required": ["command"],
            },
        },
    ]

    # Add agent-specific tools
    if agent_type == "coder":
        base_tools.extend(
            [
                {
                    "name": "create_directory",
                    "description": "Create a directory",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "Path to the directory to create",
                            }
                        },
                        "required": ["path"],
                    },
                }
            ]
        )
    elif agent_type in ("planner", "spec_writer"):
        # The spec pipeline runs the planner.md prompt under agent_type
        # "spec_writer" (see spec/pipeline/agent_runner.py). That prompt
        # repeatedly instructs the agent to "use the Write tool" to create
        # implementation_plan.json. Without exposing the "Write" tool here,
        # non-Claude providers (Copilot, Windsurf, ...) only see write_file and
        # never call the tool the prompt asks for, so the plan file is never
        # written and the planning phase fails with "Did not create plan file".
        base_tools.extend(
            [
                {
                    "name": "Write",
                    "description": "Write content to a file (for creating implementation_plan.json)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "file_path": {
                                "type": "string",
                                "description": "Path to the file to write",
                            },
                            "CodeContent": {
                                "type": "string",
                                "description": "Content to write to the file",
                            },
                            "EmptyFile": {
                                "type": "boolean",
                                "description": "Whether to create an empty file",
                                "default": False,
                            },
                        },
                        "required": ["file_path", "CodeContent", "EmptyFile"],
                    },
                },
                {
                    "name": "analyze_project",
                    "description": "Analyze the project structure",
                    "parameters": {"type": "object", "properties": {}},
                },
            ]
        )

    # Every agent type, like `create_client` does for the Claude SDK.
    base_tools.extend(_brain_tool_definitions())
    base_tools.extend(_uiux_tool_definitions(spec_dir))
    # The verifier, like `create_client` gives it the `workpilot-verify` server.
    base_tools.extend(_verify_tool_definitions(agent_type))
    # Only what the type declares (`EXECUTOR_GRANTS`): a reviewer is offered
    # no `write_file` and no `run_command`, and `execute` refuses them too.
    return [tool for tool in base_tools if executor_may_use(agent_type, tool["name"])]
