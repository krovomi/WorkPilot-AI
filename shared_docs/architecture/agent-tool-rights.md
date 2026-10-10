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
| `codex_sandbox_for(agent_type)` | `--sandbox read-only` for a type declaring none of `Write`, `Edit`, `Bash`; `workspace-write` otherwise. `codex exec resume` has no `--sandbox`, so a resumed thread gets `-c sandbox_mode="…"` |

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

## Outside `create_client`

A declaration only means something where something reads it. Lot L16 closed
the paths that built a session without asking.

**One place builds SDK options.** Eight call sites constructed
`ClaudeAgentOptions` themselves — the insights chat, the voice and natural-
language git runners, the code playground, the Linear updater, the PR
follow-up review. None passed a denial, so the user's and the project's
settings files decided what they could do; an empty `allowed_tools` approves
nothing and refuses nothing. Each now goes through `create_simple_client`
with a registered type (`voice_command`, `git_command`, `code_playground`,
`linear_updater`, `pr_followup_reviewer`, `insights`), and
`tests/test_sdk_options_factories.py` fails on any other construction.

**The simple client serves hookless types only.** It installs none of
`create_client`'s hooks — no command allowlist, no write-path guard, no
guardrails — so it refuses a type that declares `Write`, `Edit` or `Bash`
(`hooked_grants`) before configuring anything. Two paths broke that rule:
`spec_compaction` declared write tools to summarise text in one turn (it now
declares none), and the follow-up planner reached it through
`ClaudeSDKRuntime` with the planner's rights. The planner now plans through
`create_agent_client`, like the first planning session. A simple client
accepts an MCP server only if its type declares it (`linear_updater` declares
`linear`), and approves that server's tools.

**What the SDK checks, checked elsewhere.**

| SDK | Every other provider |
|---|---|
| `bash_security_hook` then the guardrails hook on `Bash` | `ToolExecutor._run_command` asks `security.hooks.command_refusal` — `validate_command_line` on the project's profile, then `guardrails_hook` — and answers the model with the refusal. rtk rewrites only an allowed command, as its hook sits behind those two |
| the guardrails hook on every write tool | `_write_file` asks `guardrail_refusal("Write", …)` before the watermark cleaning |
| a custom MCP server starts if `_validate_custom_mcp_server` accepts it and `get_required_mcp_servers` keeps it for the type (`AGENT_MCP_<type>_ADD`) | `load_mcp_server_configs_for(agent_type, …)` asks both; the bridge used to start every configured server, with a laxer validator, for every type |

**An approval must name a tool the session has.** MCP tools are called
`mcp__<server key>__<tool>`. `LINEAR_TOOLS` said `linear-server` for a server
registered as `linear`, so none of the sixteen approvals matched and every
Linear call was refused in a session with no one to ask.
`TestEveryApprovedMcpToolNamesAServerTheSessionHas` holds the rule on
`create_client`.

**A nudge names the file the session owes.** Copilot's "write now" relaunches
fire for `planner` (told `implementation_plan.json`) and `spec_writer` (told
to write the file its instructions require — its prompts end in different
files). They used to fire for any session with a write tool, telling a coder
to write the plan it was executing.
