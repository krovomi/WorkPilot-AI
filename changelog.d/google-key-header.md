---
section: 🐛 Corrections
---

- **Clé Google** : la vérification d'une clé Google ou Gemini et l'analyse d'image par Gemini
  envoient la clé dans l'en-tête `x-goog-api-key`, comme le fait déjà le reste de l'app, et non
  plus dans l'adresse.
