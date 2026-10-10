# Agent tool rights

> Design rationale for a rule of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## An agent has the tools it declares

`AGENT_CONFIGS[agent_type]["tools"]` used to be a wish. On the Claude SDK,
`allowed_tools` only *auto-approves*: a tool missing from it stays callable,
and the `.claude_settings.json` `create_client` writes grants `Write`, `Edit`
and `Bash(*)` to every type. Outside the SDK, `get_tool_definitions` offered
`write_file` and `run_command` to everyone, and `ToolExecutor.execute` ran any
name a model sent, offered or not. A `pr_reviewer` reading an untrusted pull
request could write files and run commands on every provider.

A declaration is now a right, on both halves of the product, from one answer —
`agents/tools_pkg/permissions.py`:

| Where | What it does with an undeclared tool |
|---|---|
| `undeclared_builtin_tools(agent_type)` | the guarded built-ins (`Write`; `Edit`, `MultiEdit`, `NotebookEdit` riding on `Edit`; `Bash`; `WebFetch`, `WebSearch`) the type does not declare. Reading is not guarded |
| `create_client`, `create_simple_client` | pass that list as `disallowed_tools`: the tool leaves the model's context, and the denial wins over the settings file's allow rules. `READ_ONLY_AGENT_TYPES` keep `permission_mode="plan"` on top |
| `get_tool_definitions(agent_type)` | offers `write_file`, `Write`, `create_directory` only to a type declaring `Write` or `Edit`, `run_command` only to one declaring `Bash` |
| `ToolExecutor(agent_type=…).execute` | refuses the same tools by name, answering the model with an error rather than raising — the one point that also covers a native `tool_call` nobody offered. Every client passes its `agent_type` |
| `codex_sandbox_for(agent_type)` | `--sandbox read-only` for a type declaring none of `Write`, `Edit`, `Bash`; `workspace-write` otherwise |

A read-only type outside the SDK would have lost all search along with
`run_command`, so the executor gained two read-only tools, offered to a type
declaring `Grep` or `Glob`: `search_files` (a regex over the project's text
files) and `find_files` (a glob). Both stay inside the project, follow no link,
skip `.git`, dependencies, binaries and files over 1 MB, and stop at 200
results.

An unregistered `agent_type` stays permissive on every row: every type the
product passes is registered (`test_every_literal_agent_type_is_registered`),
so an unknown one is a test or an outside caller. The other direction is held
too: `tests/test_agent_tool_declarations.py` reads the prompts and skill bodies
each type is run with and fails when one uses a tool its type does not declare
— a heredoc or a `bash` block needs `Bash`, "the `Write` tool" needs `Write`,
`mcp__context7__` needs the Context7 server. That is how `ideation` came to
declare the `Write` and `Bash` its prompts had always used, under the settings
file's blanket grant.
