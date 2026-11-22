---
feature: "Rejeu d'agent : partage, lien d'équipe, signets, vidéo"
summary: >-
  Une session s'exporte masquée en `.wpreplay`, en page HTML sans script ou en vidéo WebM ou
  MP4 ; en mode serveur, un lien d'équipe révocable, dont le serveur ne garde que l'empreinte du
  jeton, et que son auteur révoque aussi depuis les Réglages ; l'import reconstruit tout, borné ;
  signets, réponses et résumé vivent dans la session ; l'usage se compte sur place, sans télémétrie.
---

# Partager un rejeu d'agent

> Issue : #347. Règles : [`security.md`](../rules/security.md) (S1, S2, S5, S6),
> [`frontend.md`](../rules/frontend.md) (IPC, i18n). Voisin : [variantes et rejeux](variants-and-replays.md).

Le rejeu (`apps/backend/replay/`) enregistre chaque session d'agent dans
`~/.workpilot/replays/<id>.json` : étapes, appels d'outils, diffs, raisonnement, tokens. Il ne
quittait pas la machine : montrer à un collègue comment l'agent a résolu un problème demandait
un partage d'écran. Une session se partage maintenant par fichier, par page, par vidéo ou
par un lien d'équipe, se marque et se discute, et se résume quand son modèle n'a pas laissé de
raisonnement.

```
apps/backend/replay/
  bundle.py      le format .wpreplay : export masqué, import reconstruit et borné
  viewer.py      la page HTML autonome, rendue depuis un bundle déjà masqué
  bookmarks.py   signets d'une session enregistrée et leurs réponses
  compare_page.py  deux sessions côte à côte, la page que joue la vidéo A/B
  video.py       la page jouée étape par étape dans Chromium, enregistrée en WebM
  mp4.py         le WebM encodé de nouveau en MP4 par le ffmpeg du système
  summary.py     le résumé des étapes par un modèle, pour une session sans raisonnement
  usage.py       l'usage compté sur la machine : relevé des exports, sessions annotées
  api.py         POST /replay/sessions/{id}/export, POST /replay/import,
                 POST et DELETE /replay/sessions/{id}/bookmarks[/{bid}/replies],
                 POST /replay/sessions/{id}/video, POST /replay/compare/video,
                 POST /replay/sessions/{id}/summary,
                 GET /replay/usage, POST /replay/usage/exports
apps/backend/shared_features/replay_shares.py   les liens d'équipe (mode serveur)
apps/backend/shared_features/replay_share_overview.py   les liens d'une personne, l'usage d'un projet
apps/backend/server/db/alembic/versions/0017_replay_shares.py, 0020_replay_share_bookmarks.py
apps/backend/foundation/platform/browser.py   chrome_executable, partagé avec verify
apps/frontend/src/main/ipc-handlers/replay-share-handlers.ts   boîtes natives, fichiers, signets
apps/frontend/src/main/ipc-handlers/replay-video-handlers.ts   vidéos et résumé
apps/frontend/src/main/replay-team-share.ts                    lien d'équipe, côté app
apps/frontend/src/main/ipc-handlers/replay-team-share-handlers.ts
apps/frontend/src/main/replay-usage.ts, ipc-handlers/replay-usage-handlers.ts   les chiffres d'usage
apps/frontend/src/renderer/stores/replay-share-store.ts, replay-team-share-store.ts,
  replay-usage-store.ts
apps/frontend/src/renderer/components/agent-replay/ReplaySharing.tsx, ReplayTeamShare.tsx,
  ReplayBookmarkReplies.tsx, ReplayComparisonVideo.tsx, ReplayStepsSummary.tsx,
  ReplayUsageMetrics.tsx
apps/frontend/src/renderer/components/settings/ServerReplayLinksSettings.tsx
```

## Le bundle `.wpreplay`

Un JSON compressé en gzip :

```json
{
  "format": "wpreplay",
  "version": 1,
  "exported_at": 1763200000.0,
  "redacted": true,
  "options": { "strip_reasoning": false, "strip_tokens": false, "include_file_contents": false },
  "thinking": "included | removed | none",
  "session": { "...": "la session, telle que ReplaySession.to_dict, sans ses champs calculés" }
}
```

La session garde le schéma de `ReplaySession` plutôt que les listes séparées (`events`, `diffs`,
`thinking`) proposées par l'issue : c'est déjà un schéma commun à tous les providers (rien n'y
est propre à Claude), l'app le relit sans conversion, et la comparaison A/B s'applique telle
quelle à une session importée. `thinking` dit au lecteur si la trace manque parce que le
modèle n'en donne pas (`none`) ou parce qu'on l'a retirée (`removed`).

