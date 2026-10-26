# Agents ACP — un client pour tous les agents du protocole

> **Statut : livré pour Gemini CLI.** Faits relevés sur le schéma ACP (protocole version 1,
> schéma 1.19) et sur Gemini CLI **0.65.0**, capturés dans `tests/fixtures/acp/gemini-cli/` par le
> `capture.py` voisin. Un autre agent ACP s'ajoute par une entrée de `capabilities/providers.yaml`,
> sans code, une fois ses fixtures capturées.

## 1. Ce que c'est

[Agent Client Protocol](https://agentclientprotocol.com) (ACP) est le protocole qu'un éditeur
parle à un agent de code : JSON-RPC 2.0, un message par ligne, sur le stdin et le stdout de
l'agent. Gemini CLI le parle (`gemini --acp`), et d'autres agents aussi. Avant, chaque CLI avait
son adaptateur (`opencode_cli.py`, `antigravity_cli.py`, `pi_cli.py`), qui lisait une sortie
propre à cet outil. Un agent ACP n'a plus besoin du sien : `AcpAgentClient`
(`apps/backend/core/agent_clients/acp.py`) est le même pour tous, et chaque agent est une entrée
`acp:` de `providers.yaml`.

| Champ de `acp:` | Rôle |
|---|---|
| `command` | l'exécutable nu, puis ses arguments ; un jeton hors `[A-Za-z0-9._:@#+=-]` est refusé au chargement |
| `model_flag`, `model_prefixes` | comment passer le modèle, et quels identifiants l'agent sert (un autre est ignoré, et le fil le dit) |
| `approval_mode`, `read_only_mode` | le mode de session pour un type qui écrit, et pour un type en lecture seule |
| `auto_approve_modes` | les modes où l'agent agit sans demander : remis au mode attendu dès que l'agent les annonce |
| `auth_env` | méthode de connexion → variable : la méthode n'est essayée que si la variable est définie |
| `label`, `login`, `docs` | ce que voient le fil de la tâche et la barre latérale |

`skills_registry/providers.py` (`AcpSpec`, `acp_provider_names()`) lit ce bloc ;
`core/client.py` route chaque nom ACP vers `_acp_client`, et le provider est accepté partout où
un provider se nomme (`AUTO_CLAUDE_PROVIDER`, réglages, phases). L'effort n'a pas de réglage en
ACP : `effort_plan` le dit « non appliqué ».

## 2. La session

1. `initialize` répond sans connexion et dit ce que l'agent sait faire (`agentCapabilities`,
   `authMethods`). **Seul ce qui est déclaré sert** : une session n'est rechargée
   (`session/load`) que si `loadSession` vaut `true` ; le fil de la tâche trace les capacités
   telles que déclarées.
2. `session/new` (`cwd` = le worktree). Sans connexion, Gemini répond `-32000` : le client essaie
   une fois la méthode d'`auth_env` dont la variable est définie (`GEMINI_API_KEY` →
   `gemini-api-key`), sinon il échoue en nommant la commande de connexion
   (`AcpAuthenticationError`). Jamais de boucle.
