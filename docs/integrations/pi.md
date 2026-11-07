# pi (pi.dev) comme moteur d'une tâche

[pi](https://pi.dev) est un agent de code en terminal, MIT, extensible. WorkPilot sait le lire
(il lit `AGENTS.md` et `.agents/skills/` nativement) et sait le **piloter** : choisir « pi (CLI) »
comme provider lance chaque phase d'une tâche dans `pi --mode json`, avec les outils de pi, la
session de pi et la connexion aux fournisseurs que vous avez configurée dans pi. WorkPilot ne lit
aucune clé de pi et n'en écrit aucune. Conception et faits vérifiés :
[`docs/architecture/pi.md`](../architecture/pi.md).

## Installer et se connecter

1. Le plus simple : le bouton **Installer** du badge **pi** (barre latérale, « Outils CLI ») lance
   l'une des commandes ci-dessous à votre place. À la main : Node.js **22.19 ou plus** (celui de
   pi, pas celui de ce dépôt), puis
   `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` — ou
   `powershell -c "irm https://pi.dev/install.ps1 | iex"` sous Windows,
   `curl -fsSL https://pi.dev/install.sh | sh` ailleurs.
2. Lancer `pi`, puis `/login` pour le fournisseur voulu, ou poser sa variable d'environnement
   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`…) dans l'environnement où WorkPilot
   lance pi. Un modèle local se déclare dans `~/.pi/agent/models.json`
   ([documentation](https://pi.dev/docs/latest/models)).
3. Dans WorkPilot, le badge **pi** de la barre latérale dit si l'exécutable est trouvé et sa
   version. Sous Windows, pi lance ses commandes dans Git Bash : installer Git for Windows.

## Choisir pi pour une tâche

Provider **pi (CLI)**, modèle **pi default** (celui configuré dans pi) ou un identifiant
`fournisseur/modèle` tel que `pi --list-models` l'affiche. L'effort de la phase devient
`--thinking` ; un niveau que le modèle ne connaît pas est ramené par pi au plus proche.

Ce que WorkPilot impose à chaque run, et pourquoi :

| Ce qui est passé à pi | Raison |
|---|---|
| `--tools <liste>` : les outils que le type d'agent déclare, dans les mots de pi (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) et les outils MCP de ses serveurs | un agent n'a que les outils qu'il déclare, sur tous les providers ; un relecteur ne peut pas écrire, et pi répond `Tool write not found` s'il essaie |
| `--skill .agents/skills` | les skills du projet, les mêmes que sur les autres providers |
| `PI_CODING_AGENT_SESSION_DIR=<spec>/pi-sessions`, `--session-id` puis `--session <id>` | la session d'une tâche vit avec la tâche (ignorée par git), pas dans `~/.pi` ; une phase reprend la précédente par son id |
| rien d'autre : ni `--approve`, ni `--no-mcp`, ni clé | ce qui est à vous reste à vous (voir ci-dessous) |

## Ce que WorkPilot ne fait pas à votre place

**La confiance d'un projet.** pi ne charge `.pi/` d'un projet (extensions, `mcp.json`, prompts,
`SYSTEM.md`) qu'une fois le dossier approuvé : `pi` dans le dossier, puis `/trust`. Une
extension approuvée s'exécute dans le processus pi avec vos droits, c'est pourquoi c'est une
décision par machine et par personne. En mode non interactif pi ne pose pas la question et
**ignore silencieusement** ces ressources ; WorkPilot le dit dans le fil de la tâche quand
c'est le cas, et s'arrête là. Approuver la racine d'un dépôt couvre les worktrees que WorkPilot
crée dessous.

**Vos serveurs MCP.** Ceux de `~/.pi/agent/mcp.json` sont les vôtres. Pour que pi atteigne le
cerveau partagé et la recherche de code de WorkPilot :

```bash
python apps/backend/runners/brain_runner.py --action connect --apply   # écrit workpilot-brain dans ~/.pi/agent/mcp.json
pi mcp add workpilot-code -- python apps/backend/runners/code_search_mcp.py --project-dir .
```

L'entrée `workpilot-brain` est écrite avec `"exposure": "direct"` : par défaut pi ne présente
les outils MCP qu'à son bac à sable `codemode`, que WorkPilot n'accorde pas.

**Vos sessions.** Rien n'est lu ni écrit dans `~/.pi/agent/sessions/`.

## Quand ça ne marche pas

| Symptôme | Cause et remède |
|---|---|
| « pi is not installed or is not available on PATH » | l'exécutable n'est pas dans le PATH de WorkPilot ; `pi --version` dans un terminal, puis relancer l'application |
| « pi authentication error » | pas de connexion pour le fournisseur du modèle choisi : `pi` puis `/login`, ou la variable d'environnement |
| « pi's provider rejected the selected model » | l'identifiant n'existe pas chez le fournisseur ; WorkPilot a réessayé une fois avec le modèle par défaut de pi |
| « pi's answer was cut by the model's output limit » | la réponse est partielle (`stopReason: length`) ; WorkPilot ne la compte pas comme un succès |
| les skills ou extensions de `.pi/` ne sont pas chargés | le projet n'est pas approuvé dans pi (`/trust`) ; les skills de `.agents/skills/` arrivent de toute façon |

## Deux modes, un garde-fou

`WORKPILOT_PI_MODE=rpc` garde **un processus pi par session** au lieu d'un par phase : la fenêtre
de contexte du modèle est connue, la compaction se demande à pi, une annulation lui est signalée
(`abort`) avant d'arrêter le processus, et le prompt système n'est envoyé qu'une fois. Le défaut
est `json`. Dans les deux modes, une question qu'une extension de pi poserait reçoit « annulé » :
personne n'est là pour répondre.

Dans les deux modes aussi, WorkPilot charge dans pi son garde-fou d'écriture
(`.workpilot/pi-guard/workpilot-guard.js`, recopié avant chaque run, jamais poussé dans une PR) :
un `write` ou un `edit` hors du worktree, du dossier de spec ou du dossier temporaire de WorkPilot
est refusé, de même qu'une écriture sur `.workpilot-allowlist`, `.workpilot-security.json`,
`.workpilot/guardrails.*`, `.claude/settings*.json` et `.pi/` — les mêmes règles que sur le SDK
Claude. `bash` n'est pas jugé dans pi : le worktree isolé et `--tools` font ce qu'ils font sur
OpenCode et Antigravity.

Variables lues par l'adaptateur : `PI_CODING_AGENT_DIR` (où pi garde `trust.json` et `mcp.json`,
par défaut `~/.pi/agent`), `WORKPILOT_PI_MODE` (`json` ou `rpc`). Posées par lui pour le
sous-processus : `PI_CODING_AGENT_SESSION_DIR`, `PI_SKIP_VERSION_CHECK=1`, `WORKPILOT_PI_GUARD`
(la politique du garde-fou). Retirées de son environnement : `NODE_OPTIONS`, `LD_*`, `DYLD_*`,
`TYPESAFE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` ; les clés de fournisseur que vous avez posées pour
pi lui parviennent.
