---
section: ✨ Nouveautés
---

- **L'analyse i18n propose les clés, trouve ce qui est faux et traduit sur une branche de revue** (F193). Chaque texte codé en dur reçoit une clé dans le style du projet et l'appel à coller pour sa stack ; les clés orphelines (en tenant compte des clés construites à l'exécution), les phrases restées en langue de référence, les variables qui diffèrent, les formes de pluriel de chaque langue (CLDR) et les styles qui ne s'inversent pas en droite à gauche sont signalés, avec un score de complétude par langue. Les clés manquantes peuvent être traduites par le modèle actif sur une carte de revue, jamais dans le dossier du projet ; une traduction qui perd une variable ou une balise est écartée. Les catalogues YAML de Rails `en.yml` / `fr.yml` sont enfin comparés entre eux (#346).
