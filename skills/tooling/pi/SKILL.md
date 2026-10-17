---
name: pi
description: Piloter pi (pi.dev) sans interface — `--mode json` pour un turn, `--mode rpc` pour une session — depuis un script ou un autre agent, avec les droits en allowlist (`--tools`), les skills du projet en explicite (`--skill`) et la confiance d'un projet laissée à une personne. À lire avant d'écrire du code qui lance pi, ou pour diagnostiquer un run pi qui ne fait rien.
metadata:
  workpilot:
    phase: procedure
---

# pi — le piloter sans interface

[pi](https://pi.dev) est un agent de code en terminal. Hors de son TUI il a deux modes : `--mode
json` (une invocation, une réponse, des événements JSON par ligne sur stdout) et `--mode rpc` (un
processus qui vit, des commandes JSON par ligne sur stdin). Cette procédure dit comment les
utiliser sans rien perdre de ce que pi protège. Les faits vérifiés contre pi 1.3.0 sont dans
`docs/architecture/pi.md` ; les flux réels dans `tests/fixtures/pi/`.

## Ce qu'il faut savoir avant de lancer pi

| Fait | Conséquence |
|---|---|
| Le code de sortie est 0 même quand la réponse est une erreur (`stopReason: "error"`, une 401 comprise) | lire `message_end.message.stopReason` et `errorMessage`, jamais le code de sortie |
| Un projet non approuvé (`/trust`, `~/.pi/agent/trust.json`) n'a **aucune** ressource de `.pi/` chargée, sans trace | ne jamais passer `--approve` à la place de quelqu'un ; lire `trust.json` et le dire |
| `--skill <dossier>` charge un dossier de skills hors de la barrière de confiance | donner les skills du projet ainsi : `--skill .agents/skills` |
| `--tools a,b,c` est une allowlist réelle : un outil absent n'existe pas pour le modèle | les droits se posent là ; un appel hors liste reçoit `Tool x not found` |
| `--session <id>` est lu comme un **chemin** dès qu'il contient `/`, `\` ou `.jsonl` | un id de session est `[A-Za-z0-9-]`, et le dossier passe par `PI_CODING_AGENT_SESSION_DIR` |
| `AGENTS.md` prime sur `CLAUDE.md` dans un même dossier ; pi remonte jusqu'à la racine du disque | un `AGENTS.md` dans un dossier parent entre dans le prompt |
| `-ne` retire aussi les extensions intégrées (`builtin:mcp`) ; `-e builtin:mcp` en rétablit une | ne pas désactiver les extensions pour « être sûr » sans remettre MCP |

## Un turn en mode json

```bash
export PI_CODING_AGENT_SESSION_DIR=<dossier de la tâche>/pi-sessions
export PI_SKIP_VERSION_CHECK=1
echo "<prompt>" | pi --mode json --session-id <uuid> --tools read,grep,find,ls --skill .agents/skills
# turn suivant, même session :
echo "<prompt>" | pi --mode json --session <uuid> --tools read,grep,find,ls --skill .agents/skills
```

Le prompt va sur **stdin** (jamais en argument : un chemin ou un `$(…)` dans argv est un bug).
Événements à lire : `session` (en-tête), `message_end` avec `message.role == "assistant"`
(`content[]`, `usage`, `stopReason`), `tool_execution_start` (`args`) et `tool_execution_end`
(`result`, `isError`), `agent_settled` en dernier. `message_start`/`message_end` arrivent aussi
pour `system`, `user` et `toolResult` : filtrer sur le rôle.

## Une session en mode rpc

```bash
pi --mode rpc --session-id <uuid> --tools read,bash,edit,write,grep,find,ls
```

Puis une commande JSON par ligne sur stdin, chacune avec un `id` que la réponse rend :
`{"id":"1","type":"prompt","message":"…"}` (fin de turn : `agent_settled`),
`{"id":"2","type":"compact"}` (`success: false` et « Nothing to compact » quand la session est
petite — ce n'est pas une erreur), `{"id":"3","type":"get_state"}` (`sessionId`,
`model.contextWindow`), `{"id":"4","type":"abort"}`. Fermer stdin arrête pi proprement. Une
question posée par une extension arrive comme `extension_ui_request` : répondre
`{"type":"extension_ui_response","id":"<id>","cancelled":true}` — personne n'est là.

## Diagnostiquer un run qui ne fait rien

1. `pi --version` : installé, et ≥ 1.3.0 ?
2. `stopReason: "error"` avec `invalid_api_key` / `401` → `pi` puis `/login`, ou la variable du
   fournisseur dans l'environnement de pi.
3. Les skills du projet absents du prompt système → le projet n'est pas approuvé et
   `--skill .agents/skills` n'a pas été passé.
4. `Tool write not found` → l'allowlist `--tools` ne le contient pas : c'est voulu pour un rôle
   en lecture seule.
5. Un `write` refusé avec « Writing outside the build's directories » → le garde-fou WorkPilot
   (`.workpilot/pi-guard/workpilot-guard.js`) a jugé le chemin hors du worktree ; écrire dedans.
