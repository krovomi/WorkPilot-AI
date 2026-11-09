---
section: ✨ Nouveautés
---

- **Le détecteur de tests instables dit pourquoi, suit l'évolution et crée la carte pour corriger** (F195). Chaque test signalé reçoit un verdict (instable, ou plus probablement un vrai bug quand il échoue presque toujours), les lignes de son propre code qui l'expliquent (attente fixe, horloge, réseau, état partagé, threads, mise en place sans nettoyage), sur toutes les stacks et sans modèle, et son historique : pire ou mieux que la dernière fois, en CI seulement, sur quels systèmes. Les seuls suspects peuvent être relancés avec le filtre de leur stack (`pytest -k`, `vitest -t`, `dotnet test --filter`, `go test -run`, `mvn -Dtest`, `gradle --tests`). Un clic crée une carte Kanban pour corriger le test (ni saut, ni relance) ou le mettre en quarantaine dans les termes de son framework (#351).