### Ce qui part, ce qui ne part pas

- **Toujours** : chaque texte de la session, clés d'un `tool_input` comprises, passe par les
  motifs du filtre de logs et par les valeurs des variables d'environnement au nom de secret
  (`foundation.log_redaction.text_redactor`, motifs lus une fois par export). Le dossier du
  projet devient `<project>` et le home `~`, avec `/` comme avec `\`. Il n'y a pas d'option pour
  ne pas masquer.
- **Sur demande** : retirer le raisonnement (les étapes `agent_thinking` et le champ
  `reasoning` de chaque étape), retirer tokens et coûts (ils peuvent trahir le modèle), inclure
  le contenu entier des fichiers avant et après. Par défaut le contenu reste sur la machine :
  les lignes de diff suffisent à suivre la session, et un fichier entier montre souvent plus de
  code qu'on ne veut en partager.

## L'import

Un `.wpreplay` vient de quelqu'un d'autre : c'est du contenu externe (S2). Le main ne lit qu'un
fichier choisi dans une boîte native, refuse un dossier et ce qui dépasse 25 Mo, et l'envoie au
backend en base64. Le backend borne la taille décompressée (120 Mo, lue par morceaux, pas
`gzip.decompress`) puis **reconstruit** la session champ par champ (`session_from_bundle`) : un
texte reste un texte coupé à sa borne, un nombre reste un nombre fini, un type d'étape inconnu
devient `progress`, un point d'arrêt d'un type inconnu disparaît, un `tool_input` est un JSON de
profondeur et de taille bornées, le reste est ignoré. La session reçoit un **nouvel id** et
l'étiquette `imported` : elle ne remplace jamais une session enregistrée ici, et son id ne vient
pas du fichier (il devient un nom de fichier du store). Rien dans un rejeu importé n'est exécuté.

## La page HTML

`viewer.py` écrit une page complète depuis le bundle déjà masqué : en-tête (agent, modèle,
tâche, durée, tokens si gardés), notes (masquage, raisonnement absent ou retiré), signets
(liens vers leur étape) et la chronologie en `<details>`. Elle n'a **aucun script** : chaque
texte est échappé, et sa Content-Security-Policy (`default-src 'none'`) n'autorise que sa propre
feuille de style, par empreinte. Un texte qui passerait pour du balisage ne ferait donc rien
tourner, et la page s'ouvre hors ligne, sans WorkPilot ni SDK. Elle parle la langue de l'app qui
l'a écrite (anglais ou français), avec ses propres libellés : c'est un document exporté, pas une
vue du renderer.

## La vidéo

`video.py` enregistre la page HTML ci-dessus, écrite depuis le bundle déjà masqué (avec les
mêmes options : raisonnement, tokens) : la vidéo ne montre rien que la page ne montrerait. Elle
est jouée dans un Chromium sans fenêtre, celui que la vérification trouve
(`chrome_executable`, déplacé de `verify/devtools.py` vers `foundation/platform/browser.py` :
le rejeu est importé par les agents, et `verify` importe `core`, ce qui l'aurait fait entrer
dans le cycle d'imports), ou celui de Playwright, sous l'enregistrement vidéo de Playwright :

- **JavaScript coupé** (`java_script_enabled=False`). La page n'a aucun script et aucun n'y
  tourne ; Playwright ouvre chaque étape en cliquant son `<summary>`, que le navigateur déplie
  seul, referme la précédente, et fait défiler la page.
- **Réseau coupé deux fois** : le contexte est hors ligne et refuse toute requête (`route` →
  `abort`), la page est posée par `set_content` (aucune URL, aucun fichier) ; le navigateur
  lui-même est lancé sans trafic de fond (mises à jour, pings) et derrière un proxy qui
  n'existe pas, boucle locale comprise.
- **Durée et taille bornées** : 1,5 s par étape, moins pour une longue session (jamais moins de
  0,25 s), dans 120 s au total ; les étapes qui n'y tiennent pas sont laissées à la page, et la
  notice le dit (« 3 étapes sur 9 »). L'enregistrement a une échéance (180 s), et la vidéo
  n'est lue que si elle tient dans 40 Mo (une lecture, un octet de plus que la borne). Une
  vidéo à la fois (409 sinon).
- **Le fichier** : Playwright l'écrit dans un dossier temporaire fait pour lui ; son chemin est
  résolu et vérifié dans ce dossier (et en `.webm`) avant d'être lu, puis le dossier est
  supprimé. Le backend rend les octets ; le main vérifie qu'ils sont un WebM (en-tête EBML) dans
  la borne avant d'ouvrir la boîte d'enregistrement, résout le dossier choisi (liens compris),
  force le nom en `.webm`, refuse un lien ou un dossier à sa place et écrit par une seule
  poignée ouverte sans suivre de lien (`O_NOFOLLOW` là où l'OS l'a).

Pas de Playwright, pas de navigateur, ou pas d'encodeur vidéo de Playwright (`ffmpeg`, installé
à part : `playwright install ffmpeg`) est une **réponse**, pas une erreur : la route répond
`available: false` et le nom de ce qui manque (`no_playwright`, `no_browser`, `no_encoder`),
et l'app l'affiche avec la commande qui l'installe. Le WebM est le format natif de Playwright.

### Deux sessions côte à côte

La vue de comparaison du rejeu propose la vidéo des deux sessions qu'elle compare
(`POST /replay/compare/video`, deux ids). `compare_page.py` rend une page à deux colonnes,
chacune écrite depuis le bundle masqué de sa session avec les mêmes options, ses textes
échappés, ses identifiants préfixés (`a-step-`, `b-step-`), sans script, avec sa propre CSP
(l'empreinte de sa feuille de style, `_csp` de `viewer.py`). `video.py` y trouve les colonnes
(`main.pair > section.side`) et ouvre à chaque pas l'étape suivante de chacune ; une colonne
qui n'a plus d'étape garde la dernière ouverte. Les bornes, le navigateur et l'enregistrement
sont ceux d'une session seule : la durée se compte sur la plus longue des deux.

### Le MP4

Le MP4 est le WebM encodé de nouveau (`mp4.py`), parce qu'un lecteur ou un outil de
présentation ne lit pas toujours le WebM. Il passe par le `ffmpeg` du système
(`find_executable`, jamais un chemin venu de l'app) : liste d'arguments, `-nostdin`, entrées et
sorties sur `DEVNULL`, environnement construit (`PATH` et les dossiers temporaires, aucune
variable d'identifiant), dossier temporaire à lui, supprimé ensuite. H.264 (`libx264`) d'abord,
MPEG-4 quand la build de ffmpeg n'a pas H.264 ; échéance de 120 s, sortie lue dans la borne de
40 Mo. Pas de ffmpeg, ou un ffmpeg qui ne démarre pas, est une réponse (`no_mp4_encoder`) ; le
main vérifie la boîte `ftyp` avant d'ouvrir la boîte d'enregistrement, et force le nom en
`.mp4`. Le format arrive du renderer en liste fermée (`webm`, `mp4`).

## Le résumé par un modèle

Certains modèles ne donnent aucune trace de raisonnement : leur rejeu montre ce qui a été fait,
jamais pourquoi. Pour une telle session (aucune étape `agent_thinking`, aucun `reasoning`), la
vue propose « Résumer avec <provider> » ; une session qui a son raisonnement est refusée (409).

- **Quel modèle** : le provider par défaut de l'app (Réglages → Agent, `selectedProvider`) et
  son modèle rapide (`models_registry.tier_pick(…, "fast")`, sinon le modèle par défaut du
  provider ; un provider local prend le modèle réglé pour lui, une CLI sans catalogue le sien).
  Le nom du provider est contrôlé deux fois (main et route, `^[a-z0-9][a-z0-9_.-]{0,39}$`) ;
  c'est `create_agent_client` qui le route, comme pour un build.
- **Par quelle porte** : `core.client.create_agent_client`, atteint par le port
  `agent_runtime` (les agents importent le rejeu, qui ne peut donc pas importer `core`), avec
  le type `replay_summary` (aucun outil, aucun serveur MCP, roster `solo`), un dossier projet
  vide et temporaire, et une échéance de 120 s. L'authentification est celle du provider
  choisi : l'OAuth Claude ne compte que pour Claude.
- **Ce que le modèle lit** : la session telle qu'elle serait exportée, masquée et sans tokens
  ni coûts, en une ligne par étape (bornée : 300 étapes, 400 caractères par champ, 40 000 au
  total), passée par `quote_untrusted` (nettoyée, délimitée). Une sortie d'outil ou une tâche
  peut ressembler à une consigne : le prompt dit qu'elle n'en est pas une.
- **Ce qui est gardé** : la réponse, masquée à son tour (mêmes motifs, mêmes dossiers), coupée à
  4 000 caractères, rangée dans la session (`SessionSummary` : texte, provider, modèle, langue,
  date). Elle part donc avec l'export, s'affiche dans la page (« Écrit par un modèle ») et dans
  la vidéo, et revient à l'import, reconstruite et bornée comme le reste. L'app l'affiche comme
  du texte.

## Les signets

Un signet (`Bookmark` dans `models.py` : étape, note Markdown affichée comme texte, auteur,
date) vit dans le fichier de la session : il part dans l'export et revient à l'import. Seule une
session enregistrée en prend un ; une session encore en cours d'enregistrement est réécrite par
le recorder quand elle se termine, ce qui perdrait le signet (409). Au plus 200 par session,
note de 4 000 caractères.

Un signet se discute : chaque lecteur d'une session enregistrée répond à sa note
(`BookmarkReply` : note, auteur, date ; au plus 50 réponses par signet, même borne de note) ;
une réponse se retire sur la machine qui garde la session, la seule à l'écrire. Les réponses vivent dans le fichier de la session, comme
le signet : elles partent masquées avec l'export, reviennent bornées à l'import (les 50
premières entrées sont lues, ce qui n'est pas une réponse parmi elles est écarté) et
s'affichent sous le signet dans la page, comme du texte. Une discussion entre deux machines
passe donc par un nouvel export ou par un lien d'équipe.

## Le lien d'équipe (mode serveur)

Sans hébergement, un rejeu ne se partageait qu'en envoyant un fichier. Le mode serveur en a
un : un membre d'un projet du serveur confie la session au projet et reçoit un lien
(`shared_features/replay_shares.py`, feature `replay_shares`, domaine `lab`, table
`replay_shares`).

- **Ce qui est gardé** : le bundle que l'app de l'auteur a construit, déjà masqué sur sa
  machine, avec les options de la boîte de partage. Le serveur le relit une fois par le même
  décodeur borné qu'un import (10 Mo au plus), pour ne garder qu'un bundle que l'app saura
  ouvrir, et en tire son titre et son nombre d'étapes. Rien n'y est exécuté.
- **Le lien** : `workpilot-replay://<hôte>/<projet>/<partage>#<jeton>`, un jeton aléatoire de
  32 octets dont le serveur ne garde que le SHA-256 (comparé en temps constant) : une copie de
  la base ne reconstruit aucun lien. Le jeton voyage dans le corps de la requête qui ouvre le
  partage, jamais dans une URL qu'un proxy journaliserait. L'app ne montre le lien qu'une fois,
  à sa création.
