---
section: ✨ Nouveautés
---

- **Les failles de la QA classées par ce qui tourne vraiment** (#364). Le rapport de sécurité de
  la QA range désormais ses trouvailles en quatre sections : critiques et exposées, critiques mais
  dormantes, moyennes, informatives. Le classement vient de ce que les points d'entrée du projet
  atteignent (routes, handlers, `main`, commandes, dans tout langage) et des incidents de
  production des 30 derniers jours déposés dans `.workpilot/incidents/` (Sentry, Datadog,
  CloudWatch, New Relic…), avec le nombre d'utilisateurs touchés quand l'outil le donne. Une
  dépendance que le projet ne déclare pas est marquée transitive, un code chargé par son nom
  rend l'atteignabilité incertaine, et un secret écrit dans le dépôt n'est jamais rétrogradé. Le
  fixer reçoit les failles exposées en premier ; ce qui bloque un build suit toujours la gravité.
