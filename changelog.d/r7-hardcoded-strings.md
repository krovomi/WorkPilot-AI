---
section: 🐛 Corrections
---

- **L'interface parle enfin la langue choisie partout.** Plus d'un millier de textes écrits en dur dans les
  composants (boutons, titres, champs, infobulles, messages d'attente) passent désormais par les
  traductions, en anglais et en français : un utilisateur francophone ne lit plus d'anglais dans les
  réglages, les vues GitHub, GitLab, Jira, Linear, la feuille de route ou la revue des tâches, et
  quelques panneaux restés en français s'affichent maintenant en anglais pour un anglophone. Au
  passage, des caractères mal encodés (`Â·`, `âŒ˜`) sont corrigés, et un bout de code qui
  s'affichait comme du texte dans la vue de refactorisation n'apparaît plus.
- **Un texte en dur ne peut plus revenir.** Un test lit chaque composant du renderer et refuse tout
  texte visible hors de `t()`. Les seules exceptions (noms de marques, commandes, unités) sont
  listées avec leur raison dans `jsx-literal-allowlist.ts`.
