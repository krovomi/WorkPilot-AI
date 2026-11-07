# Fichiers d'instructions des agents

Chaque agent de code lit ses instructions à sa façon. Ce dépôt en a un seul jeu, écrit une fois,
et un fichier fin par agent qui y renvoie. Le but est double : ne payer à chaque session que ce qui
vaut partout, et ne jamais avoir deux versions d'une règle.

## Le principe

- **`AGENTS.md` à la racine** porte ce qui vaut pour toute tâche : le produit en trois lignes, les
  règles critiques (normatives, une seule copie), où lire la suite, la carte du dépôt, les
  commandes. Il est payé par chaque session de chaque agent, donc il reste court (plafond testé).
- **Un `AGENTS.md` par dossier** qui en a besoin (backend, frontend, sécurité, skills, Kanban) :
  la carte locale, chargée seulement quand l'agent travaille là.
- **`docs/rules/<thème>.md`** porte le détail normatif, chargé à la demande ou par dossier.
- **`docs/architecture/<feature>.md`** porte le pourquoi, jamais chargé d'office.

Les commentaires HTML de bloc (`<!-- … -->`) servent aux notes pour les mainteneurs : Claude Code
les retire avant l'injection, WorkPilot aussi (voir plus bas).

## Qui lit quoi

| Agent | Fichier lu | Ce que le dépôt fournit |
|---|---|---|
| Claude Code (et le SDK qui pilote les tâches Claude) | `CLAUDE.md`, plus le `CLAUDE.md` d'un dossier quand il y lit un fichier | `CLAUDE.md` = `@AGENTS.md` et deux lignes propres à Claude. Chaque `AGENTS.md` local a un `CLAUDE.md` voisin qui l'importe, avec la règle du thème. `docs/rules/security.md` est importé seulement là où une frontière se touche : `apps/backend/security/`, `apps/backend/server/`, `apps/frontend/src/main/`, `.github/workflows/`. |
| Codex (OpenAI) | `AGENTS.md` de la racine jusqu'au dossier courant, concaténés, 32 KiB par défaut | Rien de plus. Une chaîne racine → dossier tient sous 32 KiB (testé). |
| GitHub Copilot | `.github/copilot-instructions.md`, `AGENTS.md`, `.github/instructions/*.instructions.md` par `applyTo` | `copilot-instructions.md` renvoie à `AGENTS.md` sans le répéter. Le bloc BMAD est dans `instructions/bmad.instructions.md`, chargé seulement sous `_bmad/`. |
| Gemini CLI | `GEMINI.md` par défaut ; les noms de `context.fileName` | `.gemini/settings.json` lui fait lire `AGENTS.md` (racine et dossiers touchés) : pas de `GEMINI.md` à tenir à jour. |
| Cursor, OpenCode, Amp, pi, hermes, Mistral Vibe | `AGENTS.md` | Rien de plus. |
| OpenAI, Grok, DeepSeek, Mistral, OpenRouter, Gemini par API, modèles locaux, Windsurf (boucle WorkPilot) | rien d'eux-mêmes | WorkPilot met le `AGENTS.md` du projet dans leur prompt système, voir ci-dessous. |

## Les providers de la boucle WorkPilot

Avant, les conventions d'un projet atteignaient Claude (par `CLAUDE.md`) et les CLI (par
`AGENTS.md`), jamais les modèles que WorkPilot pilote lui-même. `core/project_instructions.py`
comble l'écart :

- il lit `AGENTS.md` à la racine du worktree, sinon `CLAUDE.md` avec ses `@imports` développés
  comme Claude Code le ferait (quatre niveaux, jamais hors du projet, jamais dans un bloc de code) ;
