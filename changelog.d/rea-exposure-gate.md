---
section: ✨ Nouveautés
---

- **Porte « Exposition de l'artefact »**. Après la QA, REA lit sans la lancer la sortie de build
  que la tâche a laissée (bundle Electron ou Tauri, APK, build web et ses source maps, dossier
  `publish` .NET, jar, wheel, exécutable Rust…) et signale ce qu'elle expose. Par défaut elle
  prévient sans bloquer ; en `strict`, ou quand le workflow déclare la porte dure
  `artifact-exposure`, un check exposé au seuil (`high` par défaut) renvoie la tâche au fixer.
  Ce que REA n'a pas pu trancher ne bloque jamais, et une vérification qui n'a pas pu tourner
  n'est jamais comptée comme réussie. Le Release Train gagne la même étape, `exposure`, avant le
  déploiement de chaque service.
