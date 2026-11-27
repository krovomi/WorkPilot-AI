---
feature: Interroger le tableau
summary: >-
  Une question en n'importe quelle langue, répondue avec tous les tickets du projet qui s'y
  rapportent : le modèle du provider choisi traduit la question vers les langues du tableau, un
  BM25 sans dictionnaire trouve les candidats, le modèle juge la couverture ; sans modèle, les
  mots-clés répondent seuls.
---

# Interroger le tableau

Demandé par Leub le 27 novembre 2026 : une rubrique du Kanban où l'on pose une question, comme à
un chatbot, et qui ressort tous les tickets liés, quelle que soit la langue de la question et
celle des tickets. Le but : aider le product owner à voir si une future fonctionnalité n'a pas
déjà été développée, même en partie. Leub a retenu quatre lots ; celui-ci est le premier.

| Lot | Contenu |
|---|---|
| 1 (ici) | le panneau, la recherche par mots-clés, le modèle pour comprendre et juger |
| 2 | des embeddings multilingues quand un modèle est là (Ollama, LM Studio, API du provider) |
| 3 | « Vérifier une idée » : une fonctionnalité collée, sa couverture exigence par exigence |
| 4 | d'autres sources (roadmap, idées, PR et commits), le mode serveur, l'app mobile |

## Pourquoi pas seulement des embeddings

Tous les providers ne servent pas d'embeddings (Claude n'en a pas), et un modèle local n'est pas
toujours installé. Le lot 1 marche donc avec **n'importe quel** provider : c'est le modèle de
conversation, par `runOneShotLLM`, qui fait le pont entre les langues. Les embeddings du lot 2
s'ajouteront aux candidats, ils ne remplaceront pas cette base.

## Les trois étapes (`main/board-ask/board-ask-service.ts`)

1. **Comprendre.** Le modèle réécrit la question en une question autonome (une question de suivi
   lit la conversation) et donne les mots qu'un ticket sur le sujet emploierait, synonymes et noms
   techniques compris, dans l'anglais et dans chaque langue du tableau
   (`detectLanguages` : les mots courants de sept langues, une langue retenue quand elle gagne au
   moins un ticket sur dix).
2. **Chercher.** `KeywordIndex` (`shared/utils/board-ask-search.ts`) : BM25, mots pliés (casse,
   accents), radical de six lettres, un mot court trouve les radicaux qu'il commence (« admin »
   trouve « administration ») ; chinois, japonais, coréen et thaï lus par paires de caractères. Le
   titre compte triple, les fichiers touchés (`AdminPage.tsx` dit aussi « admin page ») à moitié.
   Un tableau de 30 tickets ou moins est lu **en entier** par le modèle : rien à manquer.
   Au-delà, les 30 meilleurs candidats.
3. **Juger.** Le modèle lit chaque candidat (titre, état, description, début de la spec, étapes,
   fichiers) et dit, pour ceux qui se rapportent à la question, s'il la couvre `full`, `partial`
   ou seulement `related`, en une phrase, puis répond en citant les tickets. La réponse et les
   raisons sont dans la langue de la question, sinon dans celle de l'app.

Sans réponse lisible du modèle (pas de provider, délai de 60 s dépassé, sortie illisible), les
mots-clés répondent seuls et le panneau le dit. Le panneau a toujours quelque chose à montrer.

## Ce qui est lu

Toutes les cartes du projet (`projectStore.getTasks`), **terminées, archivées et abandonnées
comprises** : c'est ce qu'un product owner veut retrouver. L'état est dit avec ses mots
(`ticketState` : terminé, en revue, en cours, prévu, échec, abandonné), le début de
`<spec>/spec.md` (16 Ko lus au plus, 1 500 caractères gardés) complète la description.

## Frontières

- **Renderer (S6).** Il n'envoie qu'un id de projet, une question (1 000 caractères au plus) et la
  conversation (20 tours au plus acceptés, les 4 derniers lus, 4 000 caractères par texte) ; le
  handler (`main/ipc-handlers/board-ask-handlers.ts`) les revérifie et lit les tickets lui-même.
- **Contenu externe (S2).** Un ticket peut venir de Jira, d'Azure DevOps ou d'une issue : son
  texte, la question et la conversation entrent dans les prompts par `quoteUntrusted`. Le modèle
  ne nomme un ticket que par une référence (`T1`, `T2`…) donnée par le code : une référence
  inconnue est ignorée, la couverture est une liste fermée, chaque texte est borné.
- **RGPD.** La question et les tickets ne vont qu'au provider déjà choisi dans les réglages, comme
  pour les autres analyses ; le mode hors-ligne strict s'applique par `runOneShotLLM`. La
  conversation vit en mémoire (`stores/board-ask-store.ts`) et n'est jamais écrite sur disque.
- **Mode serveur.** Un tableau du serveur n'est pas interrogé ici (le bouton n'y est pas, le
  handler répond `server_project`) : il le sera sur le serveur, avec sa permission, au lot 4.

## Fichiers

| Fichier | Rôle |
|---|---|
| `shared/utils/board-ask-search.ts` | mots, langues, BM25 |
| `shared/types/board-ask.ts` | requête, résultat, bornes |
| `main/board-ask/tickets.ts` | une carte en ticket : état, spec, document de recherche, résumé |
| `main/board-ask/board-ask-service.ts` | prompts, lecture des réponses, les trois étapes |
| `main/ipc-handlers/board-ask-handlers.ts` | canal `boardAsk:ask`, revalidation |
| `renderer/stores/board-ask-store.ts` | panneau ouvert, une conversation par projet |
| `renderer/components/kanban/board-ask/` | bouton de la barre, panneau |

Tests : `shared/utils/__tests__/board-ask-search.test.ts`,
`main/board-ask/__tests__/board-ask-service.test.ts`,
`main/ipc-handlers/__tests__/board-ask-handlers.test.ts`,
`renderer/components/kanban/board-ask/BoardAskPanel.test.tsx`.
