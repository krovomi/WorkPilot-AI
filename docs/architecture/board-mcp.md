# The board as an MCP server

Plan of 29 October, IA5. WorkPilot's board lived only in the desktop window.
A person working in a terminal with Claude Code, Codex or Gemini CLI could not
ask "what is on the board", add a card from there, or wait for a build to be
ready for review. `workpilot-board` is the Kanban of one project, served over
MCP to any agent that speaks it.

## Starting it

`apps/backend/runners/board_mcp.py`, stdio, one project per process:

```bash
claude mcp add workpilot-board -- python <WorkPilot>/apps/backend/runners/board_mcp.py --project-dir <project>
```

Without `--project-dir`, the project is `WORKPILOT_BOARD_ROOT`, then the
working directory, which is where an agent's MCP configuration usually starts
a server. The runner installs the log redaction first, as every entry point
does (`tests/test_entrypoints_redaction.py`).

## The tools

`apps/backend/board_mcp/server.py`:

| Tool | Reads or writes |
|---|---|
| `list_cards(column?)` | each card's id, title, column, kind; newest first, 100 at most |
| `get_card(card_id)` | the card's description, subtasks done, QA verdict, goal, verification and cross review, scalars only |
| `create_card(title, description?, kind?)` | a new card in the backlog |
| `wait_for_card(card_id, columns?, timeout_seconds?)` | the card once it reaches a column (`human_review` by default), or as it is when time runs out (1 hour by default, 4 at most) |

The column is the board's: `implementation_plan.json`'s `status` mapped as
`apps/frontend/src/main/project-store.ts` maps it. An unknown status reads as
backlog, where the board shows it.

## What it does not do

There is no tool to start a build, approve a plan, or merge. The plan of
29 October listed "approve a plan"; it is left out on purpose. The agent
that would call it is the one a plan is shown to a person for: an agent in a
terminal that can approve its own plan will. Those steps stay on the card, or
on the one-time link of [needs-you.md](needs-you.md), where a person makes
them. A tool that does not exist cannot be asked for by a prompt, an issue or
a card description.

A created card does not start either. It lands in the backlog, and the person
starts it from the board.

## Paths, ids and text

- No tool takes a path. The project is fixed when the server starts.
- A card id must match `^\d{3,4}-[a-z0-9][a-z0-9-]{0,80}$` and resolve (links
  followed) to a directory directly under `.workpilot/specs`. Anything else is
  "no such card", with no detail on why.
- A new card's title and description lose their control characters and are
  bounded (200 and 20,000 characters). The title is one line.
- What a card says goes back as data: its description is what a person or an
  issue wrote. The server's instructions say so to the client.

## Creating a card

`create_card` writes the files the automations write
(`apps/frontend/src/main/automations/cards.ts`): `requirements.json`,
`task_metadata.json` with `sourceType: "mcp"`, and an `implementation_plan.json`
with status `pending` and no phases. A kind given by the caller is recorded as
the user's (`kindSource: "user"`), so the classifier keeps it; without one, the
classifier decides as for any card.

The number comes from `core.workspace.models.SpecNumberLock`: the same lock
file the desktop app takes (`spec-number-lock.ts`), and the same scan of the
project and its worktrees. A card created from the terminal while the app
creates another never gets the same number. A lock held too long is an error
the caller can retry, not a hang.

## Waiting is a task

`wait_for_card` is the server's one long tool. To a client that declares the
MCP Tasks extension it comes back as a task, polled and cancellable
([mcp-2026.md](mcp-2026.md)); to any other client it answers when the wait
ends, as before. It reads the card every 5 seconds; the card is files on disk,
there is nothing to subscribe to.

## Limits

- One project per server process. A person with several projects adds one
  server per project.
- The server reads and writes the board's files; it does not talk to the
  running desktop app. The app sees a new card the next time it reads the
  project, as it sees the automations' cards.
- No tool reads a card's logs or diff. `get_card` is a summary; the card in the
  app is the detail.

Tests: `pytest tests/board_mcp -q`.
