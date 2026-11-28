---
feature: Captures de tâche pour la PR (avant/après, faux)
summary: >-
  Une tâche dont les fichiers changés touchent un écran (toutes piles, WinDev et templates serveur
  compris) prépare ses captures pour la PR : la vérification les prend, la comparaison avec la base
  donne l’« avant », chaque donnée personnelle est remplacée par une fausse du même type et du même
  format (dans la page, sinon par OCR local) ; `pr_captures/` écrit
  `captures/publication.json`.
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
| `CAPTURES_RETENTION_DAYS` | `30` | jours de conservation des images publiées après la fusion (lot 2) |

## Lots

1. **Décider et capturer** (ce document) : `pr_captures/` (feuille sur `docintel` et `uiux`,
   `tests/test_import_contracts.py`), `verify/captures_step.py`, la variante dans
   `docintel.visual_qa`, la comparaison sur les pages capturées.
2. **Publier dans la PR** : section « Captures » dans le corps de la PR GitHub, GitLab, Azure DevOps
   et Bitbucket, hébergement des images par forge, mise à jour de la section, purge après fusion ;
   la preuve visuelle cesse de commiter sur la branche de la tâche.
3. **Montrer** : onglet Captures qui lit `publication.json` (la preuve visuelle en repli), pastille
   et aperçu sur la carte, réglages, FR et EN.
4. **Serveur, mobile, docs**.

Tests : `tests/pr_captures/` (dont les scripts de page joués dans un vrai Chromium),
`tests/test_verify_compare.py`.
