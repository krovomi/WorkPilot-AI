---
section: 🔒 Sécurité
---

- **Mode serveur : chaque run ne voit que son projet sur le disque.** Un build lancé sur le
  serveur est confiné par Landlock à son clone, au dossier de son projet et à son dossier
  temporaire : les projets des autres équipes, le dossier de l'utilisateur du serveur et l'état du
  serveur lui sont fermés. Il faut Linux 5.13 ou plus ; sinon le run échoue avec la raison
  (`WORKPILOT_RUN_ISOLATION=off` pour un déploiement où chacun peut tout lire).
