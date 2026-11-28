---
section: 🛠️ Qualité
---

- **Nettoyage du texte reçu et lecture des portées de mémoire réécrits plus simplement** : un seul motif retire commentaires HTML, blocs `<script>` et `<style>` à chaque passe, et une portée `team:` / `branch:` se lit sans expression régulière. Le comportement ne change pas.
