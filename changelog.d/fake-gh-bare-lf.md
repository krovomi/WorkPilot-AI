---
section: 🧹 Maintenance
---

- **Faux `gh` des tests fidèle sous Windows** : il écrivait ses réponses en mode texte, donc avec des `\r\n` que le vrai `gh` n'envoie jamais ; le test du diff d'une PR échouait sur Windows seulement.
