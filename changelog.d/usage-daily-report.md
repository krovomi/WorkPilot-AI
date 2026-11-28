---
section: ✨ Nouveautés
---

- **Le rapport d'usage quotidien par e-mail** (mode serveur). Chaque organisation reçoit à 9 h
  (heure de Paris par défaut, `WORKPILOT_REPORT_TIMEZONE`) le rapport de la veille : tokens et
  coût, part du budget mensuel, personnes actives, nouvelles et sans activité, runs, réussites,
  échecs, tâches fusionnées et coût par tâche livrée, chacun face à la veille et à la moyenne des
  7 jours ; les 5 plus gros consommateurs, la répartition par fournisseur et modèle, les causes
  des échecs et l'alerte de budget à 80 % et 100 %. Heure, fuseau, jours, destinataires (une
  adresse hors de l'organisation est signalée), langue, noms ou non, rapports hebdomadaire et
  mensuel se règlent par organisation (`/admin/usage/report/settings`), chaque changement audité.
  Un rapport ne part qu'une fois, même après un redémarrage, et un serveur arrêté à l'heure
  l'envoie à son retour ; sans SMTP, il se lit dans l'app (`GET /admin/usage/report`). Aucun
  prompt, code ni texte saisi n'y figure, et l'effacement d'un compte retire son adresse des
  destinataires.
