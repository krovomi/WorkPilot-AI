# Tests instables : verdict, cause dans le code, historique, quarantaine (F195)

Le Flaky Test Detective lance la suite plusieurs fois (ou lit des rapports JUnit / TRX existants)
et signale les tests dont le résultat change. Issue #351 : dire **pourquoi** un test est instable,
s'il l'est **de plus en plus**, et en faire une **carte Kanban** pour le corriger ou le mettre en
quarantaine, sur toutes les stacks et sans modèle.

```
apps/backend/flaky_test_detective/
  analyzer.py   le taux d'échec et la cause probable lue dans les messages d'erreur (existant)
  insights.py   verdict, emplacement du test (fichier, ligne, corps), causes lues dans son code, stack
  history.py    l'historique local .workpilot/flaky-tests/history.json
  enrich.py     ajoute tout cela au rapport, et l'auteur du dernier changement (git log -1)
apps/backend/suite_runner/
  names.py      les parties d'un nom de test (conteneur, test) tel que le rapport le donne
  only.py       le filtre de chaque stack pour ne relancer que certains tests
apps/frontend/src/renderer/components/flaky-tests/
  FlakyTestCard.tsx   un test du rapport : verdict, preuves, historique, boutons de carte
  flaky-task.ts       la spec de la carte, traduite, dans les termes de la stack du test
```

## Verdict

| Taux d'échec | Verdict | Pourquoi |
|---|---|---|
| > 0,8 | `likely_bug` | échoue presque toujours : plus probablement un vrai bug qu'un test instable |
| ≥ 0,2 | `flaky` | instable confirmé |
| < 0,2 | `rare` | échec rare, à surveiller |

Un test qui échoue à chaque passe reste dans `alwaysFailing`, il n'est pas instable.

## La cause lue dans le code du test

`locate_test` retrouve le test à partir de son nom de rapport (`tests.test_x::test_y[1]`,
`Shop.Tests.CartTests.Adds(qty: 2)`, `src/cart.test.ts::Cart > adds`, `com.shop.CartTest::adds`,
`TestCart/empty`) parmi les fichiers de test du dépôt (au plus 5 000, lus sous la racine, sans
suivre de lien symbolique qui en sort). `source_causes` cherche dans son corps, commentaires
retirés : attente fixe ou délai (`timing`), horloge ou valeur aléatoire (`randomness`), réseau, port
fixe, fichier temporaire ou base (`network`), état global ou variable d'environnement écrits
(`shared_state`), ordre des tests (`test_order`), threads ou tâches parallèles (`concurrency`), et
une mise en place sans nettoyage (`resource_leak`). Chaque cause porte les lignes qui la montrent.
Quand l'analyse des messages n'a rien trouvé (`unknown`), la cause du code la remplace.

Le contenu du dépôt est une donnée (S2) : il n'entre dans aucun prompt, il est seulement affiché.

## Historique

Une passe `run` enregistre, par test, le nombre de passes et d'échecs, la date, le système
(`foundation.platform`) et si elle tourne en CI (variables `CI`, `GITHUB_ACTIONS`, `TF_BUILD`…).
Le résumé donne la première apparition, la tendance (pire, mieux, stable, comparée à l'observation
précédente), les systèmes où le test échoue et « CI seulement ». Fichier borné (30 observations par
test, 2 000 tests), jamais écrit à travers un lien symbolique. La lecture de rapports existants
(`scan`) n'écrit pas d'historique : elle ne sait pas quand ni où ils ont été produits.

## Relancer les seuls suspects

Une suite trop longue pour cinq passes peut confirmer ses suspects : `--only` (liste JSON, au plus
50 noms de 300 caractères, revalidée dans le main puis dans `FlakyOptions` en mode serveur) ajoute
le filtre de la stack : `pytest -k`, `vitest`/`jest -t`, `dotnet test --filter
FullyQualifiedName~`, `go test -run`, `mvn -Dtest` (+ `failIfNoSpecifiedTests=false`),
`gradle --tests`. Les noms sont réduits aux caractères d'un nom de test et chaque caractère spécial
de la syntaxe du filtre est échappé : le filtre choisit des tests, il n'ajoute jamais d'option. Une
stack sans filtre (ou des noms inutilisables) rend une erreur au lieu de relancer toute la suite.

## La carte Kanban

« Corriger sur une carte » crée une tâche (`sourceType: "flaky-tests"`) qui interdit les
corrections qui cachent le problème (ni skip, ni retry, ni délai allongé), donne les preuves
`fichier:ligne` et demande 10 passes vertes de suite. « Mettre en quarantaine » rédige la
quarantaine dans les termes de la stack : `pytest.mark.xfail(strict=False)`, fichier
`quarantine.test.ts` pour Vitest/Jest, catégorie `Quarantine` + `--filter Category!=Quarantine`
pour .NET, `@Tag("quarantine")` sur JVM, variable `QUARANTINE=1` en Go, `#[ignore]` + `--ignored`
en Rust, et l'équivalent pour Ruby, PHP, Swift, Dart, Elixir ; sinon une consigne générique. La
carte passe par le pipeline normal (worktree, branche, PR), jamais par une écriture directe.
