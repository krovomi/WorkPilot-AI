# Skills system

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Skills System

Skills are markdown files with YAML frontmatter, following the [Agent Skills](https://agentskills.io)
open standard so the same file works across Claude Code, Copilot, Codex, Cursor and Gemini.

**Where they live:**

| Path | Role |
|---|---|
| `.agents/skills/<name>/SKILL.md` | The source read in production. Provider- and IDE-agnostic. |
| `.claude/skills/`, `.github/skills/`, `.cursor/skills/` | Per-harness mirrors |
| `.gemini/commands/*.toml` | Gemini CLI mirror |

A skill name is the output key — `.agents/skills/<name>/` — so two packs providing the
same name is a **collision**, not a merge. The resolver rejects the loser at the
`name-collision` gate with a reason naming the winner (`skills-cli why <skill>` prints
it), and the project decides: the pack listed first in `[packs]` wins. Several tracked
upstreams are adaptations of each other and share names on purpose, so leaving this to
iteration order meant the emitted content depended on alphabetical luck.

Those are **generated**. `skills/` is the source, and `scripts/skills_cli.py` is the only
thing that writes the outputs — `pnpm run skills:check` fails CI on drift. Packs are
added, updated and dropped through the same CLI (`skills:add`, `skills:update`,
`skills:remove`), which keeps `skills-lock.json`, `.workpilot/skills.toml` and the
`.gitignore` entries in step. See [skills/README.md](../../skills/README.md).

`apps/backend/slash_commands/api.py` scans `.agents/skills/` and serves the result to the
Kanban Quick-Command bar (`GET /api/slash-commands`), then resolves a command's body
server-side so any provider can execute it.

**Reading frontmatter:** always through `skills_registry.frontmatter.parse_frontmatter`.
It parses with PyYAML and degrades to a line parser for hand-edited blocks. Do not write
another one — the repo used to carry four, with divergent semantics, and three of them
truncated any description ending in a quoted phrase.

WorkPilot-specific fields live under `metadata.workpilot` (pack, version, targets,
requires, min_effort, provenance) — a free-form space the Agent Skills spec reserves for
tooling and that Claude Code ignores.

**Python-side skills:** `apps/backend/skills/` holds two executable skills (`angular/`,
`migration/`) loaded by `skill_manager.py` with progressive disclosure — metadata first,
instructions on trigger, scripts on demand:

```python
from skills.skill_manager import SkillManager

manager = SkillManager("apps/backend/skills")
skill = manager.load_skill("framework-migration")
result = skill.execute_script("analyze_stack.py", {"project-root": "/path/to/project"})
```
