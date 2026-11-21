---
section: ✨ Nouveautés
---

- **Mission Control rééquilibre un agent bloqué** (#344). Un agent dont le provider est limité
  ou indisponible passe au provider suivant de l'équipe (un autre profil Claude d'abord, quand il y
  en a un) ; un agent qui échoue ou dont la réponse tourne en boucle passe à un modèle plus
  puissant ; la même tâche repart aussitôt, deux fois au plus, jamais au-delà du budget. Chaque
  décision s'affiche dans le journal et sur la carte, et une case coupe le rééquilibrage. La
  session affiche ce qu'elle a dépensé contre son budget, et un historique mesure la part des
  sessions composées automatiquement, les tokens des équipes automatiques contre les manuelles,
  les rééquilibrages et les budgets dépassés ; les estimations de tokens par rôle s'en calibrent.
