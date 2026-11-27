---
feature: Validation par niveaux
summary: >-
  Une PR reçoit un niveau N0 à N3 lu sans modèle (type, couches, chemins sensibles, taille, CI,
  revue croisée) : N0 et N1 fusionnent seules quand tout est vert, N2 et N3 attendent une
  personne ; section approvals de workpilot.policy.yaml qui ne peut que durcir ; observe par défaut.
---

# Validation par niveaux (`approvals`)

> Plan d'ensemble (Claude Ship, code mode, Docker Sandboxes) : lot A1. Ce lot livre le moteur et
> son runner ; le merge des cartes (A2), le stack autopilot de ce dépôt (D1) et l'adaptateur
> Claude Ship (A3) le lisent ensuite.

## Le problème

Le suivi de la PR (`pr_followup`) mène une carte jusqu'au vert, puis s'arrête : « le merge reste à
une personne ». Le stack autopilot de ce dépôt fait l'inverse : toute PR verte vers `develop` est
fusionnée. Ni l'un ni l'autre ne distingue une montée de version de patch d'une PR qui touche
l'authentification et trois couches. Claude Approvals (Claude Ship) sait le faire, mais seulement
sur GitHub, avec Claude, sur un plan Team ou Enterprise.

## Les quatre niveaux

| Niveau | Quand | Action |
|---|---|---|
| N0 `auto` | montée de version (manifestes, lockfiles et texte seulement), documentation seule | fusion dès que la CI est verte |
| N1 `review` | tout autre changement de code dans une seule couche, sous les limites | fusion quand la CI est verte **et** que la revue croisée est d'accord (`require_review`) |
| N2 `human` | `feat`, changement cassant, plus de couches, de fichiers ou de lignes que les limites, migration, contrat public (OpenAPI, protobuf, GraphQL), score de confiance sous la limite, montée majeure, montée qui touche la CI | une personne valide |
| N3 `locked` | chemins sensibles (secrets, auth, crypto, données personnelles, paiement), fichiers de politique et d'instructions d'agent, `files.requires_review`, fichiers de CI hors montée de version, section invalide | une personne valide ; rien ne l'abaisse |

Le niveau le plus strict atteint par un seul fichier ou un seul fait l'emporte. Une CI rouge ou une
revue croisée en désaccord bloque (`blocked`) quel que soit le niveau ; une CI pas encore finie fait
attendre (`wait`).

## Les faits, sans modèle

`approvals/facts.py`, pour toutes les piles et toutes les forges :

- **type** : titre conventionnel (`feat`, `fix(api)!`…), `chore(deps)` / `build(deps)` et les
  titres de Dependabot et Renovate (`Bump x from 1.2.3 to 1.3.0`, `Update dependency x to v2`) donnent
  `deps` ; sans préfixe, le type de la carte (`tasks/classify.py`) ;
- **montée** : `major`, `minor`, `patch` lus du titre ; sous 1.0.0 une mineure compte comme majeure
  (semver) ; sans versions, `unknown`, qui ne fusionne jamais seule ;
- **couches** : celles de `architecture/clean_layers.py` quand le projet a une architecture propre
  (projets .NET `Shop.Domain`, dossiers `domain`/`application`…), et pour chaque fichier hors couche,
  sa zone de code (`apps/backend`, `src/Shop.Api`, `lib`) ; le texte, la doc, la CI, les tests et
  les manifestes ne sont pas une zone ;
- **fichiers et lignes** : `git diff --numstat -M` de la base de fusion à la tête, état committé
  seulement ; une référence git étrange ou un git qui échoue donne une erreur, jamais un niveau ;
- **CI, revue, confiance** : passés par l'appelant (états de la forge, verdict de
  `cross_review`, score de `agent_safety`). Un fait inconnu ne satisfait aucune comparaison.

Les chemins sensibles et protégés sont comparés en minuscules : `Auth/`, `auth/` et `AUTH/` sont le
même dossier sous Windows et macOS.

## La politique

Section `approvals` de `workpilot.policy.yaml`, lue depuis le checkout principal (jamais depuis le
worktree où l'agent pourrait l'écrire) :

```yaml
approvals:
  mode: observe            # off | observe | enforce ; absent : ne restreint rien
  require_review: true     # N1 attend l'accord de la revue croisée
  major_bumps: human       # human | auto
  limits: { max_files: 20, max_lines: 400, max_layers: 1, min_trust: 60 }
  sensitive: ["src/Ledger/**"]       # ajoutés aux chemins sensibles intégrés
  rules:                             # ne peuvent que durcir
    - purpose: "Le module de facturation passe par une personne"
      paths: ["src/Billing/**", "!src/Billing/**/*.md"]
      if: "pr/type != docs AND rule/files_changed >= 1"
      tier: human                    # review | human | locked (N1 | N2 | N3)
```

