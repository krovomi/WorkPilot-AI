---
section: 🐛 Corrections
---

- **Modifier le plan d'une tâche** n'écrase plus le plan : l'enregistrement depuis l'onglet
  Sous-tâches gardait une seule phase, renommait les champs et réécrivait les sous-tâches déjà
  lancées. Seules les sous-tâches en attente changent désormais, les phases du planificateur
  restent, et la tâche affichée ne bouge pas avant que l'enregistrement réussisse (il reste ouvert
  s'il échoue).
- **Demander des modifications du plan** laisse enfin écrire la raison : le champ n'apparaissait
  que pendant l'envoi. Un premier clic l'ouvre, un second envoie, Annuler le referme.
- **Fenêtre de tâche** : le texte et les images d'une demande de modifications ne passent plus à
  la tâche suivante ; le choix de la formule d'exécution est proposé de nouveau pour la tâche
  suivante ; une tâche ne se ferme plus quand son passage à « terminé » est refusé ; les
  messages, erreurs, gravités de conflit et boutons à icône ont leur texte en français et en
  anglais (« 1 fichier », « 1 commit ») et un nom lisible par les lecteurs d'écran.
- Retiré, avec la preuve : un résumé d'aperçu de fusion qu'aucun écran n'importait, et ses textes.
  La fenêtre de tâche, la revue (messages du worktree, état, retours de QA, confirmations), le plan
  et les sous-tâches sont testés par leur comportement.
