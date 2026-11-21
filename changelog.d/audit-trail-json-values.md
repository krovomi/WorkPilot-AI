---
section: 🐛 Corrections
---

- **Journal d'audit** : un événement dont le contenu porte une valeur que JSON ne sait pas écrire
  (`NaN`, infini, par exemple un score de risque) est refusé avant d'être chaîné. Il était inscrit
  tel quel, puis la réponse au panneau et les exports SOC2 et RGPD de ce journal échouaient.
