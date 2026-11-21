---
feature: "Rejeu d'agent : partage, import, signets, vidéo et résumé"
summary: >-
  Une session enregistrée s'exporte en `.wpreplay` (JSON gzip), en page HTML sans script ou en
  vidéo WebM de cette page jouée hors réseau, toujours masquée (secrets, dossiers du projet et
  du home) ; un rejeu importé est reconstruit champ par champ, borné, sous un nouvel id ; les
  signets et le résumé des étapes écrit par un modèle vivent dans la session.
---

# Partager un rejeu d'agent

> Issue : #347. Règles : [`security.md`](../rules/security.md) (S1, S2, S6),
> [`frontend.md`](../rules/frontend.md) (IPC, i18n). Voisin : [variantes et rejeux](variants-and-replays.md).

Le rejeu (`apps/backend/replay/`) enregistre chaque session d'agent dans
`~/.workpilot/replays/<id>.json` : étapes, appels d'outils, diffs, raisonnement, tokens. Il ne
quittait pas la machine : montrer à un collègue comment l'agent a résolu un problème demandait
un partage d'écran. Une session se partage maintenant de trois façons, se marque, et se
résume quand son modèle n'a pas laissé de raisonnement.

```
apps/backend/replay/
  bundle.py      le format .wpreplay : export masqué, import reconstruit et borné
  viewer.py      la page HTML autonome, rendue depuis un bundle déjà masqué
  bookmarks.py   signets d'une session enregistrée
  video.py       la page jouée étape par étape dans Chromium, enregistrée en WebM
  summary.py     le résumé des étapes par un modèle, pour une session sans raisonnement
  api.py         POST /replay/sessions/{id}/export, POST /replay/import,
                 POST et DELETE /replay/sessions/{id}/bookmarks,
                 POST /replay/sessions/{id}/video, POST /replay/sessions/{id}/summary
apps/backend/foundation/platform/browser.py   chrome_executable, partagé avec verify
apps/frontend/src/main/ipc-handlers/replay-share-handlers.ts   boîtes natives, fichiers
apps/frontend/src/main/ipc-handlers/replay-video-handlers.ts   vidéo et résumé
apps/frontend/src/renderer/stores/replay-share-store.ts
apps/frontend/src/renderer/components/agent-replay/ReplaySharing.tsx
apps/frontend/src/renderer/components/agent-replay/ReplayStepsSummary.tsx
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
et l'app l'affiche avec la commande qui l'installe. Le WebM est le format natif de Playwright ;
un MP4 demanderait un second encodage, et une vidéo côte à côte (A/B) un rendu de la
comparaison, que la page n'a pas.

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

## IPC

Six canaux (`replay:exportSession`, `replay:importSession`, `replay:addBookmark`,
`replay:removeBookmark`, `replay:exportVideo`, `replay:summarizeSession`), un module de preload
typé, des handlers qui revalident : id de session `[A-Za-z0-9_-]`, format et langue en liste
fermée, options booléennes, étape entière bornée, textes bornés, nom de provider de forme
fermée. Le renderer ne donne jamais de chemin ; le nom de fichier proposé vient du
backend et passe par `path.basename`. Le main n'écrit que ce qui a été demandé (un gzip pour un
`.wpreplay`, une page pour l'HTML, borné comme un bundle) et lit un bundle par une seule poignée
de fichier : le fichier vérifié est celui qui est lu, jamais au-delà de la borne.

## Pas encore fait

- **URL de partage signée** (TTL, révocable dans les réglages) : il faut un hébergement. La
  bonne place est le mode serveur, où les rejeux sont aujourd'hui une feature locale
  (`LOCAL_ONLY_FEATURES`).
- **Vidéo MP4 et vidéo côte à côte** (deux sessions comparées) : le WebM d'une session est
  fait ; le MP4 demanderait un second encodage, le côte à côte une page de comparaison.
- **Discussion d'un signet** à plusieurs, et les métriques d'usage (exports par semaine, taux de
  signets).
