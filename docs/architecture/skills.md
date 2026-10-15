# Skills system

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Skills System

Skills are markdown files with YAML frontmatter, following the [Agent Skills](https://agentskills.io)
open standard so the same file works across Claude Code, Copilot, Codex, Cursor and Gemini.

**Where they live:**

| Path | Role |
|---|---|
| `.agents/skills/<name>/SKILL.md` | The source read in production. Provider- and IDE-agnostic. |
| `.claude/skills/`, `.github/skills/`, `.cursor/skills/` | Per-harness mirrors, **not emitted by default**: only `agnostic` and `gemini` have `default: true` in `capabilities/harnesses.yaml` |
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

## Gate 4 : un corps de skill ne s'adresse pas à l'agent

Un skill n'est pas un document : `.agents/skills/<nom>/SKILL.md` est une procédure que tout agent
connecté peut charger et suivre, sur n'importe quel provider, dans toutes les sessions suivantes.
Or `skills/` est alimenté par quatre chemins — `skills-cli add` puis le `bootstrap` (le dépôt d'un
tiers, à sa propre cadence de release), le job hebdomadaire `skills-sync`, l'adoption hermes, et
l'écriture à la main — et un corps ne devient une instruction qu'au moment où le build l'émet.
La barrière est donc une **quatrième porte du resolver** (`skills_registry/injection_gate.py`),
posée à la frontière d'émission : une seule porte couvre les quatre chemins, là où un contrôle par
chemin manquerait le cinquième.

**Refusé, pas nettoyé.** `clean_untrusted` retire les porteurs et rend un texte utilisable, ce qui
est la bonne réponse pour une issue qu'un agent doit quand même lire. C'est la mauvaise ici :
personne n'a besoin d'un skill vendorisé dont on a ôté la charge, et réécrire le fichier d'un tiers
ferait que le contenu émis ne correspond plus au tree SHA enregistré dans `skills-lock.json`. Le
skill n'est pas émis, et `skills-cli why <skill>` dit pourquoi.

**Le corps brut *et* le corps nettoyé sont scannés**, et c'est la porte elle-même, pas un détail :
l'assainisseur retire les commentaires HTML et tronque au-delà d'un plafond, donc ne scanner que sa
sortie répond « safe » pour un fichier que le build émet *avec le commentaire dedans*, et ne voit
rien après la troncature.

**Ce qui refuse est une liste fermée, pas un seuil.** Un skill qui parle de travaux dangereux
contient légitimement du texte dangereux : au premier passage, la porte a refusé `claude-code` et
`computer-use` (commandes destructrices, maniement d'identifiants) puis `bmad-prfaq` (« act as a
customer »). Seuls les verdicts qui signifient *ce corps parle à l'agent* refusent — balises et
marqueurs de rôle, ordres explicites d'oubli, d'écrasement d'instruction ou d'extraction de prompt.
Un marqueur ou une balise ne s'écrit pas par accident ; une tournure verbale si. Le reste est
rapporté. Ce qu'un skill dit de *faire* reste du ressort de la revue humaine de la PR qui le
vendorise : cette porte n'est pas une revue, et rien n'y accorde la confiance à la place de
quelqu'un.

**Un scanner absent ne refuse rien**, comme partout ailleurs (`security/untrusted.py` : la
détection ne vaut jamais un build échoué). C'est une barrière contre un amont empoisonné, pas une
dépendance du build. `WORKPILOT_INJECTION_GUARD=report` rétrograde un refus en avertissement.

`tests/test_skills_registry_injection_gate.py` tient les deux moitiés de la promesse : le refus
(dont la charge cachée dans un commentaire HTML) et l'absence de faux positif, en scannant
**chaque `SKILL.md` commité** du dépôt.