**Une règle ne peut que durcir.** `tier: auto` est refusé : abaisser un niveau intégré ferait d'une
faute de frappe un merge sans personne. Les globs suivent ceux des garde-fous (`**` traverse les
dossiers), relatifs au dépôt, `!` pour exclure.

**`if`** est une petite grammaire fermée (`approvals/conditions.py`), jamais `eval` : faits
`pr/type`, `pr/breaking`, `pr/bump`, `pr/files_changed`, `pr/diff_lines`, `pr/layers`,
`pr/layer_names`, `pr/base`, `pr/labels`, `ci`, `review`, `trust`, `rule/files_changed` ;
opérateurs `= != < <= > >=`, `HAS` pour une liste, `AND OR NOT`, parenthèses (8 niveaux),
1 024 caractères.

**Invalide = N3.** Une section fausse (clé inconnue, valeur hors bornes, glob absolu, règle sans
`purpose`) n'est jamais lue à moitié : chaque PR du projet passe N3 et l'erreur est listée. Au
contraire des autres sections de gouvernance, elle **n'arrête pas les agents** : elle décide qui
fusionne, pas ce qu'un agent a le droit de faire. Les garde-fous (`security/guardrail_policy.py`)
acceptent donc la clé dans la couche du dépôt sans la juger, et la refusent dans les autres couches.

## Les deux interrupteurs

| Réglage | Où | Valeurs |
|---|---|---|
| l'app | Paramètres → Sécurité → Validation par niveaux, passé au suivi de la PR par `WORKPILOT_APPROVALS` | `off`, `observe` (défaut), `enforce` |
| le projet | `approvals.mode` | ne peut que restreindre le réglage de l'app |

Le plus strict gagne (`off` < `observe` < `enforce`). `off` ramène exactement au comportement
d'avant : rien ne fusionne seul. `observe` décide et l'affiche, sans jamais fusionner.
`Decision.merges` n'est vrai qu'en `enforce` avec l'action `merge`.

## Sur les PR de ce dépôt (lot D1)

Le pilote de pile (`scripts/stack_autopilot.py`) lit le niveau de chaque PR verte avant de la
fusionner, avec le runner ci-dessous, depuis le checkout de `develop` (jamais celui de la PR). La
variable de dépôt `APPROVAL_TIERS` joue le rôle du réglage de l'app (`observe` si elle est vide) :

| Mode | Ce que fait le pilote |
|---|---|
| `off` | rien de nouveau : il fusionne tout ce qui est vert, comme avant |
| `observe` | il pose `niveau:N0` à `niveau:N3` et fusionne comme avant ; c'est la semaine d'essai |
| `enforce` | N0 et N1 fusionnent ; N2 et N3 attendent sous `autopilot/à-valider`, avec un commentaire qui donne les raisons, jusqu'au label `approuvé` |

Ici, `off` ne veut pas dire « rien ne fusionne seul » : le pilote de ce dépôt fusionnait déjà tout,
et le couper ramène à ce comportement. Le label `approuvé` ne vaut que posé par une personne qui a le
droit d'écrire (un robot ne valide jamais), et tant qu'aucun commit n'est arrivé depuis, sauf les
fusions de `develop` et les conflits résolus par le pilote lui-même. Un niveau illisible ne bloque
rien en `observe` et bloque en `enforce`. Les PR de ce dépôt n'ont pas de revue croisée : le
`workpilot.policy.yaml` de la racine pose `require_review: false`, sinon chaque N1 attendrait une
personne.

## Sur les cartes du Kanban (lot A2)

Le suivi de la PR d'une tâche ([pr-followup.md](pr-followup.md#le-niveau-de-validation-dune-pr-verte))
demande le niveau quand la PR est verte, le montre sur la carte (`N1 · attend une personne`,
`N0 · fusionnée seule`, raisons dans l'infobulle) et fusionne en `enforce` quand le niveau le
permet. GitHub seulement, comme le suivi lui-même ; une autre forge garde le merge à une personne.

## Le runner

```bash
python apps/backend/runners/approvals_runner.py --project-dir <racine> [--worktree-dir <wt>] \
  --base-branch develop [--head HEAD] --title "fix(api): …" [--kind bug_fix] [--label x]… \
  [--ci green|pending|red|unknown] [--review agree|disagree|inconclusive|none] [--trust 90]
```

`--base-branch origin/develop` compte comme `develop` pour le fait `pr/base`.

Une ligne JSON : `{"decision": {...}}` (niveau, action, mode, `merges`, raisons triées du plus
strict au moins strict avec un code anglais stable, faits, erreurs) ou `{"error": "..."}`. Il ne
fusionne rien : l'appelant fusionne quand `merges` est vrai.

## Tests

`tests/approvals/` : la grammaire (dont tout ce qu'elle refuse), les faits par pile, le diff git
réel, chaque déclencheur de niveau, les règles qui ne font que durcir, la politique invalide, les
deux interrupteurs, les garde-fous qui acceptent la section, le runner lancé comme le main le lance.
