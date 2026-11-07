@AGENTS.md

<!-- Claude Code ne lit AGENTS.md seul que sans CLAUDE.md (et pas dans toutes les versions du SDK) :
ce fichier l'importe. N'importer ici que ce qui vaut pour toute session : un @import ne réduit pas
le coût, il le déplace. Le reste se charge à la demande :
- chaque dossier qui a un AGENTS.md a un CLAUDE.md voisin qui l'importe (chargé quand Claude lit un
  fichier de ce dossier), avec la règle du thème (backend.md, frontend.md, security.md) ;
- docs/rules/workflow.md et docs/architecture/ se lisent quand la tâche les concerne.
Les commentaires HTML de bloc sont retirés avant l'injection : ils ne coûtent aucun token. -->

## Propre à Claude Code

- Avant de toucher une frontière de confiance (secret, contenu externe, chemin, IPC, route serveur,
  dépendance, CI), lire `docs/rules/security.md` en entier s'il n'est pas déjà en contexte.
- Les sous-agents de `apps/backend/subagents/` sont la source ; `.claude/agents/` n'est pas émis.
