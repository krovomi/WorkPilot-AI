---
section: 🐛 Corrections
---

- **Prompts de l'Incident Responder** : pour un incident CI/CD, le message de commit, la branche, le
  diff, les tests en échec, les erreurs de build et la sortie des tests sont cités comme une
  donnée, comme l'étaient déjà ceux d'un incident de production. Le nom du fichier d'un incident
  proactif est nettoyé avant d'être cité. Chaque champ du modèle de prompt est rempli une seule
  fois : un texte qui nomme un autre champ reste ce texte.
