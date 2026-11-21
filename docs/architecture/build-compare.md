---
feature: Comparaisons de builds (Build Analytics)
summary: >-
  « Où vous en êtes » compare un projet à son passé et à d'autres projets (par pile, taille, équipe,
  type de travail) sur des chiffres par spec lus dans leurs dossiers, sans service central : les
  projets de la personne sur le bureau, ceux de l'organisation qu'elle peut lire sur un serveur, en
  médianes seulement, à partir de 5 projets ; rapport d'équipe en PDF.
---

# Comparaisons de builds (`shared_features/build_compare.py`)

Issue #359, lots 1 et 3. Build Analytics montrait les chiffres d'un projet sans dire s'ils étaient bons.
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
chiffre d'un projet pour une fenêtre est la **médiane** de ses specs commencées dedans. Les 8
dernières semaines du projet (`weeks`), une médiane chacune, dessinent la courbe de chaque chiffre.

Les projets sont rangés par **segment** : la pile principale (`project/stack.py`, la seule porte
pour la question) et une taille en fichiers suivis par git (`git ls-files`, < 500 petit, < 5 000
moyen, < 50 000 grand, au-delà monorepo, `unknown` sans git). Trois groupes : même segment, même
pile, tous. Seuls les projets qui ont une spec dans les 30 derniers jours comptent.

`build_compare_segments.py` ajoute deux axes, lus eux aussi dans le dossier :

- l'**équipe** : les auteurs de commit distincts des 90 derniers jours (`git log --format=%aE`,
  20 000 commits au plus), comptés et jamais gardés : solo, 2-5, 6-20, plus de 20, `unknown` sans
  git ou sans commit récent. Un quatrième groupe réunit les projets de même équipe ;
- le **type de travail** d'une spec : celui que sa carte a écrit dans `task_metadata.json`
  (`tasks.metadata.record_kind`), pris dans la liste fermée `TaskKind`, sinon aucun (200 Ko par
  fichier, 8 Mo par projet). Le tableau « Par type de travail » met les specs de chaque type du
  projet face à la médiane des autres projets pour le même type, sous le même seuil de groupe.

Chaque groupe donne aussi son **dixième le meilleur** (`top`, 1er décile, plus bas est mieux), à
partir de `min_top` projets qui ont le chiffre : 10 sur le bureau, 20 sur un serveur (`MIN_TOP`),
pour que ce dixième tienne au moins deux projets et ne soit jamais le chiffre du meilleur seul.

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
  serveur envoie ; un type de travail n'est gardé que s'il est un identifiant court (il nomme une
  clé de traduction), semaines et types sont bornés.

## Rapport d'équipe (PDF)

« Générer le rapport d'équipe » : le renderer met la comparaison en mots dans la langue de l'app
(`analytics/compare-report.ts`), ce que la vue montre et rien de plus (sur un serveur, ni nom ni
id). Le main (`main/build-compare-report.ts`, canal `dashboard:compareExport`) relit ce document
comme des chaînes bornées, demande où l'enregistrer dans une boîte native et l'imprime par le même
écrivain que le rapport de conformité (`compliance/report-export.ts`) : tout échappé, page sans
script ni ressource distante, fenêtre cachée sans JavaScript.

## Reste à faire (#359)

- **Partage entre organisations, sur adhésion** : comparer à d'autres organisations demanderait
  qu'elles publient volontairement leurs agrégats vers un service commun, hébergé par quelqu'un ;
  écarté par conception (aucune télémétrie centrale), rien n'est construit.
- **Taux de CI vert du premier coup** : le résultat des CI n'est pas enregistré localement
  (`cicd_runs.json` ne dit que lancé ou échoué) ; il faut d'abord l'enregistrer par spec, ce qui
  demande une forge et une CI réelles pour être vérifié.
- **Score de mutation** après génération de tests : aucune feature ne l'enregistre encore.
- **Lissage d'un changement de segment** (petit → moyen dépôt) : chaque comparaison prend le
  segment du jour ; garder l'historique des segments demanderait un relevé de plus.
