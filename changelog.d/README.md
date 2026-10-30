# Fragments du changelog

Une PR qui change quelque chose pour l'utilisateur ajoute **un fichier** ici au lieu d'écrire
dans `CHANGELOG.md` : deux PR ouvertes en même temps ne touchent plus les mêmes lignes.

```markdown
---
section: 🐛 Corrections
---

- **Ce qui change, pour l'utilisateur** (F122). Une ou deux phrases.
```

- Nom du fichier : libre et parlant (`n3-e2e.md`) ; il ordonne les entrées d'une même section.
- `section` : une de `⚠️ Changement incompatible`, `✨ Nouveautés`, `🐛 Corrections`,
  `🔒 Sécurité`, `🛠️ Qualité`, `🧪 Filets de test`, `📚 Documentation`, `🧹 Maintenance`.
- Corps : un ou plusieurs éléments de liste, sans titre.

| Commande | Effet |
|---|---|
| `python scripts/changelog.py check` | valide les fragments (la CI le fait par `tests/test_changelog_fragments.py`) |
| `python scripts/changelog.py preview` | affiche les notes de la prochaine version |
| `python scripts/changelog.py release X.Y.Z "Titre"` | écrit `## X.Y.Z - Titre` dans `CHANGELOG.md` et retire les fragments ; reste à écrire l'introduction |
