---
feature: Auto-guérison — la correction en carte du tableau
summary: >-
  Un incident ne se corrige pas dans un chemin à part : il devient une carte du backlog, dont le
  build planifie, code et passe la QA dans un worktree, puis attend la revue d'une personne avant
  sa PR. L'incident suit la colonne de sa carte ; aucune étape n'est dite faite sans l'avoir été.
---

# Auto-guérison : la correction en carte du tableau

Avant, le pipeline de l'Incident Responder nommait trois étapes qu'il ne faisait pas
(« correctif dans un worktree », « QA », « PR ») et renvoyait l'incident à une personne (F48).
Le produit sait déjà faire tout cela pour une carte du Kanban : spec, plan, code, QA, revue
humaine, PR, dans un worktree à elle, avec les droits, le provider et les garde-fous de chaque
build. Un second chemin aurait refait ce travail avec moins de contrôles. La correction d'un
incident est donc **une carte**, comme celles que créent les automatisations.

## Ce que fait le pipeline (`incident_responder/orchestrator.py`)

1. **Analyse** : le prompt du mode (CI/CD, production, proactif), où le diff, les messages de
   commit, les journaux, la pile d'appels et les noms de fichiers sont déjà nettoyés et cités
   comme données (règle S2).
2. **Vérification** : l'app est lancée telle qu'elle est (`verify.loop`, sans pilote). Si elle ne
   démarre pas, la carte le dit en tête de travail ; cela n'empêche pas la carte.
3. **Carte** (`incident_responder/fix_card.py`) : `board_mcp.server.write_card` l'écrit dans le
   backlog sous le verrou de numérotation du tableau (le même que l'app). Titre `Fix: <incident>`,
   description = consigne du mode + analyse, bornée à `MAX_DESCRIPTION` (coupée en le disant).
   Métadonnées : `sourceType: "self-healing"`, `selfHealing: {incidentId, mode}`, type choisi
   pour le mode (`bug_fix` en CI/CD et production, `test` en proactif) avec `kindSource: "user"`
   pour que le classifieur le garde.

L'opération se termine quand la carte est écrite. Une carte n'est pas un correctif : le taux de
correction automatique compte les incidents dont la carte a atteint sa PR (ou `done`), le temps
moyen va du signalement à la résolution de l'incident.

## L'incident suit sa carte

`refresh_from_board()` (appelé par le tableau de bord) relit chaque carte par son id, confiné au
dossier des specs (`board_mcp.server.card_dir`), et en déduit l'état de l'incident :

| Colonne de la carte | Incident |
|---|---|
| backlog, queue, in_progress | `fixing` |
| ai_review, human_review | `qa_running` |
| pr_created, ou un `prUrl` https | `pr_created` (le lien est gardé) |
| done | `resolved` |
| build_failed, error | `failed` (« relancer la carte ») |
| carte supprimée | `escalated` (une personne reprend) |

Un incident qu'une personne a classé, ou dont la carte est terminée, n'est plus relu. Tant que la
carte est sur le tableau, « Corriger » ou « Réessayer » n'en crée pas une seconde : l'étape dit de
la relancer sur le tableau. Une carte supprimée permet d'en déposer une nouvelle.

## Réglages

- CI/CD : `autoFixEnabled` (activé par défaut) dépose la carte dès l'échec.
- Production : `autoFix` (désactivé par défaut), lu à part ; avant, le runner lui appliquait le
  réglage CI/CD.
- « Créer automatiquement les PR » est retiré : la PR d'une carte suit la revue humaine, comme
  pour toute carte.

## Ce qui reste

- Regrouper deux échecs de CI des mêmes tests sur la même branche en un seul incident.
- Le mode proactif ne dépose pas de carte de lui-même après un scan (`autoGenerateTests`).
