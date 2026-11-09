# Red team (QA adverse, F186)

Le reviewer QA vérifie que le code fait ce que dit la spec ; la red team essaie de le **casser**.
Après l'approbation de la QA, une session écrit des tests d'attaque dans le framework de test du
projet, et WorkPilot les lance lui-même. Issue #381.

```
apps/backend/red_team/
  surface.py   ce qui est attaqué : fonctions des lignes changées, routes HTTP, appels à un modèle ;
               avertissements de concurrence trouvés sans modèle
  payloads.py  le catalogue d'entrées hostiles par type de valeur
  prompt.py    le prompt de la session (prompts/red_team.md + surface + catalogue + tests à imiter)
  reports.py   les rapports JUnit / TRX / cargo, et plantage contre inattendu
  engine.py    la copie jetable, la session, le nettoyage, les deux lancements, le verdict
apps/backend/suite_runner/   la suite lancée avec son rapport machine (partagée avec le détecteur de tests instables)
apps/backend/qa/red_team_gate.py  la porte QA, la demande de correction, le rejeu
apps/backend/qa/red_team_api.py   GET /api/red-team/ et POST /api/red-team/run pour la carte de la tâche
apps/backend/workflows/hard_gates.py  `attack-resistant`, lu dans <spec_dir>/red_team.json
```

## Quand elle tourne

Après le reviewer et les autres portes (dépendances, preuves, architecture, couverture, mutation),
dans `qa/loop.py`. Selon `WORKPILOT_QA_RED_TEAM` :

| Valeur | Effet |
|---|---|
| `complex` (défaut) | les tâches dont la spec a été évaluée `complex` |
| `always` | toute tâche qui a changé du code source |
| `off` | jamais ; l'enregistrement le dit et la porte dure lit « inconnu » |

Un workflow qui déclare la porte dure `attack-resistant` la fait tourner quel que soit le réglage,
sauf `off`. Une valeur inconnue vaut `complex` : une faute de frappe ne l'active pas pour tout, ni
ne la coupe. Le bouton « Attaquer » de la carte lance une attaque neuve à la demande.

## Les cinq modes

La session (type d'agent `red_team` : lecture, écriture, shell ; ni web ni serveur MCP) reçoit la
surface d'attaque et le catalogue, et choisit les modes qui s'appliquent :

1. **entrée malformée** : chaînes vides, Unicode, longueur max + 1, SQL, HTML, chemins, `null`…
2. **cas limite** : vide, un, 10 001 éléments, 29 février, changement d'heure, débordement ;
3. **injection de prompt** : pour le code qui passe du texte à un modèle (Anthropic, OpenAI,
   `IChatClient`, Semantic Kernel, LangChain, Spring AI, AI SDK, Ollama…), l'appel au modèle est
   simulé comme dans les tests existants et l'attaque vérifie que l'instruction cachée n'est pas
   suivie ;
4. **concurrence** : la surface signale sans modèle, sur toutes les stacks, une vérification puis
   un usage de fichier (`File.Exists` puis `File.Create`, `os.path.exists` puis `open`…) et un état
   partagé écrit depuis du code concurrent sans verrou dans le fichier ; la session peut écrire un
   test multi-thread ;
5. **ancien bug** : un correctif de l'historique git des mêmes fichiers.

Chaque attaque est un test qui affirme le **bon** comportement (rejet comme ailleurs dans le code,
ou bon résultat), nommé avec `red_team` / `RedTeam`, listé dans `red-team-attacks.json`.

## Où elle tourne

Jamais dans le worktree de la tâche : la copie jetable de la porte de mutation
(`mutation_gate.sandbox.scratch_copy`). Après la session, tout fichier non-test qu'elle a changé
est remis comme la tâche l'avait laissé : une attaque qui modifie le code attaqué ne prouve rien.
Rien de ce qu'elle écrit n'atteint la branche.

## Comment WorkPilot juge

WorkPilot lance les tests d'attaque lui-même et ne croit pas ce que la session a dit :

- .NET, pytest, Vitest, Jest (`jest-junit`), Maven, Gradle, Go : la commande de la stack avec son
  rapport TRX ou JUnit (`suite_runner`), restreinte aux fichiers d'attaque quand le lanceur le
  permet ;
- Rust : les lignes `test x ... FAILED` de cargo ; PHP, Ruby, Dart, Swift, Elixir : le fichier
  d'attaque seul (une attaque par fichier), son code de sortie.

Puis chaque attaque :

| Résultat | Quand | Effet |
|---|---|---|
| **plantage** | une erreur de programmation s'est échappée (`TypeError`, `NullReferenceException`, `IndexOutOfRangeException`, `panic:`, `NullPointerException`…) **et** sa trace nomme un fichier source changé par la tâche | bloquant : le fixer reçoit l'attaque, son entrée et l'échec |
| **inattendu** | tout autre échec : le code a répondu autre chose que ce que l'attaque attendait | affiché sur la carte, jamais bloquant : l'attente de l'attaque peut être la fausse |
| **a tenu** | le test passe | |
| **instable** | l'échec ne se reproduit pas au second lancement | écarté |
| **non lancée** | le lanceur ne la rapporte pas (test qui ne compile pas, nom introuvable) | écartée |

La règle de la trace écarte le faux positif le plus courant : une attaque qui appelle le code de
travers lève une `TypeError` dans le fichier de test, pas dans le code de la tâche. Un refus voulu
(`ValueError`, `ArgumentException`, `IllegalArgumentException`) n'est jamais un plantage.

Verdict : `fail` s'il y a un plantage ; `pass` si des attaques ont tourné sans plantage ; `none`
si le diff n'a pas de ligne source ; `unknown` sinon (aucune attaque listée, session en échec,
suite qui ne compile pas). Jamais vert par défaut.

## Les passes suivantes

Les fichiers d'attaque sont gardés dans `red_team.json` (64 Ko chacun, 12 au plus). Après le fixer,
la passe QA suivante **rejoue** ces attaques sans modèle : une session par tâche, quelle que soit
la longueur de la boucle. Une base qui change (rebase) relance une vraie attaque.

## Hors périmètre

- L'enregistrement des attaques réussies dans la boucle d'apprentissage pour les tâches suivantes.
- Les attaques réseau sur l'application lancée (la boucle `verify` appelle déjà les endpoints
  modifiés avec leurs schémas).