- **Durée et révocation** : de 1 à 30 jours (7 par défaut ; l'app offre 1, 7 et 30) ; l'auteur ou le propriétaire du
  projet le révoque depuis la boîte de partage, et l'auteur aussi depuis les Réglages (plus bas). Un lien révoqué ou expiré répond 410 et son
  bundle quitte la base ; au plus 200 liens ouverts par projet, et les liens finis depuis
  30 jours sont oubliés.
- **Qui l'atteint** : chaque route prend un `project_id` résolu par `resolve_project_scope`
  (un autre tenant reçoit 404). Lister et ouvrir demandent `lab.read` (tout rôle du projet) et
  le jeton ; créer, `lab.write` et le rôle `member` ; révoquer, être l'auteur ou le
  propriétaire. Il n'y a pas de lecteur public (décision plus bas).
- **L'ouverture** : collé dans « Ouvrir un lien d'équipe » à côté d'Import, le lien est
  analysé par le main (schéma, hôte du serveur connecté, projet connu) et le bundle reçu passe
  par `/replay/import` comme un fichier : reconstruit, borné, sous un nouvel id.
- **La mesure** : le serveur compte les ouvertures de chaque lien, et l'app l'affiche à côté du
  lien ; l'équipe voit si ses partages sont lus. Il garde aussi le nombre de signets du bundle
  reçu (colonne `bookmarks`, révision `0020` ; inconnu pour un lien plus ancien), pour l'usage du
  projet.

### Tous ses liens, depuis les Réglages

La boîte de partage ne montre que les liens d'un projet. « Liens de rejeu », dans les Réglages
en mode serveur, montre ceux que la personne a créés sur **tous** les projets du serveur
(`GET /api/features/replay-shares/mine`, `lab.read`, sans `project_id`) : seulement les siens
(`created_by`), seulement dans l'organisation où elle agit, et seulement sur un projet qu'elle
atteint encore, chacun autorisé de nouveau par `load_project_scope`, la porte de toute route qui
prend un `project_id` ; un projet qu'elle a quitté n'est pas listé. Chaque ligne donne le
projet, l'état, l'échéance et les ouvertures ; « Révoquer » passe par la route du projet
(`DELETE /{share}?project_id=`), qui revérifie l'auteur. Le bundle n'est pas chargé pour la
liste (`defer`).

## L'usage, compté sur place

L'issue demandait des métriques (exports par semaine, taux d'ouverture des liens, part des rejeux
annotés). **Décision de Leub (2026-11-21)** : elles se calculent là où vivent les rejeux, et nulle
part ailleurs. Il n'y a aucune télémétrie ; rien n'est envoyé à un service.

