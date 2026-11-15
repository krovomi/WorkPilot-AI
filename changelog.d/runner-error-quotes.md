---
section: 🐛 Corrections
---

- **Messages d'erreur sans guillemets** : quand l'analyse échoue, Dérive de la documentation,
  Notebooks, i18n (analyse et traduction), API Watcher, Arbitre de consensus, Garde
  anti-injection, Onboarding (visite et statut), Regression Guardian et Conformité affichent le
  message tel quel, et non plus `"Project path does not exist: …"` entre guillemets avec ses
  `\n` ; un message sur plusieurs lignes garde ses retours à la ligne.
