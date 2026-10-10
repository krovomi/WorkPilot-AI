---
name: tdd-cycle
description: La méthode de la phase de codage — rouge, vert, refactor, sous-tâche par sous-tâche. Un test qui échoue pour la bonne raison avant le code, le code minimal qui le fait passer, le test le plus étroit relancé à chaque pas, et jamais un test affaibli pour passer. À utiliser pour implémenter une sous-tâche dont le comportement peut être vérifié par un test.
metadata:
  workpilot:
    provenance: "inspiré de obra/superpowers — test-driven-development (texte original)"
---

# tdd-cycle — le test d'abord, puis le code qui le fait passer

Une sous-tâche est finie quand un test dit qu'elle l'est. Écrire le test **avant**
le code n'est pas un rite : c'est la seule façon de savoir que le test sait
échouer. Un test écrit après coup contre du code qui marche déjà passe du premier
coup — y compris quand il ne vérifie rien.

## Le cycle

Pour chaque comportement de la sous-tâche, dans cet ordre :

1. **Rouge.** Écris le test qui décrit le comportement attendu, et lui seul.
   Lance-le. Il doit échouer — et **pour la bonne raison** : l'assertion sur le
   comportement manquant, pas une erreur d'import, une faute de frappe ou une
   fixture absente. Un test rouge pour une mauvaise raison ne prouve rien ;
   corrige-le jusqu'à ce que son échec dise « ce comportement n'existe pas ».
2. **Vert.** Écris le code **minimal** qui fait passer ce test. Pas la
   généralisation que la sous-tâche suivante demandera peut-être : elle aura son
   propre test. Relance le test le plus étroit possible (le fichier, la classe, la
   fonction), pas toute la suite.
3. **Refactor.** Le test vert, rends le code lisible : noms, duplication, place
   dans l'architecture du projet. Relance le même test après chaque changement.
   Un refactor qui casse un test n'est pas un refactor.

Quand la sous-tâche est finie, lance la suite du module touché une fois, pour
attraper ce que le test étroit ne voyait pas.

## Écrire le test comme le projet écrit les siens

- **Où.** À côté des tests existants du même code : même dossier, même
  convention de nom (`test_x.py`, `XTests.cs`, `x.test.ts`). Un projet .NET a
  ses tests dans un projet `*.Tests` ; Go et Rust à côté de la source.
- **Avec quoi.** Le framework et les bibliothèques que le projet référence déjà
  (FluentAssertions, Moq, pytest, Vitest…). Ne pas en introduire un nouveau pour
  une sous-tâche.
- **Quoi.** Un comportement observable — une valeur rendue, un état, un appel
  sortant — pas un détail d'implémentation qu'un refactor changera.

## Ce qui est interdit

- **Affaiblir un test pour qu'il passe** : supprimer une assertion, élargir une
  tolérance, ajouter un `skip`, attraper l'exception attendue sans la vérifier.
  Si un test existant casse, c'est soit le code qui est faux, soit l'exigence qui
  a changé — et le second cas se dit dans le rapport, il ne se décide pas en
  silence.
- **Mocker la chose testée.** Un mock remplace une frontière (réseau, disque,
  horloge), jamais le code sous test.
- **Déclarer vert sans avoir lancé.** « Ça devrait passer » n'est pas un résultat.

## Quand le cycle ne s'applique pas

- **Le projet n'a aucune infrastructure de test**, ou la sous-tâche ne touche que
  de la configuration, de la documentation ou une ressource statique : écris le
  code, vérifie-le autrement (build, lancement, lecture), et **dis-le** dans le
  rapport — « pas de test : <raison> ». Ne crée pas un framework de test entier
  pour une sous-tâche.
- **Le comportement n'est observable qu'à l'écran ou sur un appareil** : le test
  unitaire couvre la logique, et la vérification visuelle appartient à la phase
  `verify`.

## Rapport de sous-tâche

Termine par ces lignes :

```markdown
Tests ajoutés : <fichier::nom>, … (ou « aucun : <raison> »)
Rouge vérifié : oui | non (<raison>)
Tests: pass | fail
```
