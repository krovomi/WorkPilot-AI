---
feature: Comparaisons de builds (Build Analytics)
summary: >-
  « Où vous en êtes » compare un projet à son passé et à d'autres projets sur des chiffres par spec
  (minutes, USD, itérations de QA, agents) lus dans leurs dossiers, sans service central : les
  projets de la personne sur le bureau, ceux de l'organisation qu'elle peut lire sur un serveur, en
  médianes seulement et pour des groupes d'au moins 5 projets.
---

# Comparaisons de builds (`shared_features/build_compare.py`)

Issue #359, lot 1. Build Analytics montrait les chiffres d'un projet sans dire s'ils étaient bons.
L'onglet « Où vous en êtes » (*How you compare*) répond, en comparant le projet à lui-même (les 30
derniers jours contre les 30 d'avant) et à d'autres projets de même pile et de même taille.

## Aucun service central, rien ne sort

Un benchmark WorkPilot centralisé a été **écarté exprès** : il aurait fallu envoyer des chiffres
de build à un service tiers, ce que ni l'app de bureau ni un serveur auto-hébergé ne font. Tout est
lu là où les agents l'écrivent déjà :

- `.workpilot/cost_data.json` (racine et chaque espace de build `worktrees/tasks/<carte>/`),
  par `shared_features/usage_ledger.py`, le lecteur déjà durci des vues serveur (ouverture sans
  suivre les liens, tailles plafonnées, budget de lecture total) ;
- `.workpilot/specs/<carte>/implementation_plan.json`, pour `qa_signoff.qa_session`, lu par le même
  `read_json`, 500 plans et 32 Mo au plus par projet.

## Des chiffres qui valent sur toutes les piles et tous les providers

Par spec (un `spec_id` qui a au moins une session d'agent dans le registre) :

| Chiffre | Source |
|---|---|
| minutes | de la première à la dernière session d'agent de la spec |
| coût (USD) | somme des sessions, telles que le catalogue de prix les a valorisées |
| itérations de QA | `qa_signoff.qa_session` du plan (le plus grand entre la racine et l'espace de build) |
| agents | types d'agent distincts (`agent_type`) qui ont travaillé dessus |

Aucun ne dépend du langage ni du provider : une spec Ollama et une spec Claude se comparent. Le
chiffre d'un projet pour une fenêtre est la **médiane** de ses specs commencées dedans.

Les projets sont rangés par **segment** : la pile principale (`project/stack.py`, la seule porte
pour la question) et une taille en fichiers suivis par git (`git ls-files`, < 500 petit, < 5 000
moyen, < 50 000 grand, au-delà monorepo, `unknown` sans git). Trois groupes : même segment, même
pile, tous. Seuls les projets qui ont une spec dans les 30 derniers jours comptent.

## Bureau : les projets de la personne

`main/build-compare.ts` lance `runners/build_compare_runner.py` avec, sur stdin, le dossier du
projet (enregistré, vérifié par `DIRECTORY_ARGS` puis contre le magasin de projets) et ceux des
autres projets enregistrés (50 au plus), pris dans le magasin, jamais dans le renderer. Le runner
revérifie chaque dossier, écarte ceux qui ont disparu, et ajoute la liste des projets avec leur
nom : ce sont les projets de la personne. Une médiane de groupe s'y donne dès 2 projets.

## Serveur : l'organisation, en agrégats

`GET /api/features/workspace/compare?project_id=…` (`analytics.read`, comme les autres vues
d'espace de travail) :

- le projet passe par `resolve_project_scope` (404 pour un autre tenant) ;
- les pairs sont les projets de **la même organisation** (100 au plus) pour lesquels
  `load_project_scope` réussit pour la personne : rien qu'elle ne pourrait déjà lire ;
- la réponse ne contient que des médianes et des nombres de projets, **jamais un nom ni un id** ;
  une médiane de groupe n'est donnée qu'à partir de **5 projets** (`MIN_GROUP`), en dessous seul le
  nombre l'est, pour qu'aucune médiane ne désigne un projet ;
- le main revérifie la réponse (`build-compare-shape.ts`) et vide la liste de projets quoi que le
  serveur envoie.

## Pas encore fait (lots suivants de #359)

- **Export PDF** de la comparaison.
- **Partage entre organisations, sur adhésion** : comparer à d'autres organisations demanderait
  qu'elles publient volontairement leurs agrégats ; rien n'est construit, et un service central
  n'est pas prévu.
- **Taux de CI vert du premier coup** : le résultat des CI n'est pas enregistré localement
  (`cicd_runs.json` ne dit que lancé ou échoué) ; il faut d'abord l'enregistrer par spec.
