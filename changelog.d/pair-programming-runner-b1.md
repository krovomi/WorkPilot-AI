---
section: 🐛 Corrections
---

- **Pair programming** : un message envoyé à l'IA pendant la session ne lui parvenait jamais. Le runner l'affichait dans le fil comme « Developer says », vidait le fichier des messages, puis continuait sans le transmettre. L'IA le reçoit maintenant comme le tour suivant, dès que son étape en cours se termine, et le fil dit que le message est arrivé.
- **Pair programming** : les fichiers créés ou modifiés et les commandes lancées sont rapportés quel que soit le provider. Seuls `create_file`, `write_file`, `edit_file`, `str_replace_editor` et `bash` étaient reconnus : avec Claude (`Write`, `Edit`, `Bash`), aucun appel d'outil n'était rapporté, et avec un provider passé par l'exécuteur de WorkPilot, une commande (`run_command`) jamais. Le conflit de périmètre se juge sur les fichiers que l'IA a touchés, et non plus sur un mot de la réponse.
- **Retiré** : le « mode démo » du pair programming, qui annonçait la création de `src/api/auth.py` et de `tests/test_auth.py` sans rien écrire. Une session qui ne peut pas démarrer le dit. Le runner passe à 100 % de couverture (lot B1h).
