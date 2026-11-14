---
section: 🐛 Corrections
---

- **Porte d'API publique .NET et mutation sous Windows** : la copie de travail d'une tâche reçoit
  enfin ses changements non commités. Le correctif passait par un tube texte, qui changeait les
  fins de ligne (CRLF vers LF à la lecture, LF vers CRLF à l'écriture sous Windows), et `git apply`
  le refusait : la porte ne construisait jamais la version de la tâche.
- **CI de develop au vert sous Windows et macOS** : les tests lancent chaque runner Python avec
  l'UTF-8 de l'app, une taille de fichier ne dépend plus des fins de ligne de Windows, et le test
  des journaux de tâche laisse Radix finir avant la fin du fichier.
