# Wiki automation

Scripts that keep the GitHub Wiki (`WorkPilot-AI.wiki`) in sync with the source repo.

## Philosophy

Two update tracks with different cost and cadence:

| Track | Trigger | Cost | What it updates |
|-------|---------|------|-----------------|
| **Inventories** (deterministic) | every push to `develop` with relevant paths | free | Tables of agents, integrations, providers, modules, CLI |
| **Narrative** (AI) | each GitHub release | ~€1 per run | Prose sections + FR translations |
| **Patches** (human) | each GitHub release | free | Hand-written prose outside the markers, from [`patches/`](patches/) |

Every auto-updated block is delimited by markers in the wiki pages:

```markdown
<!-- AUTOGEN:AGENTS:START -->
...table or prose regenerated here...
<!-- AUTOGEN:AGENTS:END -->
```

Anything outside markers is **preserved untouched** — wiki editors can freely hand-edit.

## Hand-written pages: `patches/`

Prose outside the markers (a "what's new" section, a release on the roadmap, a
security page) is written by people, so no generator produces it. Instead of
pushing it to the wiki by hand, keep it in the source repo:

1. Clone the wiki, edit the pages, commit.
2. `git format-patch -1 -o <repo>/scripts/wiki/patches/` and rename the file
   with an ordering prefix (`0002-release-1.4.0.patch`).
3. Open a PR to `develop`, like any other change.

Each release then runs the `full` sync, which applies every patch **before**
regenerating the AUTOGEN blocks:

- a patch whose changes are already in the wiki is skipped, so the folder is
  replayed safely on every run (an applied patch may also be deleted);
- a patch that no longer applies (`git am --3way` conflict) is aborted and
  named in an `::error::` line, the other patches still go through, and the
  job fails so the stale patch gets rebased.

To apply them without waiting for a release:
`gh workflow run wiki-narrative.yml --ref develop -f mode=patches`.

`.gitattributes` marks `*.patch` there as binary-safe (`-text`): a line-ending
conversion would make `git am` refuse it.

## Files

| File | Role |
|------|------|
| [generate_inventories.py](generate_inventories.py) | Deterministic table regen from source tree |
| [update_narrative.py](update_narrative.py) | Narrative refresh + FR translation via Claude |
| [sync_wiki.py](sync_wiki.py) | Orchestrator: clone wiki, run steps, commit, push |
| [patches/](patches/) | Hand-written wiki edits as `git format-patch` files, applied on each release |

## Bilingual convention

The wiki uses a flat naming scheme:

- Canonical English: `Page-Name.md`
- French translation: `Page-Name.fr.md`

`Home.md` is a bilingual landing page; `_Sidebar.md` lists both languages.

Translation direction is **EN → FR**. Edit the EN page, then run `translate-fr` (or wait for the release workflow).

## Running locally

```bash
# Dry run (no writes, no API calls)
python scripts/wiki/generate_inventories.py \
    --repo . --wiki /tmp/wp-wiki --dry-run

# Full refresh against a local wiki clone — uses your local `claude` CLI login
git clone https://github.com/krovomi/WorkPilot-AI.wiki.git /tmp/wp-wiki
python scripts/wiki/sync_wiki.py --mode full --workdir /tmp/wp-work --no-push
```

`update_narrative.py` shells out to the `claude` CLI (`npm i -g @anthropic-ai/claude-code`). In CI it authenticates via `CLAUDE_CODE_OAUTH_TOKEN`; locally it uses your interactive login.

## Sync modes

| Mode | What it does |
|------|--------------|
| `inventories` | Regenerate deterministic tables (agents, providers, integrations, modules). Free. |
| `narrative` | Rewrite `<!-- AUTOGEN:NARRATIVE -->` blocks from canonical source docs. |
| `translate` | EN → FR translation of whole pages when the FR is missing/stub. |
| `translate-en` | FR → EN bootstrap (for initial FR-first state). |
| `patches` | Apply `patches/` only. Free. |
| `full` | patches + inventories + narrative + translate (EN→FR). |
| `bootstrap` | inventories + translate-en + translate-fr. Use once to lift FR content into EN. |

## Required secrets

GitHub Actions need:

- `WIKI_PUSH_TOKEN` — PAT with `repo` scope (or fall back to `GITHUB_TOKEN` if wiki pushes are permitted)
- `CLAUDE_CODE_OAUTH_TOKEN` — generated with `claude setup-token` on a machine already logged into claude.ai. Reuses your Claude subscription quota; no paid API key required.

## Models

| Task | Model | Why |
|------|-------|-----|
| Narrative rewriting | `claude-sonnet-4-6` | Best quality/cost for structured prose |
| FR translation | `claude-haiku-4-5-20251001` | Cheap, fast, sufficient for translation |

To change models, edit the constants at the top of `update_narrative.py`.

## Adding a new AUTOGEN section

1. Insert the marker pair in the wiki page (EN and/or FR):
   ```markdown
   <!-- AUTOGEN:MYSECTION:START -->
   <!-- AUTOGEN:MYSECTION:END -->
   ```
2. Add a renderer to `generate_inventories.py`:
   ```python
   def render_mysection(repo: Path, lang: str) -> str: ...


   RENDERERS["MYSECTION"] = render_mysection
   ```
3. Push — the inventory workflow will fill it in on the next relevant push.

## Troubleshooting

- **Nothing changed after my push**: check that a path in the workflow's `paths:` filter matches.
- **Push to wiki failed**: the workflow uses `WIKI_PUSH_TOKEN` — ensure the PAT exists and has `repo` scope.
- **`claude` CLI not found**: the narrative workflow installs it with `npm i -g @anthropic-ai/claude-code`; locally run the same command.
- **`CLAUDE_CODE_OAUTH_TOKEN not set`**: generate one with `claude setup-token` (on a machine already `/login`ed) and paste the output into the repo secret.
- **Narrative looks off**: review `SOURCE_FILES` in `update_narrative.py` — the model only sees those.
- **Translation drift**: `translate-fr` re-runs when FR is missing or substantially shorter than EN. Force a full retranslation by deleting the `.fr.md` file.
