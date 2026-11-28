---
feature: Captures de tâche pour la PR (avant/après, faux)
summary: >-
  Une tâche dont les changements touchent un écran (toutes piles) prépare ses captures : la
  vérification prend l’« après », la base l’« avant », chaque donnée personnelle devient une fausse
  du même format ; les copies vont sur une branche à part (GitHub, GitLab, Bitbucket) ou en pièces
  jointes (Azure DevOps) et la section « Captures » de la PR est remplacée à chaque synchro.
---

# Captures d'une tâche pour sa PR

Demande de Leub (28 novembre 2026) : les tâches du Kanban qui en ont besoin (feature, bugfix…)
prennent des captures toutes seules, et ces captures apparaissent sur la PR correspondante ; « il y
a un onglet ayant un rapport, peut-être faudrait-il que ce soit les mêmes screenshots ? ».
Puis : publier sans relecture préalable, et pas de cache ni de flou sur les données personnelles,
« de fausses données en rapport avec les réelles ».

## Un seul jeu de captures

Trois chemins prenaient des captures, chacun pour soi :

| Chemin | Quand | Où |
|---|---|---|
| la vérification (`verify/`) | pendant le build | `<spec>/verify/screenshots/`, déposées aussi dans le magasin des captures |
| la preuve visuelle (`main/visual-proof-service.ts`) | à la création de la PR, l'app relancée une seconde fois | commitée sur la branche de la tâche |
| la revue visuelle (`docintel/visual_qa.py`) | avant la revue QA | lit le magasin des captures |

Le magasin existait déjà : `<spec>/captures/{base,task}/` et son `manifest.json`
(`docintel.visual_qa.save_capture`). Une capture de la base et une de la tâche du même écran
(même plateforme, même route, même langue, et maintenant même variante) y forment une paire.
Ce lot n'ajoute pas de quatrième chemin : la vérification y dépose ses écrans comme `task`, la
comparaison avec la base y dépose les siens comme `base`, et `pr_captures/` lit ce magasin.

## Quand une tâche a besoin de captures

`pr_captures/decide.py`, sans modèle, sur les fichiers changés de la tâche :

- un fichier de `uiux.surface.UI_GLOBS` (web, Razor/Blazor, XAML, SwiftUI, Flutter, layouts
  Android), ou un écran que la phase UI/UX ne stylise pas : template serveur (`.jinja2`, `.twig`,
  `.erb`, `.blade.php`, `.ejs`, `.hbs`, `.gohtml`…) et fenêtre, page, état ou modèle WinDev
  (`.wdw`, `.wwh`, `.wde`, `.wdt`). Ceux-là restent hors de `UI_GLOBS` exprès, la liste décidant
  aussi quand la phase UI/UX tourne ;
