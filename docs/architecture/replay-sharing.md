---
feature: "Rejeu d'agent : partage, import et signets"
summary: >-
  Une session enregistrée s'exporte en `.wpreplay` (JSON gzip) ou en page HTML sans script,
  toujours masquée (secrets, dossiers du projet et du home) ; un rejeu importé est reconstruit
  champ par champ, borné, sous un nouvel id ; les signets vivent dans la session.
---

# Partager un rejeu d'agent

> Issue : #347. Règles : [`security.md`](../rules/security.md) (S1, S2, S6),
> [`frontend.md`](../rules/frontend.md) (IPC, i18n). Voisin : [variantes et rejeux](variants-and-replays.md).

Le rejeu (`apps/backend/replay/`) enregistre chaque session d'agent dans
`~/.workpilot/replays/<id>.json` : étapes, appels d'outils, diffs, raisonnement, tokens. Il ne
quittait pas la machine : montrer à un collègue comment l'agent a résolu un problème demandait
un partage d'écran. Une session se partage maintenant de deux façons, et se marque.

```
apps/backend/replay/
  bundle.py      le format .wpreplay : export masqué, import reconstruit et borné
  viewer.py      la page HTML autonome, rendue depuis un bundle déjà masqué
  bookmarks.py   signets d'une session enregistrée
  api.py         POST /replay/sessions/{id}/export, POST /replay/import,
                 POST et DELETE /replay/sessions/{id}/bookmarks
apps/frontend/src/main/ipc-handlers/replay-share-handlers.ts   boîtes natives, fichiers
apps/frontend/src/renderer/stores/replay-share-store.ts
apps/frontend/src/renderer/components/agent-replay/ReplaySharing.tsx
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

## Les signets

Un signet (`Bookmark` dans `models.py` : étape, note Markdown affichée comme texte, auteur,
date) vit dans le fichier de la session : il part dans l'export et revient à l'import. Seule une
session enregistrée en prend un ; une session encore en cours d'enregistrement est réécrite par
le recorder quand elle se termine, ce qui perdrait le signet (409). Au plus 200 par session,
note de 4 000 caractères.

## IPC

Quatre canaux (`replay:exportSession`, `replay:importSession`, `replay:addBookmark`,
`replay:removeBookmark`), un module de preload typé, un handler qui revalide : id de session
`[A-Za-z0-9_-]`, format et langue en liste fermée, options booléennes, étape entière bornée,
textes bornés. Le renderer ne donne jamais de chemin ; le nom de fichier proposé vient du
backend et passe par `path.basename`. Le main n'écrit que ce qui a été demandé (un gzip pour un
`.wpreplay`, une page pour l'HTML, borné comme un bundle) et lit un bundle par une seule poignée
de fichier : le fichier vérifié est celui qui est lu, jamais au-delà de la borne.

## Pas encore fait

- **URL de partage signée** (TTL, révocable dans les réglages) : il faut un hébergement. La
  bonne place est le mode serveur, où les rejeux sont aujourd'hui une feature locale
  (`LOCAL_ONLY_FEATURES`).
- **Export vidéo** (MP4 / WebM côte à côte) : il faut un moteur de rendu ; la page HTML couvre la
  lecture, pas la démo animée.
- **Résumé par un LLM** quand le modèle n'a pas de trace de raisonnement.
- **Discussion d'un signet** à plusieurs, et les métriques d'usage (exports par semaine, taux de
  signets).
