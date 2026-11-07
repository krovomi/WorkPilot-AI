# Steering a running task

> Rationale for `foundation/steering.py`. The normative summary is the row in
> [`docs/CLAUDE.md`](../CLAUDE.md); where the two disagree, `docs/CLAUDE.md` wins.

## Why

A task that went the wrong way used to cost a pause, a resume and a subtask
done again: `HUMAN_INPUT.md` (`foundation/human_input.py`) is only written when
the build is stopped. The steering queue takes a message at any time, while
the agent works, and the orchestrator puts it into the prompt of the **next**
session it applies to.

## Who writes the queue

`steering.jsonl` lives in the spec directory. It is an **append-only log of
events**, never rewritten, because two processes write it at the same time:
the desktop app's main process adds messages while the backend marks them
delivered. One `os.write` of whole lines in `O_APPEND` mode puts another
writer's line before or after, never inside.

```
{"type": "message",   "id", "text", "created_at", "source", "target_subtask_id"}
{"type": "delivered", "id", "at", "session", "subtask_id"}
```

| Writer | Entry point | Source |
|---|---|---|
| Desktop app (local task) | `task:steeringSend` → `steering-handlers.ts` | `desktop` |
| Desktop app (server card) | `POST /api/board/cards/{id}/steering` | `server` |
| Mobile app | the same route | `mobile` |
| CLI | `python run.py --spec 001 --steer "…" [--steer-subtask subtask-2-1]` | `cli` |
| Backend | `mark_delivered` once a session ran | — |

Like `HUMAN_INPUT.md`, the file is written in **every** copy of the spec
directory (the project's and the worktree's): the coder reads the worktree's,
but a resume replaces it from the project's. Reading takes the union of the
copies by message id, so a line written in one copy only still counts.

## Delivery is the orchestrator's word

A message reaches:

- the next **coding session of its target subtask**, when it names one;
- otherwise the next **coding or QA fixer session**, whichever comes first.

It is marked delivered with that session's number once the session ran (not
when the prompt was built: a session that failed before the model read it
gives the message to the next one). The card shows that as the
acknowledgement. The model is not asked to confirm, so a model cannot say it
received a message it never saw, and the prompt tells it not to answer in a
file. At most the 20 newest pending messages enter one prompt.

Where a message contradicts the plan or the spec, the prompt says the message
wins: it is the person's latest word.

## Trust

- `steering.jsonl` is in `security.path_guard.PROTECTED_CONFIG_NAMES`: an
  agent cannot write it, otherwise content it read could leave a fake
  instruction from the person for the session after it (rule S2).
- The text is the person's, not external content, but it can come from a
  phone: control and invisible characters (Unicode Cc, Cf, Co, Cs except
  newline and tab) are removed and it is capped at 4 000 characters on every
  writer and again on reading.
- The server route needs `agent.execute` (`server/authz/mounting.py`); reading
  the queue needs `task.read`. The client passes a card id, never a path.
- A target subtask id must look like a planner's id
  (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`).

## Not yet

Delivery happens at session boundaries. Injecting a message **inside** a
running session (between two tool calls) needs a hook per provider and is a
later phase; until then a long session finishes with the old instructions.
