---
section: 🐛 Corrections
---

- **Copilot : seuls les modèles de ton compte sont proposés.** La liste des modèles Copilot (Arena, sélecteurs) vient maintenant de l'API Copilot avec ton propre jeton : un modèle absent de ton abonnement ou désactivé par ton organisation n'apparaît plus, au lieu d'échouer en `model_not_supported`. Dans l'Arena, un modèle refusé échoue avec un message clair au lieu d'être remplacé en silence par un autre ; ailleurs, le modèle de repli est choisi parmi ceux que ton compte sert.