- un test, une story ou une fixture n'est pas un écran (`Button.test.tsx`, `Card.stories.tsx`) ;
- le réglage de l'équipe `CAPTURES_MODE` (`auto`, `always`, `never`), puis celui de la carte
  (`WORKPILOT_CAPTURES` sur l'environnement du build), forcent la réponse.

La raison est un code stable (`ui-files`, `no-ui-files`, `forced`, `turned-off`,
`no-changed-files`) que l'app traduit.

## L'« avant »

`verify/captures_step.after_verify`, appelé par la phase `verify` après la boucle : si la tâche a
besoin de captures, que `CAPTURES_COMPARE` est vrai et que la vérification a conclu (`pass` ou
`fail`), la comparaison avec la branche de base (`verify/compare.py`) tourne. Elle refusait une
vérification sans scénario ni appel d'endpoint ; elle accepte maintenant une vérification qui a
capturé des pages. De chaque côté, `capture_side` rouvre chaque page capturée (même chemin, même
largeur, l'origine du côté lancé) et la dépose dans le magasin : les deux côtés sont pris de la même
façon, donc la paire compare ce que la tâche a changé, pas deux procédures. La vue téléphone d'une
page web est la variante `mobile` du même écran (`save_capture(variant=…)`) : elle ne remplace plus
la capture de bureau.

Une comparaison qui échoue laisse l'« avant » vide, jamais le build en échec.

## Des fausses données à la place des vraies

Une capture d'une app lancée sur une base de développement montre ce que cette base contient. Une
fois dans une PR, elle est dans chaque clone et chaque notification de la forge. Chaque valeur
personnelle est donc remplacée, avant que l'image quitte la machine, par une fausse du même type et
du même format (`pr_captures/fakes.py`) :

| Type | Vrai | Faux |
|---|---|---|
| e-mail | `j.martin@acme.fr` | `camille.robert@exemple.fr` (même domaine de premier niveau) |
| téléphone | `+33 6 12 34 56 78` | `+33 6 47 90 13 52` (indicatif, premier chiffre et espacement gardés) |
| IBAN | `FR76 3000 …` | `FR02 4815 …` (même pays, même groupement, clé valide) |
| carte | `4970 1012 …` | `4111 1111 1111 1111` (numéro de test du même réseau) |
| nom, adresse | `Jeanne Martin` | `Camille Robert` (même nombre de mots), `12 rue des Lilas` |
| secret, autre | `sk-live-9f2…` | `ab-qxyz-4k7…` (lettres pour lettres, chiffres pour chiffres) |

Le choix est un HMAC-SHA256 de la vraie valeur, sous une clé tirée une fois par tâche
(`<spec>/captures/.pseudonym-key`, `0600`) : la même valeur donne le même faux sur toutes les
captures de la tâche, base et tâche comprises, donc une paire avant/après se compare encore ; sans
la clé, personne ne peut dire quelle vraie valeur un faux remplace. Rien n'enregistre une vraie
valeur.

Deux passes, et le résultat dit lesquelles ont tourné (`privacy.py`) :

- **dans la page** (web et Electron, écran encore ouvert) : `protected_screenshot` lit les valeurs
  des champs qu'un navigateur sait personnels (type et `autocomplete` : e-mail, téléphone, nom,
  adresse, carte, date de naissance), des éléments marqués par l'équipe (`[data-private]`,
  `[data-pii]`, `[data-sensitive]`, `CAPTURES_MASK_SELECTORS`) et de tout texte qui ressemble à un
  e-mail, un téléphone, un IBAN ou une carte ; Python choisit les faux, le script les pose, la
  capture est prise, puis la page est remise comme elle était, pour que la suite du scénario tourne
  sur les vraies données. La capture sur le disque n'a jamais contenu les vraies valeurs. Un mot de
  passe est dessiné en points : rien à remplacer. Les sélecteurs de l'équipe arrivent au script comme
  un littéral JSON (des données), et la réponse est du JSON en base64 entre deux sentinelles ;
- **sur l'image, par OCR local** (toutes les plateformes : fenêtre Windows, écran de téléphone,
  WinDev, et le web encore pour un texte dessiné sur un canvas) : chaque mot qui fait partie d'une
  donnée personnelle ou d'un secret (`docintel.redact`, la table du pre-commit) est repeint avec la
  couleur de son fond et le faux est écrit à sa place, à la taille de la ligne. Seuls les moteurs
  locaux sont interrogés : une capture n'est pas envoyée à un OCR dans le cloud pour savoir si elle
  peut être envoyée ailleurs. Les faux déjà posés dans la page sont laissés tels quels.

Ce qui reste hors d'atteinte : un nom écrit en texte libre, qu'aucun motif ne reconnaît. Une équipe
marque ces endroits avec `data-private` ou ses propres sélecteurs.

| Statut d'une copie | Sens | Publiée ? |
|---|---|---|
| `pseudonymized` | des faux à la place de vraies données | oui |
| `clean` | vérifiée, rien de personnel | oui |
| `unchecked` | aucune passe n'a pu tourner (pas de page, pas d'OCR installé) | non, sauf `CAPTURES_PUBLISH_UNCHECKED=true` |
| `withheld` | une valeur sans place sur l'image, plus de 200 valeurs, ou une vérification cassée (échec fermé) | non |
| `failed` | image illisible ou copie impossible à écrire | non |

La copie publiable est toujours ré-encodée depuis les pixels : aucune métadonnée de l'original
(chunks texte PNG, EXIF) n'y passe. L'original reste dans `<spec>/captures/`, sur la machine qui
l'a pris. `CAPTURES_MASK=false` (choix de l'équipe) publie l'image ré-encodée sans passe.

## La publication