3. `session/prompt` : les `session/update` (texte, appels d'outils, `usage_update`) deviennent
   des messages de l'agent ; le prompt système part au premier tour d'une session neuve
   seulement. `usage_update` donne le contexte **exact** (`used`/`size`) au harness de contexte.
4. Les réponses que `session/load` rejoue sont jetées : la conversation est déjà dans l'historique
   de WorkPilot.

Le client déclare `fs.readTextFile: false` et `terminal: false`. Gemini ne sait pas distinguer
sur ACP un fichier absent d'une erreur : un client qui servirait les lectures l'empêcherait de
créer un fichier. Les lectures restent donc à l'agent, dans son espace ; les écritures passent par
le client (`fs/write_text_file`).

## 3. Les droits : trois barrières

Un type d'agent a les outils qu'il déclare (règle 2 de `docs/CLAUDE.md`). Sur ACP, l'agent décide
seul de ses outils ; WorkPilot tient le droit trois fois.

| Barrière | Ce qu'elle fait | Pourquoi elle ne suffit pas seule |
|---|---|---|
| **Le mode** | un type sans Write, Edit ni Bash tourne en `read_only_mode` (`plan` chez Gemini : `write_file` « denied by policy », le shell ne part pas) ; les autres en `approval_mode` (`default`). `autoEdit` et `yolo` sont remis aussitôt | un agent sans mode lecture seule n'en a pas ; le fil le dit |
| **La question** | une `session/request_permission` d'un genre que le type ne déclare pas, ou dont un chemin sort des racines d'écriture du build ou vise un fichier protégé, est refusée **sans demander à personne** | l'agent ne demande pas tout |
| **Ce qui a tourné** | Gemini lance sans demander une commande qu'il juge anodine (`echo`, capturé). Un outil d'un genre non déclaré qui démarre arrête le tour (`session/cancel`) et le fait échouer | vu, pas empêché : c'est dit comme tel |

Genres d'outils ACP et droits qui les accordent :

| Genre | Accordé par |
|---|---|
| `read`, `search` | Read, Grep ou Glob |
| `edit`, `delete`, `move` | Write ou Edit |
| `execute` | Bash |
| `fetch` | WebFetch ou WebSearch |
| `think` | toujours |
| `switch_mode`, `other` | un type qui peut écrire |
| tout genre, type non enregistré | permissif, comme ailleurs |

Une écriture servie par le client (`fs/write_text_file`) repasse par les mêmes contrôles que le
hook d'écriture : chemin absolu, résolu, dans `resolve_write_roots`, pas un fichier de
garde-fous (`protected_config_refusal`), écrit de façon atomique. L'environnement de l'agent est
celui de WorkPilot privé de `ENV_DENYLIST` (variables d'injection du chargeur, jeton Claude Code).

## 4. La question va sur la carte

`acp_permissions.py` choisit qui répond :

- **dans l'app** : le main Electron lance le build avec `WORKPILOT_PERMISSION_CHANNEL=stdin`. La
  question sort en événement de tâche `PERMISSION_REQUESTED` ; le main la valide (zod :
  identifiants en liste fermée de caractères, textes bornés, au plus huit options de genre ACP),
  la garde (`main/task-permissions.ts`), l'envoie au renderer et à « Besoin de toi ». La carte
  montre un bouton par option (`TaskPermissionPrompt`). Au clic, le main vérifie que la question
  est en attente pour cette tâche et que l'option en fait partie, puis écrit une ligne
  `__WORKPILOT_PERMISSION_ANSWER__:{"requestId","optionId"}` sur le stdin du build. Python
  vérifie encore l'option, puis émet `PERMISSION_RESOLVED` qui retire la question ;
- **dans un terminal** : la question s'affiche et se lit au clavier ;
- **ailleurs** : personne ne peut répondre, la demande est refusée et le fil le dit.

Sans réponse après `WORKPILOT_PERMISSION_TIMEOUT_SECONDS` (30 minutes par défaut), c'est un
refus. Quand le build s'arrête, ses questions disparaissent de la carte.

Le texte d'une question est celui de l'agent : une donnée, affichée comme texte, nettoyée des
caractères de contrôle et bidi, bornée. Un événement de tâche se lit sur le stdout du build, où le
texte d'un agent peut arriver : un faux `PERMISSION_REQUESTED` peut au pire **montrer** une fausse
question. Il ne peut pas répondre à une vraie : la réponse ne vient que du main, sur un stdin que
l'agent (enfant du build, avec ses propres tubes) n'atteint pas, et elle nomme une demande que le
build a faite.

## 5. La barre latérale ne montre que ce qui est déclaré

Le badge d'un agent ACP installé lance l'agent, envoie `initialize`, lit la réponse et l'arrête
(`probeAcpAgent`, sans shell ; un lanceur `.cmd` est refusé ; 15 s au plus). Chaque capacité
s'affiche cochée seulement si l'agent l'a déclarée `true` ; les autres sont marquées « non
déclarée ». Aucune capacité n'est supposée. `tests/test_acp_frontend_parity.py` vérifie que la
sonde lance la même commande que le build.

## 6. Vérification

```bash
pytest tests/test_acp_client.py tests/test_acp_frontend_parity.py -q
cd apps/frontend && pnpm test -- task-permissions task-permission-handlers TaskPermissionPrompt \
  task-permission-store agent-cli-handlers
```

`tests/test_acp_client.py` rejoue les fixtures capturées (connexion requise, écriture acceptée
puis refusée, commande lancée sans demander, mode `plan`, reprise) contre un faux agent.
Recapturer après une montée de version de Gemini : `python tests/fixtures/acp/gemini-cli/capture.py`
(il faut le binaire et une connexion), puis mettre à jour `VERSION`.
