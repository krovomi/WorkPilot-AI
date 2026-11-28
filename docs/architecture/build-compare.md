---
feature: Comparaisons de builds (Build Analytics)
summary: >-
  « Où vous en êtes » compare un projet à son passé et à d'autres projets (pile, taille, équipe,
  type de travail) sur des chiffres par spec lus dans leurs dossiers, sans service central ni
  télémétrie : ceux de la personne sur le bureau, ceux de l'organisation qu'elle peut lire sur un
  serveur, en médianes, à partir de 5 projets ; rythme face aux pairs, rapport PDF.
---

# Comparaisons de builds (`shared_features/build_compare.py`)

Issue #359, lots 1, 3 et 4. Build Analytics montrait les chiffres d'un projet sans dire s'ils étaient bons.
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
  `read_json`, 500 plans et 32 Mo au plus par projet ;
- `mutation_gate.json` et `pr_followup.json` du même dossier de spec (racine et espace de build),
  par le même lecteur : 2 Mo par fichier et 16 Mo par projet pour le premier, qui liste chaque
  mutant ; 200 Ko et 8 Mo pour le second.

## Des chiffres qui valent sur toutes les piles et tous les providers

Par spec (un `spec_id` qui a au moins une session d'agent dans le registre) :

| Chiffre | Source |
|---|---|
| minutes | de la première à la dernière session d'agent de la spec |
| coût (USD) | somme des sessions, telles que le catalogue de prix les a valorisées |
| itérations de QA | `qa_signoff.qa_session` du plan (le plus grand entre la racine et l'espace de build) |
| agents | types d'agent distincts (`agent_type`) qui ont travaillé dessus |
| score de mutation (%) | `score` de la dernière porte de mutation de la QA (`mutation_gate.json`), quand elle a lancé des mutants |
| CI verte du premier coup (%) | `first_ci` du suivi de la PR (`pr_followup.json`) : la CI est-elle passée sur la PR telle qu'elle a été ouverte |

Aucun ne dépend du langage ni du provider : une spec Ollama et une spec Claude se comparent. Le
chiffre d'un projet pour une fenêtre est la **médiane** de ses specs commencées dedans ; pour la
CI, c'est la part, en pourcentage, de ses specs au résultat noté qui sont passées. Plus bas est
mieux, sauf pour ces deux derniers (`HIGHER_IS_BETTER`, `build_compare_quality.py`) : leur
tendance est verte quand elle monte, et le dixième le meilleur d'un groupe est leur dernier
décile.

Le suivi de la PR (`pr_followup/loop.py`) écrit `first_ci` une fois, au premier regard où chaque
check de la tête est fini et avant tout tour de correction de sa part (`policy.first_ci_verdict`) :
`failed` si un check propre à la PR a échoué, `passed` sinon ; rien quand les seuls échecs sont
rouges sur la branche de base aussi, rien non plus pour une PR fusionnée ou fermée avant. Le suivi
ne lit que GitHub pour l'instant : une spec dont la PR n'a pas été suivie n'a pas ce chiffre. Le
test joue le suivi contre une forge factice (`tests/pr_followup/test_first_ci.py`). Les 8
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

Chaque groupe donne aussi sa **tendance** (`trend`), d'une fenêtre à l'autre, à partir de
`min_group` projets du groupe dans chacune, et son **dixième le meilleur** (`top`, 1er décile, plus bas est mieux), à
partir de `min_top` projets qui ont le chiffre : 10 sur le bureau, 20 sur un serveur (`MIN_TOP`),
pour que ce dixième tienne au moins deux projets et ne soit jamais le chiffre du meilleur seul.

« Votre rythme face à vos pairs » (`analytics/compare-pace.ts`) lit la tendance du projet contre
celle du groupe le plus étroit qui en a une pour ce chiffre (même segment, même pile, même
équipe, tous) : plus vite, moins vite, ou au même rythme à moins de 5 points près.

### Changement de segment

Un projet qui passe de petit à moyen dépôt, ou de 2-5 à 6-20 personnes, ne saute pas d'un groupe à
l'autre : pendant une fenêtre (30 jours) après le changement, il est comparé aux projets de
**l'ancien et du nouveau** segment (`segments.moved`), et la réponse le dit (`segment.size_from`,
`team_from`). Ce qu'il était il y a une fenêtre est relu dans git, sans aucun relevé : les fichiers
du dernier commit d'avant (`git rev-list --before`, puis `git ls-tree`), les auteurs des 90 jours
d'avant (`git log --since --until`). Venir de `unknown` (dépôt trop jeune) n'est pas un
changement. La pile n'est pas lissée : la relire à une date demanderait d'extraire l'arbre.

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
  une médiane de groupe n'est donnée qu'à partir de **5 projets** (`MIN_GROUP`), et chaque
  indicateur seulement si autant de projets l'ont ; en dessous seul le nombre l'est, pour
  qu'aucune médiane ne désigne un projet ;
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

## Hors de portée (#359)

- **Partage entre organisations, sur adhésion** : comparer à d'autres organisations demanderait
  qu'elles publient volontairement leurs agrégats vers un service commun, hébergé par quelqu'un ;
  écarté par décision produit (comparaison au sein d'une organisation, aucune télémétrie). Seul
  un changement de cette décision le rouvrirait, avec l'hébergement du service.
- **Mesures d'usage de l'issue** (taux d'adhésion, consultations, PDF générés) : ce serait de la
  télémétrie, écartée par la même décision.
