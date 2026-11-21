---
feature: Coupe-circuit des appels d'outils et arrêt d'urgence
summary: >-
  Un agent qui répète le même appel d'outil avec le même résultat, sans rien modifier entre-temps,
  est mis en pause quel que soit le fournisseur ; « Arrêter tous les agents » (bouton et
  Ctrl+Maj+.) met en pause chaque tâche en cours, à reprendre depuis sa carte.
---

# Coupe-circuit des appels d'outils et arrêt d'urgence

Issue #353, premier lot. Deux garde-fous pour laisser des agents tourner sans surveillance :
l'un s'arme tout seul quand un agent tourne en rond, l'autre est le bouton qu'on presse quand
on veut que tout s'arrête.

## Le coupe-circuit (`apps/backend/agents/tool_breaker.py`)

**Pourquoi dans `agents/session.py`.** Chaque session d'agent, quel que soit le fournisseur,
passe par `run_agent_session` : le flux du SDK Claude, et le flux normalisé de chaque
`AgentClient` (Claude par le wrapper, les CLI Codex, Copilot, OpenCode, pi, les agents ACP, la
boucle WorkPilot d'OpenAI, Google, des modèles compatibles et locaux). C'est le seul endroit où
l'on voit chaque appel d'outil et son résultat. `harness/domain/progress.py` arrêtait déjà la
seule boucle WorkPilot sur cinq tours identiques ; les fournisseurs qui gardent leur propre
boucle (le SDK, les CLI) n'avaient rien.

**Ce qui compte comme une répétition.** Un appel est identique quand son outil, ses arguments
et son résultat le sont (empreinte SHA-256). Un résultat qui change (un test qui passe, un
fichier qui existe) est un progrès, même pour le même appel. Un fichier modifié avec succès
(`Write`, `Edit`, `write_file`, `apply_patch`… quel que soit le préfixe MCP) est un progrès et
remet les compteurs à zéro : relire un fichier après l'avoir édité, c'est travailler. Les
appels ne sont pas comptés à la suite mais dans la session : un agent qui alterne deux lectures
inutiles est pris aussi. Un résultat se rattache à son appel par son identifiant
(`tool_use_id`), à défaut dans l'ordre.

**Ce qui se passe à la limite.** Cinq appels identiques par défaut
(`WORKPILOT_TOOL_BREAKER_LIMIT`, `0` l'éteint), ou `loop_detection.max_same_tool_call` de
`workpilot.policy.yaml`, que ce réglage ne peut que durcir ([governance-policy.md](governance-policy.md)). La session s'arrête au message suivant et la
tâche est mise en pause (`reason: "tool_loop"`, `breaker: {tool, repeats, limit}`) dans chaque
copie de son répertoire de spec (`foundation.pause_state.pause_task`, la même que celle des
budgets). Le coder, la QA et la spec lisent déjà ce drapeau à leur prochain point de contrôle et
remontent `BuildPaused` ; aucun nouveau chemin d'arrêt. À la sortie du processus, le main envoie
une notification (`main/backend-pause-notify.ts`) et la carte affiche « Coupe-circuit : outil »
avec l'explication (`TaskBreakerPause.tsx`). Reprendre est le bouton Reprendre habituel.

**Écarté.** Suspendre l'appel plutôt que la tâche (un hook PreToolUse n'existe que sur le SDK
Claude) ; compter les appels à la suite seulement (une alternance A, B, A, B passerait) ;
pondérer par les jetons de réflexion (pas mesurés par tous les fournisseurs).

## L'arrêt d'urgence (`main/ipc-handlers/task/stop-all-handlers.ts`)

**Une pause, pas une mise à mort.** « Arrêter tous les agents » met en pause chaque tâche qui a
un processus d'agent, comme le bouton Pause (`pauseTaskNow`, sorti de `TASK_PAUSE` pour être
partagé) : `pause_state.json` dans chaque copie, puis le processus arrêté tout de suite
(`haltTask`), sans attendre le point de contrôle coopératif. Rien n'est perdu : chaque carte
reprend sa phase et sa conversation. La raison `kill_switch` la distingue de la pause écrite à la
fermeture de l'app (`app_shutdown`) : le prochain lancement ne la reprend pas.

**Le reste s'arrête.** Un processus d'agent qui n'est pas une tâche (idéation, roadmap,
insights…) n'a rien à reprendre : il est arrêté. Une tâche dont la pause ne s'écrit pas est
arrêtée quand même : arrêter est la raison d'être du bouton.

**À la voix.** L'assistant vocal offre un arrêt plus doux : « stop », confirmé, écrit la même
pause (`reason: "voice_stop"`) sans arrêter le processus, et la session se termine après
l'appel d'outil en cours, que `tool_breaker.py` voit passer
([voice-assistant.md](voice-assistant.md)).

**Où.** Le bouton rouge apparaît dans le rail de la barre latérale tant qu'une tâche tourne ; le
raccourci Ctrl+Maj+. (Cmd+Maj+. sur macOS) marche toujours, même dans un champ de saisie. Le
canal `AGENTS_STOP_ALL` ne prend aucun argument : ce qui tourne est lu dans le main. En mode
serveur, le même appui arrête aussi les agents de la personne sur le serveur
(`main/server-governance.ts`).

## Pas encore fait (lots suivants de #353)

- ~~Les politiques versionnées et le journal d'audit exportable~~ : faits au lot 2,
  [governance-policy.md](governance-policy.md) (heures, fichiers interdits ou soumis à revue,
  jetons par heure, journal `.workpilot/policy-audit.jsonl`, panneau et export CSV/JSON).
- ~~Les tâches d'un projet du mode serveur~~ : fait au lot 4. « Arrêter tous les agents » demande
  aussi à chaque projet du serveur où la personne est membre d'arrêter les runs et les jobs
  qu'elle y a lancés, jamais ceux d'un collègue ; le propriétaire d'un projet peut tout y arrêter
  depuis Garde-fous ou le téléphone. Le délai est mesuré sur de vrais processus (moins de 2 s
  exigé) : [governance-policy.md](governance-policy.md#un-projet-du-mode-serveur-shared_featuresgovernancepy).
