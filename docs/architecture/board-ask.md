---
feature: Interroger le tableau
summary: >-
  Une question en n'importe quelle langue, répondue avec tous les tickets du projet qui s'y
  rapportent : le modèle du provider choisi traduit la question vers les langues du tableau ; un
  BM25 et, avec un modèle d'embeddings (local d'abord), un classement par
  le sens trouvent les candidats, fusionnés ; le modèle juge la couverture ; sans lui, le
  classement fusionné répond seul.
---

# Interroger le tableau

Demandé par Leub le 27 novembre 2026 : une rubrique du Kanban où l'on pose une question, comme à
un chatbot, et qui ressort tous les tickets liés, quelle que soit la langue de la question et
celle des tickets. Le but : aider le product owner à voir si une future fonctionnalité n'a pas
déjà été développée, même en partie. Leub a retenu quatre lots.

| Lot | Contenu |
|---|---|
| 1 | le panneau, la recherche par mots-clés, le modèle pour comprendre et juger |
| 2 | des embeddings multilingues quand un modèle est là (Ollama, LM Studio, API du provider) : [le sens](#le-sens-lot-2) |
| 3 | « Vérifier une idée » : une fonctionnalité collée, sa couverture exigence par exigence : [l'idée](#vérifier-une-idée-lot-3) |
| 4 | d'autres sources (roadmap, idées, PR et commits), le mode serveur, l'app mobile |

## Pourquoi pas seulement des embeddings

Tous les providers ne servent pas d'embeddings (Claude n'en a pas), et un modèle local n'est pas
toujours installé. Le lot 1 marche donc avec **n'importe quel** provider : c'est le modèle de
conversation, par `runOneShotLLM`, qui fait le pont entre les langues. Les embeddings du lot 2
s'ajoutent aux candidats, ils ne remplacent pas cette base.

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

Sans réponse lisible du modèle (pas de provider, délai de 60 s dépassé, sortie illisible), le
classement répond seul et le panneau le dit (`semantic` : par le sens et les mots-clés,
`keywords` : par les mots-clés). Le panneau a toujours quelque chose à montrer.

## Le sens (lot 2)

Un modèle d'embeddings lit la question et chaque ticket ; deux textes qui disent la même chose ont
des vecteurs proches, quelles que soient leurs langues et leurs mots. « admin page review » trouve
« Revisión del panel de administración » sans un mot en commun, même quand aucun modèle de
conversation ne répond.

- **Quel modèle** (`apps/backend/board_ask/semantic.py`, appelé par
  `runners/board_ask_embed_runner.py`, lancé par `main/board-ask/semantic-search.ts`) : d'abord
  celui d'un serveur local, le même que la passe de conflits du cerveau
  (`brain.lifecycle.embeddings.find` : Ollama puis LM Studio, un modèle multilingue comme `bge-m3`
  d'abord, jamais téléchargé) ; sinon, en `auto`, l'API d'embeddings du provider choisi : OpenAI (ou
  une `OPENAI_BASE_URL` compatible), Mistral, Google, Hugging Face (`multilingual-e5-large`, qui lit
  la question et les tickets avec leurs préfixes `query:` / `passage:`). Claude n'a pas d'API
  d'embeddings : sans modèle local, le lot 1 reste la base. `BOARD_ASK_EMBEDDINGS_MODEL` change le
  modèle de l'API.
- **Le réglage** (`boardAskSemantic`, choisi dans le pied du panneau) : `auto` (par défaut),
  `local` (cet ordinateur seulement : pour cette étape, aucun ticket n'en sort), `off`. Le main le
  relit dans une liste fermée.
- **La fusion** (`fuseRanks`) : rang réciproque (1 / (60 + rang)) des mots-clés et du sens. Le
  modèle de conversation reçoit les 30 premiers des deux ; sans lui, le panneau liste les tickets
  par le sens qui sont à moins de `SEMANTIC_BAND` (0,12) du cosinus du plus proche. Le sens est
  demandé pendant que le modèle comprend la question : il n'ajoute pas d'attente.
- **Borné.** 1 500 tickets de 2 000 caractères au plus ; le modèle est interrogé 30 s au plus,
  par lots, le runner tué à 45 s. Les vecteurs sont gardés par provider, modèle et empreinte du
  texte dans `<userData>/board-ask/` (dossier de l'app, jamais un projet), 4 000 au plus : la
  question suivante n'envoie que ce qui a changé. Un grand tableau est donc lu en quelques
  questions, et le panneau dit combien l'ont été (« 30 tickets sur 40 lus par le sens »).

Frontières du lot 2 :

- **Secrets (S1).** Le runner reçoit `pythonRunnerEnv` : le provider choisi et sa clé, rien
  d'hérité. La clé ne part que dans l'en-tête `Authorization` ; aucun message ne la contient. Le
  texte d'un ticket passe par `redact_text` (et la redaction du cerveau pour un modèle local) avant
  d'être envoyé.
- **Réseau.** Une API est en `https` (`http` seulement sur la boucle locale), sans identifiants
  dans l'URL, sans redirection suivie, avec délai et réponse bornée (16 Mo). Le serveur local
  passe par `offline_policy.local_endpoint`, qui refuse tout ce qui n'est pas la boucle locale.
- **Hors-ligne strict (S7).** Sous `airgapStrict`, seul un modèle local est demandé.
- **Ce qui revient** est lu comme des nombres (vecteurs finis, 8 192 dimensions au plus) côté
  Python, puis champ par champ (zod) côté main, et seulement pour les ids envoyés.
- **RGPD.** Les tickets vont au modèle local d'abord ; à l'API du provider déjà choisi sinon, que
  `local` ou `off` évitent. Les vecteurs restent sur la machine ; ni la question ni la conversation
  ne sont écrites.

## Vérifier une idée (lot 3)

Le second onglet du panneau répond à la question du product owner avant qu'il écrive une carte :
« ce que je prévois, le tableau l'a-t-il déjà, même en partie ? ». Il colle la fonctionnalité
(une phrase, une liste, une spec, 6 000 caractères au plus) ; `main/board-ask/idea-check.ts` :

1. **Découpe.** Le modèle du provider choisi la coupe en 12 exigences vérifiables au plus et lui
   donne un titre, dans la langue de l'idée. Sans modèle, ses puces (deux au moins) ou ses
   phrases sont les exigences, et sa première ligne le titre.
2. **Cherche.** Chaque exigence est cherchée comme une question : le BM25 (avec le titre de
   l'idée, à poids 0,3, pour le contexte) et, quand un modèle d'embeddings répond, son sens. Le
   runner reçoit **toutes les exigences en un appel** (`queries`, 16 au plus) : les tickets ne
   sont lus et vectorisés qu'une fois. Les deux classements sont fusionnés par RRF, 8 candidats
   par exigence.
3. **Juge.** Le modèle lit les exigences (`R1`…) et l'union de leurs candidats (`T1`…, 40 au
   plus, pris à tour de rôle pour que chaque exigence apporte ses meilleurs) et rend, par
   exigence, `done`, `partial` ou `missing`, les tickets qui la portent et une phrase ; puis un
   résumé. Une exigence qu'il ne juge pas, ou toutes quand il ne répond pas, reste `unknown`
   (« À vérifier ») avec ses 3 tickets les plus proches (la bande du sens écarte les lointains).

**Créer la carte.** Le bouton « Créer une carte avec ce qui manque » crée, par l'API de création
de tâche qu'utilise déjà le tableau, une carte du backlog : le résumé, puis ce qui est à
construire, à terminer (avec les tickets sur lesquels s'appuyer) et à vérifier ; ce qui est déjà
fait est listé à part, l'idée d'origine ferme la description (`kanban/board-ask/idea-card.ts`).
Rien n'est créé sans ce clic, et rien quand toutes les exigences sont faites.

Les mêmes frontières que la question valent : le renderer n'envoie qu'un id de projet et l'idée,
revérifiés par `parseBoardIdeaRequest` ; l'idée et les tickets entrent dans les prompts par
`quoteUntrusted` ; le modèle ne nomme que les références données, les verdicts sont une liste
fermée ; la dernière idée vérifiée par projet vit en mémoire seulement.

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
| `main/board-ask/board-ask-service.ts` | prompts, lecture des réponses, les trois étapes, la fusion |
| `main/board-ask/semantic-search.ts` | lance le runner d'embeddings, relit son classement, le réglage |
| `apps/backend/board_ask/semantic.py`, `runners/board_ask_embed_runner.py` | le modèle d'embeddings : choix, appels, cache des vecteurs |
| `main/board-ask/idea-check.ts` | « Vérifier une idée » : découpe, recherche par exigence, jugement |
| `main/ipc-handlers/board-ask-handlers.ts` | canaux `boardAsk:ask` et `boardAsk:checkIdea`, revalidation |
| `renderer/stores/board-ask-store.ts` | panneau ouvert, onglet, une conversation et une idée par projet |
| `renderer/components/kanban/board-ask/` | bouton de la barre, panneau, onglet `IdeaCheckView.tsx`, carte `idea-card.ts` |

Tests : `shared/utils/__tests__/board-ask-search.test.ts`,
`main/board-ask/__tests__/board-ask-service.test.ts`,
`main/board-ask/__tests__/semantic-search.test.ts`, `main/board-ask/__tests__/idea-check.test.ts`,
`tests/board_ask/`, `main/ipc-handlers/__tests__/board-ask-handlers.test.ts`,
`renderer/components/kanban/board-ask/BoardAskPanel.test.tsx`, `IdeaCheckView.test.tsx`,
`idea-card.test.ts`.
