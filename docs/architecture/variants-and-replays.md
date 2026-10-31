# Variantes et rejeux : deux paires qui se ressemblent (ADR)

Le plan du 29 octobre (A3) relevait deux doublons apparents dans `apps/backend/` : deux
mécanismes de variantes (`best_of_n`, `parallel_variations`) et deux façons de rejouer
(`replay`, `bench`). Une décision par paire : garder, fusionner ou supprimer.

## ADR 1 · `best_of_n` garde les variantes, `parallel_variations` est supprimé

**Contexte.** `parallel_variations/` copiait une spec dans `<spec>/variations/<label>/` et
comparait des dossiers. Il ne lançait aucun agent, ne touchait pas git et ne fusionnait rien.
Plafonné à 1 par défaut (`WORKPILOT_PARALLEL_VARIATIONS`), il était éteint. Sa seule interface,
`VariationsDialog`, vivait dans `AgentToolsButton`, un composant qu'aucun écran ne monte : la
boîte de dialogue était inatteignable, et son texte n'était pas traduit. `best_of_n/` répond à la
même question sur une vraie tâche du Kanban : N moteurs, N worktrees, des builds réels, un
classement chiffré et un choix humain ([best-of-n.md](best-of-n.md)).

**Décision.** Supprimer `parallel_variations` : le paquet, sa route `/api/parallel-variations/*`
(montage, catalogue d'autorisations, permission de la route d'écriture), ses tests, la
boîte de dialogue, ses trois appels dans `agent-tools-api.ts`, l'entrée « variations »
d'`AgentToolsButton` et la variable de configuration.

**Conséquences.** Un seul mécanisme de variantes, celui qui construit vraiment. Rien de visible
ne disparaît : la boîte de dialogue n'était montée nulle part. Le reste noté sous F9 (l'indicateur
`has_self_review` des variations, que plus rien n'écrivait) part avec elle. Les dossiers
`variations/` qu'une ancienne version aurait écrits dans une spec restent sur disque ; rien ne
les lit plus.

## ADR 2 · `replay` et `bench` restent séparés : ils ne répondent pas à la même question

**Contexte.** Le mot « replay » nomme quatre choses dans le backend :

| Où | Ce que c'est | La question |
|---|---|---|
| `replay/` | l'enregistrement des sessions d'agent (pas, outils, décisions), lu par la vue Agent Replay ; points de contrôle, scores de décision, carte de chaleur des fichiers | « qu'a fait cette session, et où a-t-elle hésité ? » |
| `bench/` | des cartes terminées reconstruites depuis le commit d'avant, par moteur, jugées par leurs propres tests ([repo-bench.md](repo-bench.md)) | « quel moteur réussit ce genre de carte, à quel coût ? » |
| `harness/application/replay.py` | des sessions enregistrées rejouées contre une base à chaque PR ([context-harness.md](context-harness.md), lot 8) | « ce changement du harness a-t-il fait régresser le contexte ? » |
| `learning_loop/replay.py` | les deux bras d'une règle apprise, avec et sans elle | « cette règle aide-t-elle ? » |

`replay/` et `bench/` ne partagent ni code, ni données, ni question : l'un lit ce qui s'est
passé, l'autre refait le travail pour le noter. Les fusionner mettrait un enregistreur de
débogage et un banc noté derrière une même interface qui n'aurait rien de commun à offrir.

**Décision.** Garder les deux, sans fusion. Le sort de la vue Agent Replay, marquée expérimentale,
se décide avec les autres vues sur la donnée d'usage locale (T5), pas ici.

**Ce qu'il faut savoir de `replay/`.** Les « forks » de Time Travel enregistrent une demande
(point de contrôle, prompt modifié, fournisseur et modèle) mais rien ne les exécute : aucun code
ne lit `get_fork_context` pour relancer une session. « Que se serait-il passé avec un autre
moteur » est la question de `bench` et de Best-of-N, qui la traitent vraiment. Si la vue Agent
Replay est gardée après T5, son formulaire de fork doit soit être branché, soit disparaître.

Le champ de clé d'API du fork part dès maintenant : aucune interface ne le remplissait, et une
clé passée par l'API n'aurait servi qu'à être écrite en clair dans le fichier du fork. Le main ne
transmet plus au backend que les champs connus d'un fork (`forkBody`,
`time-travel-handlers.ts`), et un fichier de fork écrit par une version précédente avec une clé
est réécrit sans elle à sa première lecture (`TimeTravelEngine._read_fork_file`).

## Ce qui le garde

- `tests/test_time_travel_forks.py` : une demande de fork n'a plus de champ de clé, et un
  ancien fichier qui en porte une la perd à la lecture.
- `apps/frontend/src/main/ipc-handlers/time-travel-handlers.test.ts` : le main ne transmet
  que les champs d'un fork, en chaînes.