- il retire les commentaires HTML, plafonne à 32 KiB (la valeur par défaut de Codex, déjà le budget
  d'un projet qui vise plusieurs agents) ;
- le fichier vient du dépôt cible : il passe par `clean_untrusted` (S2), et un fichier jugé suspect
  par le scanner d'injection est écarté et journalisé, jamais donné au modèle ;
- il suit le même interrupteur que le `CLAUDE.md` de Claude (`useClaudeMd` → `USE_CLAUDE_MD`) :
  la personne décide une fois pour tous les providers ;
- la section se place dans la partie « projet » du préfixe (`Stability.PROJECT`), avant le skill de
  documents et le chemin du worktree : les providers qui mettent en cache le début du prompt
  (OpenAI et compatibles, DeepSeek, Gemini) la réutilisent d'une tâche à l'autre.

Les clients qui lisent déjà le fichier eux-mêmes (Claude, Copilot, Codex, pi, OpenCode, ACP) ne le
reçoivent pas une seconde fois.

## Les réglages de la personne (`~/.claude`) selon le type d'agent

Une session Claude charge ce que ses `setting_sources` lui disent de lire sur le disque : `project`
(le `.claude/` du worktree, son `CLAUDE.md`, ses skills et ses hooks), `user` (le `~/.claude` de la
personne : son `CLAUDE.md` à elle, ses skills, ses hooks) et `local`
(`.claude/settings.local.json`). Jusqu'ici toutes les sessions recevaient les trois, le planner et
la QA compris, et le client simple n'en passait aucune, ce que le SDK lit comme « toutes ».

Le choix est maintenant déclaré par type dans `AGENT_CONFIGS` (`"setting_sources"`) et résolu par
`agents/tools_pkg/setting_sources.py`, que les deux fabriques appellent (`create_client`,
`create_simple_client`) :

- **le coder** déclare `["project", "user", "local"]` : le code s'écrit comme son auteur travaille,
  avec ses skills et son `CLAUDE.md` ;
- **tous les autres types** (planner, QA reviewer et fixer, phases de spec, analyses, revues de PR,
  utilitaires) ne déclarent rien et reçoivent `["project"]` : ils jugent ou préparent le travail, et
  doivent le juger de la même façon sur toutes les machines, sans instructions ni hooks que personne
  d'autre ne voit ;
- **un type inconnu** reçoit aussi `["project"]` : un type ajouté demain n'est pas encore passé par
  cette décision, et ce que `project` apporte est partagé et revu avec le code.

Deux variables le règlent ([CONFIGURATION.md](../CONFIGURATION.md#claude-agent-sdk-sessions)) :
`AUTO_CLAUDE_CODER_USER_SETTINGS=false` ramène le coder au projet seul, et
`AUTO_CLAUDE_SETTING_SOURCES` impose une liste à tous les types (`project` y est toujours gardé :
c'est lui qui porte le `CLAUDE.md` du projet, que `useClaudeMd` gouverne).

Aucune source n'accorde d'outil : ce qu'un type peut appeler reste sa déclaration
`AGENT_CONFIGS[...]["tools"]`, que `disallowed_tools` impose quoi que disent les règles `allow` d'un
`settings.json` chargé (`undeclared_builtin_tools`, règle 2). Seul ce qui guide le modèle change.

Les CLI des autres providers lisent aussi les instructions globales de la personne, pour tous les
types : Codex son `$CODEX_HOME/AGENTS.md`, Gemini CLI son `~/.gemini/` (fichier de
`context.fileName`), OpenCode et pi leurs `AGENTS.md` globaux. Aucun ne propose, à notre
connaissance, un réglage d'une ligne qui sépare ces instructions de celles du projet sans déplacer
aussi son répertoire personnel, où vivent ses identifiants : rien n'y est changé.

## Ce que les tests tiennent

`tests/test_docs_context.py` : ce que Claude Code charge à chaque session (racine et imports) reste
sous son plafond, une chaîne d'`AGENTS.md` tient dans les 32 KiB de Codex, Gemini CLI est réglé sur
`AGENTS.md`, `copilot-instructions.md` reste un renvoi. `tests/core/test_project_instructions.py` :
lecture, imports, plafond, interrupteur, refus d'un fichier suspect, place dans le préfixe.
`tests/core/test_setting_sources.py` : les sources de chaque type, le défaut d'un type inconnu, les
deux variables, et ce que les deux fabriques passent au SDK.
