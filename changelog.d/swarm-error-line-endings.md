---
section: 🐛 Corrections
---

- **Essaim** : sur Windows, l'erreur d'une sous-tâche en échec garde des fins de ligne uniformes
  (la fin de sa sortie d'erreur ne mélange plus `\r\n` et `\n`), ce qui remet au vert le test de
  la vague sur la CI Windows.