`pr_captures/publication.py` écrit `<spec>/captures/publication.json` : la décision, les réglages
de publication, et au plus 12 écrans (web de bureau d'abord, sa vue téléphone ensuite, puis les
autres plateformes), chacun avec son `before` et son `after` : fichier publiable sous
`captures/published/<side>/`, signature de l'original (une capture inchangée n'est pas revérifiée),
statut, passes, types trouvés (jamais une valeur). La PR (lot 2) et l'app (lot 3) ne lisent que ce
fichier et les copies qu'il nomme, jamais un original.

Leub a choisi (28/11/2026) que les copies vérifiées partent dans la PR sans relecture :
`CAPTURES_PUBLISH=auto` par défaut ; `review` les fait attendre un « Publier » ; `never` les garde
sur la tâche.

## Dans la PR

`core/capture_hosting/` (`sync_pr_captures`) met les copies publiables là où la PR peut les
montrer et écrit sa section « Captures » (`pr_captures/section.py`) : un tableau Écran / Avant /
Après, une ligne qui dit que les données personnelles sont des faux, une autre qui compte les
captures restées sur la tâche. Il tourne dès que `push_and_create_pr` a la PR, puis à la demande
(`runners/pr_captures_runner.py sync`, `approve`, `withdraw`) quand les captures changent ou
qu'une personne publie ou retire.

| Forge | Images | Corps |
|---|---|---|
| GitHub | branche des captures, `…/blob/<branche>/<chemin>?raw=1` | `gh api` (PATCH) |
| GitLab | branche des captures, `…/-/raw/<branche>/<chemin>` | `glab api` (PUT) |
| Bitbucket Cloud | branche des captures, `…/raw/<branche>/<chemin>` | API REST, titre gardé |
| Azure DevOps | pièces jointes de la PR (`wp-capture-…`) | API REST, 4 000 caractères au plus |

GitHub n'a pas d'API pour joindre une image au corps d'une PR, et celles de GitLab et Bitbucket
demanderaient un identifiant de plus. Le dépôt qui vient d'accepter le push de la tâche accepte
aussi celui des images : elles vont sur une branche à elles (`CAPTURES_BRANCH`,
`workpilot-captures`), sans historique commun avec le code, donc jamais fusionnable par erreur, et
la branche de la tâche ne porte aucune image (`core/capture_hosting/branch.py`) :

- chaque publication écrit un seul commit sans parent, construit par la plomberie git dans un index
  temporaire : ni la copie de travail, ni l'index, ni les worktrees de la personne ne bougent ;
- le push est gardé par `--force-with-lease` sur le commit remplacé, et rejoué si une autre tâche
  a publié entre-temps ;
- chaque tâche a son dossier `<spec>-pr<numéro>` et sa date dans `index.json` ; une tâche plus
  vieille que `CAPTURES_RETENTION_DAYS` (depuis sa dernière mise à jour, `0` : jamais) est retirée
  au passage suivant, et l'image retirée n'est plus atteignable depuis la branche ;
- le chemin d'une image finit par une empreinte de ses octets : une capture reprise a une autre
  adresse, aucune forge ne montre l'ancienne depuis son cache.

Une image n'est lisible que par qui voit le dépôt (le navigateur envoie sa session à la forge) :
une PR d'un dépôt privé ne rend pas ses captures publiques.

Sur Azure DevOps, les images sont des pièces jointes de la PR ; une synchronisation retire les
nôtres qui ne sont plus montrées, jamais celles d'une personne. La description est bornée à
4 000 caractères : les écrans en trop sont retirés par la fin et comptés.

La section est remplacée entre deux marqueurs, jamais ajoutée deux fois, et retirée avec ses images
quand plus rien n'est à montrer (`CAPTURES_PUBLISH=never`, attente d'un « Publier », tâche sans
écran). Un libellé écrit par la vérification arrive comme texte, débarrassé de ce que Markdown ou
HTML liraient. Seul un fichier PNG de `captures/published/` est envoyé. Le runner ne prend pas
d'URL de PR : il cherche celle de la branche de la tâche, donc aucune autre PR ne peut être
modifiée. Une tâche sans capture ne fait aucun appel à la forge. Un refus (pas d'identifiant,
branche protégée, PR illisible) est un code dans `<spec>/captures/pr-sync.json`, jamais une PR en
échec.

En mode `review`, `pr_captures/approval.py` enregistre les signatures des images qu'une personne a
publiées : une capture reprise ensuite attend un nouveau « Publier ».

