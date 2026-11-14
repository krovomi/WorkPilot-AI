---
section: 🔒 Sécurité
---

- **L'app packagée verrouille ses fuses Electron, et chaque release est auditée avant d'être
  publiée**. `ELECTRON_RUN_AS_NODE` ne fait plus de WorkPilot un Node.js ordinaire, `--inspect`
  n'ouvre plus de débogueur, le code ne se charge que depuis `app.asar` et son intégrité est
  vérifiée sur macOS et Windows. Chaque job de release lance ensuite l'audit statique de REA
  (`rea-agents`, version figée) sur l'app packagée et s'arrête sur une exposition de sévérité
  haute : source maps livrées avec leurs sources, fuse ouvert, marqueur d'identifiant.
