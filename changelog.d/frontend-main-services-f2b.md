---
section: 🧪 Filets de test
---

- **Couverture frontend, lot F2b (détection des outils en ligne de commande)** : le module qui trouve Python, Git, `gh`, `glab`, Claude CLI et Copilot CLI passe de 29 % à 100 % des instructions, des fonctions et des lignes (99 % des branches). Les tests décrivent une machine (fichiers présents, réponse de chaque `--version`, PATH, `where.exe`, système) et font tourner la vraie détection dessus, par l'API synchrone et par l'API asynchrone, qui doivent trouver le même outil.
- **Python Homebrew sur macOS** : la détection asynchrone avait sa propre liste, qui essayait `python3` avant `python3.13` et oubliait les versions de `/usr/local/bin` (Mac Intel). Les deux détections lisent maintenant la même liste, de la version la plus récente à la plus ancienne, et la détection synchrone ne lance plus deux fois `--version` sur l'interpréteur retenu.
- Code jamais exécuté retiré : une seconde recherche NVM de Claude CLI, identique à la première et lancée juste après elle, et un test « application packagée ? » refait dans une fonction que seul ce cas appelle.
