---
name: spec-analyze
description: Relit spec.md et implementation_plan.json ensemble, avant l'écriture du code — exigences que personne n'implémente, ambiguïtés, doublons, dérive de vocabulaire, contradictions entre les deux documents. En lecture seule, produit un rapport sans modifier aucun artefact. À utiliser entre la planification et le codage, ou pour auditer un spec et son plan.
metadata:
  workpilot:
    provenance: "adapté de github/spec-kit — /speckit.analyze (MIT)"
---

# spec-analyze — la dernière relecture avant le code

Deux documents décrivent la même tâche : `spec.md` dit ce qu'il faut construire,
`implementation_plan.json` dit comment. Personne ne les a encore lus **ensemble**.

Le moment compte plus que la méthode. Un écart trouvé ici coûte une phrase dans
le plan ; le même écart trouvé par la QA coûte un cycle de correction sur du code
déjà écrit contre un plan incomplet. C'est la seule raison d'être de cette phase :
pas « relire le spec », mais le relire **quand la correction est encore gratuite**.

## Entrées

| Fichier | Ce qu'on y cherche |
|---|---|
| `<spec_dir>/traceability.json` | la couverture exigence → subtask, **déjà calculée** |
| `<spec_dir>/spec.md` | exigences, critères de succès, cas limites, marqueurs ouverts |
| `<spec_dir>/implementation_plan.json` | phases, subtasks, vérifications, dépendances |
| `AGENTS.md` / `CLAUDE.md` du projet | les conventions que le plan doit respecter |

**Ne recalcule pas la couverture.** `traceability.json` la contient : `coverage.uncovered`
(exigences qu'aucune subtask ne réclame), `coverage.unknown_refs` (subtasks qui citent
une exigence que le spec ne déclare pas), `open_questions` (les `[NEEDS CLARIFICATION]`
restants). Une deuxième mesure du même chiffre, faite de tête, ne peut que diverger de
la première. Lis-la, cite-la, et passe le budget sur ce qu'un parseur ne sait pas voir.

Si `traceability.json` est absent ou dit `"applicable": false`, note-le en une ligne et
continue : les cinq autres catégories ne dépendent pas de lui.

## Les six catégories

| # | Catégorie | La question |
|---|---|---|
| 1 | **Couverture** | Quelle exigence n'est réclamée par aucune subtask ? Quelle subtask ne sert aucune exigence ? |
| 2 | **Ambiguïté** | Quel terme non mesurable (« rapide », « robuste », « sécurisé ») décide d'un choix d'implémentation sans critère ? |
| 3 | **Sous-spécification** | Quelle exigence n'a pas de critère d'acceptation vérifiable ? Quelle subtask n'a pas de `verification` exploitable ? |
| 4 | **Contradiction** | Où les deux documents se contredisent — un chemin de fichier, un nom d'endpoint, un ordre de dépendances, un modèle de données ? |
| 5 | **Doublon** | Deux exigences qui disent la même chose sous deux noms ? Deux subtasks qui écriraient le même fichier ? |
| 6 | **Conventions** | Que fait le plan que `AGENTS.md` / `CLAUDE.md` du projet interdit — chemin en dur, dépendance non épinglée, texte non i18n, contournement d'une abstraction ? |

Les catégories 4 et 6 sont celles qui justifient le passage. Les trois premières
attrapent des oublis ; la 4 attrape le moment où quelqu'un a corrigé un document et
pas l'autre, et la 6 le moment où un plan correct dans l'absolu est faux **ici**.

## Sévérité

| Niveau | Ce qui le mérite |
|---|---|
| `CRITICAL` | le build produira quelque chose qui n'est pas ce qui a été demandé, ou ne compilera pas |
| `HIGH` | une exigence sera manquée, ou une contrainte du projet violée |
| `MEDIUM` | un choix sera fait par défaut faute de critère ; corrigeable en une phrase |
| `LOW` | vocabulaire, redondance, lisibilité |

Le niveau se justifie par une conséquence, pas par un ressenti. Si tu ne peux pas
écrire la phrase « sans ça, il se passera X », ce n'est pas `CRITICAL`.

## Rapport

Termine par ceci, et rien d'autre :

```markdown
## Analyse spec ↔ plan

Couverture (traceability.json) : <coverage.summary>, <N> question(s) ouverte(s)

| # | Sévérité | Catégorie | Où | Constat | Correction proposée |
|---|---|---|---|---|---|
| 1 | HIGH | Couverture | spec.md FR-004 | aucune subtask ne la réclame | ajouter une subtask à la phase 2 |

Verdict : PRÊT | PRÊT AVEC RÉSERVES | À CORRIGER AVANT CODAGE
```

- **20 constats au maximum.** Au-delà, garde les plus graves et dis combien tu as écarté.
- Un constat par ligne, avec un **emplacement précis** — `FR-004`, `subtask-2-1`,
  `spec.md:« Files to Modify »`. « Le spec est vague » n'est pas un constat.
- `À CORRIGER AVANT CODAGE` seulement s'il existe au moins un `CRITICAL` ou `HIGH`.

## Ce que cette phase ne fait pas

- **Elle n'écrit rien.** Ni `spec.md`, ni le plan, ni le code. La correction est une
  décision, et elle appartient à qui relit le rapport. C'est aussi pour ça que la phase
  tourne en lecture seule : un relecteur qui peut réécrire le document qu'il relit finit
  par relire le sien.
- **Elle ne conçoit pas.** « J'aurais fait autrement » n'est pas un constat de cohérence.
  Le désaccord de fond a sa propre phase (`review`, `adversarial-review`).
- **Elle n'invente pas d'exigence.** Ce qui manque au spec est un `[NEEDS CLARIFICATION]`
  à signaler, pas un besoin à ajouter soi-même.
