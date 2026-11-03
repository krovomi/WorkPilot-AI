---
section: 🐛 Corrections
---

- **Les réglages de tokens atteignent enfin le modèle** (F153). L'effort choisi sur une carte est
  envoyé à tous les modèles Claude qui l'acceptent (Sonnet 4.6 et 5.x, Haiku 5.5, Fable), plus
  seulement à Opus. Mistral met désormais l'entrée en cache (clé par tâche et phase), Grok reçoit
  son header de routage de cache, et Claude ne paie plus chaque écriture de cache au tarif d'une
  heure hors abonnement.