## Dans l'app

L'onglet « Captures » de la tâche (`task-detail/TaskCaptures.tsx`) remplace « Preuves
visuelles ». Il lit `publication.json`, `pr-sync.json` et `approval.json` par le main
(`main/task-captures/read-captures.ts`), qui ne garde que des champs vérifiés et bornés (statuts et
codes en liste fermée, textes sur une ligne, URL de PR en `https`) : jamais une valeur, il n'y en a
pas dans ces fichiers. Pour chaque écran : l'« avant » et l'« après » tels que la PR les montre, les
types remplacés par des faux, le statut d'une copie gardée sur la tâche. Une tâche sans captures
montre sa preuve visuelle, et un bouton y mène depuis les captures.

L'app ne montre que les copies publiables : une image n'est lue (`TASK_CAPTURES_IMAGE`) que si la
publication la nomme, en PNG, résolue (liens compris) dans `captures/published/`. Un original ne
quitte jamais le dossier de la spec, même vers l'écran.

| Bouton | Quand | Effet |
|---|---|---|
| Publier dans la PR | `CAPTURES_PUBLISH=review`, des copies publiables pas encore publiées | `pr_captures_runner.py approve`, puis la section |
| Retirer de la PR | `review`, copies publiées | `withdraw` : l'approbation oubliée, la section et ses images retirées |
| Mettre à jour la PR | sauf `never` | `sync` : la section refaite depuis les captures du moment |

Le renderer ne nomme qu'une tâche et une action d'une liste fermée (`TASK_CAPTURES_ACTION`) ; le
main construit tout le reste (`ipc-handlers/task/task-captures-runner.ts`) : dossier du projet
enregistré, nom de spec et branche de base de la tâche, revérifiés comme le runner les vérifie. Le
runner trouve lui-même la PR de la branche. Une carte du serveur n'a pas de bouton : le serveur
publie ses captures (lot 4).

Sur la carte du Kanban, `Task.captures` (résumé joint par `project-store.ts`, lu une fois par
changement de fichier) donne la pastille appareil photo (`task-captures/TaskCapturesBadge.tsx`) :
le nombre d'écrans et leur état (dans la PR, en attente de « Publier », prêtes, gardées sur la
tâche, retenues). L'aperçu au survol montre le premier écran. Une carte d'un projet du serveur
reçoit les deux fichiers JSON dans l'instantané du tableau (`remote-board.ts`), sans image.

Le choix de la carte (« suivre le projet », « toujours », « jamais ») se règle dans l'onglet et
part au build en `WORKPILOT_CAPTURES` (`agent/env-utils.ts`, `applyCapturesChoice`). Les clés
`CAPTURES_*` se règlent dans Paramètres › Projet › Captures des PR
(`settings/CapturesSettings.tsx`) ; le main remet chaque valeur dans la forme que le backend
accepte avant de l'écrire (`main/task-captures/captures-env.ts`) : aucun saut de ligne, aucune
branche refusée.

La preuve visuelle laisse la place : quand la tâche a des captures, la création de la PR ne la
relance pas, et un lancement à la main reste sur la tâche (`keepOnTask` : pas de commit sur la
branche de la tâche, pas de commentaire de PR).

## Réglages

| Clé (`.workpilot/.env` ou environnement) | Défaut | Effet |
|---|---|---|
| `CAPTURES_MODE` | `auto` | `auto` (écran touché), `always`, `never` |
| `WORKPILOT_CAPTURES` | — | choix de la carte, posé par le Kanban sur le build |
| `CAPTURES_COMPARE` | `true` | prendre l'« avant » sur la branche de base |
| `CAPTURES_MASK` | `true` | remplacer les données personnelles par des faux |
| `CAPTURES_MASK_SELECTORS` | — | sélecteurs CSS en plus (30 au plus, 200 caractères chacun) |
| `CAPTURES_PUBLISH` | `auto` | `auto`, `review`, `never` |
| `CAPTURES_PUBLISH_UNCHECKED` | `false` | publier une capture qu'aucune passe n'a pu vérifier |
| `CAPTURES_RETENTION_DAYS` | `30` | jours de conservation des images d'une tâche sur la branche des captures après leur dernière mise à jour (`0` : sans limite) |
| `CAPTURES_BRANCH` | `workpilot-captures` | branche des images sur GitHub, GitLab et Bitbucket |

