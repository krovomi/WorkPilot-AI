---
section: 🔒 Sécurité
---

- **Garde contre les paquets inventés.** Un agent peut ajouter une dépendance qui n'existe pas, et
  quelqu'un peut la publier ensuite pour faire installer son code (*slopsquatting*). Après
  l'approbation de la QA, les paquets que la tâche a ajoutés à un manifeste (npm, PyPI, NuGet,
  Maven/Gradle, Cargo, Go, Composer, pub, RubyGems) sont cherchés sur leur registre public. Un
  paquet inconnu du registre renvoie le QA fixer le remplacer. Un flux privé déclaré, un paquet
  déjà installé, un registre qui ne répond pas ou le mode hors-ligne strict ne bloquent jamais :
  le verdict est « inconnu ». Un nom à une frappe d'un paquet populaire avertit. Nouvelle porte
  dure `deps-exist` sur les workflows qui écrivent du code ; `WORKPILOT_DEPENDENCY_GUARD=0` coupe
  la garde.