- **Sur la machine** (`replay/usage.py`, `GET /replay/usage`) : un relevé à côté des sessions
  (`replays/usage/exports.json`, hors du `*.json` que lit le store) garde une entrée par export
  vraiment produit, avec son heure et son genre en liste fermée (`wpreplay`, `html`, `video`,
  `team_link`) : ni id de session, ni titre, ni chemin. Le main la pose
  (`POST /replay/usage/exports`) une fois le fichier écrit ou le lien créé ; une boîte fermée
  sans enregistrer ne compte pas, et un backend muet laisse l'export non compté sans le gêner.
  Le relevé garde un an, 5 000 entrées au plus, écrit sous verrou (`foundation/json_ledger`). Le
  rapport donne huit semaines glissantes d'exports par genre, la moyenne par semaine, et les
  sessions du store : combien, combien avec un signet (et la part), avec une réponse, résumées,
  importées.
- **Sur le serveur, pour un projet** (`GET /api/features/replay-shares/usage`, `lab.read`, tout
  rôle du projet, `project_id` résolu, un autre tenant reçoit 404) : sur quatre semaines, les
  liens créés par semaine, la part ouverte au moins une fois, les ouvertures, les liens ouverts
  en ce moment, la part annotée, le nombre de personnes qui partagent. Des totaux seulement : ni
  titre, ni personne, ni lien. Quatre semaines parce que tout lien créé dans cette fenêtre est
  encore gardé (il est oublié 30 jours après sa fin).

