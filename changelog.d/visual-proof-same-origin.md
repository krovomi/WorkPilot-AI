---
section: 🐛 Corrections
---

- **Preuve visuelle, navigation web** : une étape du plan de navigation ne mène la fenêtre de capture qu'à une page de l'application montrée (même origine). Une adresse ailleurs (autre hôte ou port, `file:`, `data:`) est ignorée et journalisée, et la capture montre la page déjà atteinte.
