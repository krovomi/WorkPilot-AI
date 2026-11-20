---
section: 🐛 Corrections
---

- **CI/CD Triggers et Self-Healing vérifient ce qu'ils reçoivent** : le déclenchement d'un
  pipeline suit le mode hors-ligne strict du projet et ne suit plus de redirection ; les valeurs
  envoyées par la page (fournisseur, branche, workflow, ids, réglages, source de production) sont
  contrôlées avant de lancer le runner, et la configuration d'une source de production lui
  parvient sur son entrée standard.