La vue Agent Replay les affiche sous la liste des enregistrements, avec une ligne qui dit où ils
ont été comptés ; les chiffres du serveur n'apparaissent que pour un projet du serveur choisi.
Le main revérifie chaque réponse (entiers positifs, ratios entre 0 et 1, dates lisibles).

## IPC

Seize canaux (`replay:exportSession`, `replay:importSession`, `replay:addBookmark`,
`replay:removeBookmark`, `replay:addBookmarkReply`, `replay:removeBookmarkReply`,
`replay:exportVideo`, `replay:exportComparisonVideo`, `replay:summarizeSession`,
`replay:shareToTeam`, `replay:listTeamShares`, `replay:revokeTeamShare`,
`replay:openTeamShare`, `replay:listMyTeamShares`, `replay:getUsage`,
`replay:getTeamUsage`), un module de preload typé, des handlers qui revalident : id de session,
de signet, de réponse, de projet et de partage `[A-Za-z0-9_-]`, format, langue et durée en
liste fermée, options booléennes, étape entière bornée, textes bornés, nom de provider de forme
fermée, lien analysé dans le main. Le renderer ne donne jamais de chemin ; le nom de fichier proposé vient du
backend et passe par `path.basename`. Le main n'écrit que ce qui a été demandé (un gzip pour un
`.wpreplay`, une page pour l'HTML, borné comme un bundle) et lit un bundle par une seule poignée
de fichier : le fichier vérifié est celui qui est lu, jamais au-delà de la borne.

## Décision : pas de lecteur public sans compte

L'issue proposait un lecteur public minimal, pour ouvrir un rejeu sans WorkPilot. **Décision de
Leub (2026-11-21)** : il n'y en aura pas. L'export HTML hors ligne couvre ce besoin : une page
sans script, masquée, qui s'ouvre partout sans compte ni SDK, comme la vidéo. Un lecteur public
servi par le serveur serait la seule route sans permission de son API (S5) et exposerait une
session de projet à quiconque tient l'URL ; le lien d'équipe reste réservé aux membres du projet.

## Pas encore fait

Rien de ce que l'issue demande : le format, le masquage, la page, la vidéo côte à côte, les
signets discutés, le résumé, le lien d'équipe révocable (depuis la boîte de partage et les
Réglages) et l'usage compté sur place sont livrés ; le lecteur public est écarté (plus haut).
