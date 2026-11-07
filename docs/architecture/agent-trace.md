# Agent Trace: who wrote each line of a task

> Rationale for `apps/backend/agent_trace/`. The normative summary is the row in
> [`docs/CLAUDE.md`](../CLAUDE.md); where the two disagree, `docs/CLAUDE.md` wins.

## Why

A reviewer, an auditor or a team policy ("a human re-reads a PR above N % of AI code") needs to
know which part of a PR an agent wrote, and with which model, file by file, in a format other
tools read. [Agent Trace](https://github.com/cursor/agent-trace) (v0.1, RFC, CC BY 4.0) is that
format: a *trace record* lists files, each with conversations and the line ranges they wrote,
each with a contributor (`ai`, `human`, `mixed`, `unknown`) and a `model_id` (`provider/model`).

## Git is the source of truth, not a hook

CLI agents (OpenCode, Codex, pi, Gemini over ACP, Antigravity) write their files themselves:
neither the Claude SDK hook nor `tool_executor` sees them. Every coder session's work still ends
up between two commits, so the record is built from `git diff -U0 commit_before commit_after`:
the new-side line ranges, whatever the provider.

| Step | Where | What |
|---|---|---|
| Session start | `session_start` (replaces `get_latest_commit` in `agents/coder.py`) | `HEAD`, and the hash of every line the person left uncommitted (`memory/agent_trace_start.json`) |
| Tool writes | `note_tool_write` from `watermarks/hook.py` and `tool_executor._write_file` | which files a Write/Edit touched this session (`memory/agent_trace_writes.jsonl`) |
| Session end | `after_session` from `post_session_processing` | one record appended to `agent-trace.jsonl` (both spec copies), then `agent-trace-summary.json` |

- A line the person left uncommitted before the session is `human`; the rest of the commit is
  `ai`, with the session's `provider/model`.
- On the SDK paths, a file changed in the commit without a Write/Edit was produced by a command
  the agent ran (a formatter, a generator): still the agent's, listed under
  `metadata["ai.workpilot"].post_processing_files`. A CLI session has no such note.
- `version` is `"0.1"`: the schema's pattern is `^[0-9]+\.[0-9]+$`, while the spec's appendix
  example writes `"0.1.0"`. The schema wins.
- `vcs.revision` is the commit; WorkPilot's own fields (spec, subtask, session, base) go under
  `metadata["ai.workpilot"]`.

## Ranges that move, ranges that change

Each range carries a `content_hash` (`sha256:` of its lines without trailing whitespace). The
summary takes the task's final diff and looks for each recorded range in the file at `HEAD`: at
its place first, then anywhere in the file (a rebase or an import added above moves it). A range
no longer found intact (rewritten in review, changed by a later commit) counts for nobody: its
lines are `unknown`, never guessed. Newer records win over older ones on the same lines.

`mixed` is not produced yet: a retouch is seen as the range disappearing, not as a blend.

## Where it shows

- The diff view of the task: an "AI n %" badge per file and the task's share with its models.
- The PR body (GitHub, GitLab, Azure DevOps, and the preview): one line, for example
  "87 % of the 412 added lines come from the agent (`anthropic/claude-sonnet-5-5`)".

## What never goes in a record

No prompt, no code: paths, line numbers, hashes and the model's name only. The conversation
`url` is left out (rule 5, as in `genai_trace/`). Collection is passive: no agent gets a new tool
(rule 2). The ledger is append-only and capped at 2 MiB like `watermarks.jsonl`; a full ledger, a
read-only disk or a git error drops the record and never fails a build.

## Not covered yet

QA fixer sessions are not recorded: their commits count as `unknown`. Exporting the records as
git notes when the PR is opened, so the attribution follows the repository, is the next step.