## En mode serveur et sur le téléphone

Sur un projet du serveur d'équipe, la tâche tourne sur le clone du serveur : la vérification, la
comparaison et `build_publication` y écrivent comme sur un poste. Le serveur montre ces captures
à l'app mobile et à l'app de bureau connectée (`shared_board/captures.py`), par `project_id` et
carte, jamais par chemin :

| Route | Permission | Rôle |
|---|---|---|
| `GET /api/board/cards/{id}/captures` | `task.read` | `publication.json` et `pr-sync.json` résumés : par écran le statut, le nombre de valeurs remplacées et leurs types, l'état de la PR ; ni chemin, ni empreinte, ni valeur, et un lien de PR seulement en `https://` |
| `GET /api/board/cards/{id}/captures/{n}/{before\|after}` | `task.read` | une copie publiable en PNG base64 : l'écran est sa place dans la liste, le fichier celui que la liste nomme, résolu sous `captures/published/`, signature PNG vérifiée ; une copie retenue ou une capture d'origine répond 404 |
| `POST …/captures/publish`, `…/withdraw` | `review.approve` (`ROUTE_OVERRIDES`) et rôle de membre | la réponse à la revue (`CAPTURES_PUBLISH=review` seulement, sinon 409), par `pr_captures.approval`, inscrite à l'audit (`task.captures.published`, `task.captures.withdrawn`) |
| run `captures` | `agent.execute` et `vcs.pr.create` (`PHASE_PERMISSIONS`) | `runners/pr_captures_runner.py sync` sur le clone, avec le jeton de forge de qui le lance ; aucun agent, aucun modèle |

La copie lue est celle du worktree de la tâche ou du dossier de la carte, la plus récente, comme le
runner la choisit. L'instantané du tableau envoie aussi `captures/publication.json` et
`captures/pr-sync.json` (un dossier lié hors de la carte est ignoré) : la pastille de l'app de
bureau s'allume pour une carte du serveur ; les images, elles, ne passent que par la route.

Sur le téléphone, la carte a une section « Captures pour la PR » (nombre d'écrans, état de la PR,
la ligne des faux) qui ouvre `cards/[cardId]/captures` : chaque écran avant et après, ses types
remplacés, ce qui reste sur la tâche, le lien de la PR, et en mode `review` **Publier** ou
**Retirer** puis le run `captures` quand la personne en a les droits (sinon la PR suit à sa
prochaine synchronisation). Le téléphone ne garde aucune image. Ce qui est traité et combien de
temps, pour le registre RGPD : [pr-captures-data.md](../pr-captures-data.md).

## Lots

1. **Décider et capturer** (ce document) : `pr_captures/` (feuille sur `docintel` et `uiux`,
   `tests/test_import_contracts.py`), `verify/captures_step.py`, la variante dans
   `docintel.visual_qa`, la comparaison sur les pages capturées.
2. **Publier dans la PR** (ce document) : `pr_captures/section.py` et `approval.py`,
   `core/capture_hosting/`, l'appel dans `push_and_create_pr`, `runners/pr_captures_runner.py`.
3. **Montrer** (« Dans l'app ») : onglet Captures qui lit `publication.json` et `pr-sync.json` (la preuve visuelle
   en repli), boutons « Publier » et « Retirer » sur le runner, pastille et aperçu sur la carte,
   réglages, FR et EN ; la preuve visuelle cesse de commiter sur la branche de la tâche et de
   poster son commentaire quand la tâche a des captures.
4. **Serveur, mobile, docs** (ce document) : `shared_board/captures.py`, la phase `captures` de
   `server/services/run_manager.py`, l'écran `apps/mobile/src/app/(app)/projects/[projectId]/cards/[cardId]/captures.tsx`
   et `apps/mobile/src/captures/`, le registre [pr-captures-data.md](../pr-captures-data.md), les README.

Tests : `tests/backend/test_shared_board_captures.py` (routes du serveur, refus compris),
`apps/mobile/src/__tests__/app/card-captures.test.tsx`, `tests/pr_captures/` (dont les scripts de page joués dans un vrai Chromium et la branche
des captures poussée vers un vrai dépôt nu), `tests/test_verify_compare.py`.
