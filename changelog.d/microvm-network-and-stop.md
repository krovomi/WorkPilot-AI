---
section: 🐛 Corrections
---

- **MicroVM Docker.** La VM d'une tâche n'atteint que les hôtes de la liste de la tâche, une
  commande arrêtée au délai s'arrête aussi dans la VM, sbx est lancé sans les identifiants de
  l'hôte, et OpenCode s'installe dans la VM sans Node.
