---
feature: "Smart Estimation : calibration par dépôt"
summary: >-
  Estimé contre réel à chaque merge (coût, tokens, QA, fichiers) ; médiane des ratios sans
  aberrations, par dépôt et catégorie ; fourchette, dimensions, ajustement manuel, reset.
---

# Smart Estimation : la boucle de calibration (`estimation_calibration`)

> Pourquoi l'estimation apprend de chaque dépôt, et comment. Issue : #367. Règles :
> [`docs/CLAUDE.md`](../CLAUDE.md), [`security.md`](../rules/security.md) (S4, S6).

Smart Estimation donnait un score de complexité et des chiffres génériques tirés de tâches
semblables (`services/smart_estimation_service.py`). Il n'apprenait pas : sur un dépôt aux tests
lents ou à la CI capricieuse, l'estimation restait à côté, et personne ne pouvait lui dire « ici,
c'est plus ». La boucle compare désormais chaque spec fusionnée à ce qu'elle a consommé, et
corrige les estimations suivantes du même dépôt.

```
apps/backend/estimation_calibration/
  categories.py  catégorie d'une spec d'après ses mots (liste fermée, défaut feature)
  dimensions.py  algorithmique, intégration, risque de conflit, tests ; « incertain » sans signal
  model.py       facteur, fourchette et confiance par métrique ; ajustements ; qualité
  store.py       .workpilot/estimation/calibration.json, sous le verrou de foundation.json_ledger
  capture.py     abonné de core.merge_event : estimé contre réel de la spec fusionnée
apps/backend/runners/estimation_calibration_runner.py   ajuster, réinitialiser
apps/frontend/src/main/ipc-handlers/smart-estimation-calibration-handlers.ts
apps/frontend/src/renderer/components/smart-estimation/EstimationCalibrationPanel.tsx
```

## Ce qui est comparé

Quatre métriques, toutes indépendantes du provider : coût, tokens, itérations de QA, fichiers
modifiés. **Aucune durée** : la règle produit est de ne jamais en estimer, donc aucune n'est
enregistrée ni affichée.

- **L'estimé** est celui que le dialogue a gardé sur la tâche (`task_metadata.json`,
  `smartEstimate.calibrationInputs`) : pour chaque métrique, le chiffre générique (`base`) et le
  chiffre affiché (`value`). Le ratio se calcule contre `base`, jamais contre le chiffre déjà
  corrigé, pour que les facteurs ne se composent pas d'une estimation à l'autre.
- **Le réel** est lu là où le build l'a déjà laissé : coût et tokens dans
  `.workpilot/cost_data.json` (chaque session de chaque provider y est notée par
  `core.usage_tracker`), itérations de QA dans `implementation_plan.json`, fichiers dans le diff
  du merge (`foundation.git_executable`, liste d'arguments).

Seule une spec **fusionnée** alimente le jeu de données : une spec abandonnée ne publie pas de
merge, donc ne biaise rien. Une spec fusionnée deux fois garde son dernier résultat.

## Le modèle

Une médiane des ratios `réel / estimé` plutôt qu'une régression : un dépôt n'a que quelques
dizaines de specs, et la médiane ne bascule pas sur une spec qui a explosé pour une raison
extérieure. Les aberrations sont exclues par les barrières de Tukey (1,5 × IQR, avec un plancher
sur l'écart pour qu'un jeu très régulier n'exclue pas tout). La fourchette est le 20e–80e centile
des ratios appliqué au chiffre générique ; la confiance grandit avec le nombre de specs et baisse
quand elles se dispersent.

Une catégorie a besoin de 5 specs à elle ; en dessous, le facteur du dépôt entier sert ; en
dessous encore, le chiffre générique s'affiche avec « pas assez d'historique ». Un facteur
au-delà de ×1,3 ou en deçà de ×0,7 est signalé. Les ratios par provider (au moins 2 specs)
disent lequel consomme plus sur ce dépôt. La précision des estimations passées (MAPE par
métrique, part gardée sans ajustement, largeur moyenne des fourchettes) se lit sur le panneau.

Aucun appel de modèle, aucune dépendance nouvelle : tous les providers lisent et alimentent le
même historique.

## Ajuster, réinitialiser

« Ajuster l'estimation » garde le score de la personne contre celui de l'estimateur ; à partir de
3 ajustements (par catégorie, sinon pour le dépôt), leur écart médian déplace les scores
suivants. « Réinitialiser la calibration » oublie tout après une refonte, avec une confirmation.

## Frontières

- Le renderer ne donne qu'un id de projet, jamais un chemin : le main le résout par le
  `projectStore` (règle S6). Catégorie en liste fermée, scores entiers de 1 à 13, revérifiés
  par le runner. Le runner est lancé sans shell, avec `pythonRunnerEnv`.
- Le fichier de calibration n'est ni lu ni écrit quand `.workpilot` ou `estimation` est un lien
  symbolique : un dépôt ne peut pas diriger l'écriture ailleurs sur le disque. Le nom de spec
  lu au merge est un nom simple (`[A-Za-z0-9][A-Za-z0-9._-]*`) avant de devenir un chemin ou une
  branche ; chaque nombre lu sur le disque est vérifié (fini, positif).
- `estimation_calibration` est une feuille qui n'importe que `foundation`
  (`tests/test_import_contracts.py`).
