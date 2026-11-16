---
section: ✨ Nouveautés
---

- **La revue de PR par l'IA apprend des faux positifs** (#361) : chaque résultat d'une revue
  peut être accepté, rejeté ou marqué non applicable, avec une raison facultative (trop
  pointilleux, convention du projet, faux positif, exception de code hérité, autre). Les avis
  sont gardés dans `.workpilot/code_review_feedback.jsonl`. Un type de remarque rejeté trois fois
  de plus qu'accepté est rétrogradé en mineur, et retiré de la revue à six ; la revue dit
  combien de résultats elle a masqués et lesquels. La règle s'applique après la revue, donc avec
  tous les providers ; les résultats de sécurité et critiques ne sont jamais touchés.
