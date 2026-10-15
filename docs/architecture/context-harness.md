# Harness de contexte : le plan

> **Statut : plan, rien n'est construit.** Ce fichier fixe la cible et l'ordre des lots ; chaque
> lot livré remplace sa section par la justification de ce qui existe. [`docs/CLAUDE.md`](../CLAUDE.md)
> reste normatif : là où les deux divergent, il gagne. Le mécanisme existant de compaction et de
> reset est décrit dans [`context-management.md`](context-management.md), que ce plan prolonge sans
> le remplacer.

## La thèse

Un LLM est une fonction sans état : à chaque appel, tout repart sur le réseau (system, outils,
règles, extraits, historique, raisonnement, question). On ne contrôle ni les poids ni
l'échantillonnage ; on contrôle **ce qu'il y a dans la fenêtre**. Le harness est la machine à états
qui administre cette ressource : il assemble le contexte, exécute les outils, mesure, et décide
quand résumer, purger ou déléguer. Il nous appartient, donc il se logge, se rejoue et se teste.

Sources reprises : la note « Sous le capot des LLM » (§03 *Le contexte*, §08 *Agents*, §10
*Assistants de code*, §11 *Exploitation*), sa « Synthèse IA », le simulateur « Le contexte d'un
agent » de l'« Atelier IA », la revue « The Unwired Loop » de ce dépôt, la documentation de Claude
Code et de l'API Anthropic relue en octobre 2026, et, pour les autres providers, ce que leurs
clients dans `core/agent_clients/` lisent déjà.

Les cinq techniques de §03, et ce qu'elles deviennent ici :

| Technique | Déclencheur | Dans le harness |
|---|---|---|
| Troncature à la source | à l'écriture de l'outil | chaque outil de WorkPilot pagine et plafonne lui-même (lot 3) ; la seule qui empêche le problème au lieu de le réparer |
| Tool clearing | résultat consommé | le corps d'un vieux résultat d'outil devient un marqueur, par lots (lot 4) |
| Compaction | ~70–80 % du plafond | le `ContextGuard` existant, calé sur la fenêtre *effective* (lot 4) |
| Mémoire externe | dès qu'un résultat resservira | la sortie longue va dans un fichier, le modèle relit par offset (lots 3 et 5) |
| Sous-agents | sous-tâche exploratoire | contexte neuf, seule la conclusion remonte, sous contrat vérifié (lot 5) |

Et la règle d'ordre qui rend le cache possible chez tous les providers qui en ont un : **system →
définitions d'outils → règles projet → documents de référence → historique → question**, du plus
stable au plus volatil, le préfixe identique octet pour octet.

## Indépendant du provider

WorkPilot pilote une douzaine de providers. Le harness n'en privilégie aucun : **son domaine ne
connaît que des capacités, jamais un nom de provider**, et chaque technique a deux voies.

- **La voie native** : le provider ou la CLI qui tient la boucle le fait déjà. Le harness le règle
  par ce qu'elle expose, et le mesure.
- **La voie WorkPilot** : personne ne le fait à sa place. Le harness le fait, par une fonction
  pure du domaine.

Le harness ne compte jamais sur une voie native pour être correct : une capacité non documentée
vaut « absente ». Les capacités se déclarent dans le bloc `context:` de `capabilities/providers.yaml`,
déjà servi à l'UI par `/providers/agentic-capabilities` ; chaque lot y ajoute les clés dont il a
besoin, avec leur valeur pour chaque provider.

Deux familles de boucles :

| Famille | Providers | Ce que le harness fait |
|---|---|---|
| **Boucle tierce** : un SDK ou une CLI tient la boucle | Claude (Claude Agent SDK, et les providers sans adaptateur qui retombent dessus), Codex CLI, OpenCode, Antigravity | règle les seuils et plafonds que la boucle expose, fournit le prompt assemblé et des outils MCP de WorkPilot qui tronquent à la source, mesure chaque tour, coupe la session au plafond de coût |
| **Boucle WorkPilot** : `core/agent_clients/` tient la boucle | OpenAI, Google, Mistral, DeepSeek, xAI (compatibles OpenAI), Ollama, LM Studio, Copilot, Windsurf | tout : assemblage, troncature, purge, compaction, arrêts, mesure |

Ce que l'on sait aujourd'hui des voies natives des boucles tierces. « Non documenté » veut dire que
le harness prend la voie WorkPilot.

| Technique | Claude Code (Agent SDK) | Codex CLI | OpenCode | Antigravity |
|---|---|---|---|---|
| Troncature | Bash : au-delà de `bashOutputMaxChars` (~30 000 caractères), la sortie va dans un fichier et le modèle reçoit le chemin et 2 000 caractères ; Read : 25 000 tokens par appel (`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`), `offset`/`limit` ; MCP : `MAX_MCP_OUTPUT_TOKENS` (25 000) ; hook PostToolUse `updatedToolOutput` sur tout outil (à vérifier sur Read et Grep avant d'en dépendre) | non documenté ici | non documenté ici | non documenté ici |
| Purge des vieux résultats | oui, avant la compaction ; mécanisme non documenté, sans réglage | non documenté ici | non documenté ici | non documenté ici |
| Compaction | native, seuil `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (déjà posé par `context_mgmt`) | native, `model_auto_compact_token_limit` (déjà posé) | native (`compaction.auto`), sans commande à la demande en `run` | `/compact` interactif seulement |
| Usage par tour | `AssistantMessage.usage` : non caché, lu, écrit | `turn.completed` : `input_tokens` (cache compris), `cached_input_tokens`, `output_tokens` | `step_finish` : `input` (non caché), `cache.read`, `cache.write` | `input_tokens`, `cache_read_tokens` (inclusion ambiguë, tranchée par `total_tokens`) |
| Sous-agents | natifs ; seul le message final remonte | non | non | non |

## Ce qui existe (au commit `14e2fcf`)

WorkPilot a déjà une bonne part de la mécanique ; ce qui manque, c'est une mesure qui ait le même
sens partout, une boucle unique, et la troncature à la source.

| Sujet | Aujourd'hui | Ce qui manque |
|---|---|---|
| Propriété de la boucle | boucles tierces : Claude Agent SDK (`max_turns` 1000, `max_budget_usd` 5), Codex, OpenCode, Antigravity. Boucles WorkPilot : **cinq copies** de `for turn in range(self.max_turns)` dans `core/agent_clients/` (OpenAI et ses dérivés, Ollama/LM Studio, Copilot, Windsurf ×2) | une boucle partagée ; un plafond de coût hors SDK Claude |
| Assemblage | un seul builder, `build_base_system_prompt` (`core/llm_optimization.py`), sans horodatage ; outils dans un ordre fixe ; `prompt_cache_key` côté OpenAI | le chemin absolu du worktree est la **deuxième phrase** du system : le préfixe change d'une tâche à l'autre, quel que soit le provider. La constitution spec-kit est inlinée dans le prompt de *chaque* sous-tâche |
| Mesure | chaque client remplit `last_usage` et `last_context_tokens` ; `record_client_usage` (`agents/session.py`) l'écrit **par session** dans `core/usage_tracker.py` | `input_tokens` n'a pas le même sens partout : la part non cachée chez Claude, le total cache compris chez OpenCode et Codex. Les boucles WorkPilot ne lisent aucun champ de cache ; Codex garde `cached_input_tokens` mais `record_client_usage` ne le transmet pas. Ni taux de hit, ni coût par appel |
| Compaction | `context_mgmt/` : garde par tâche, seuil 50 % par défaut (30–90), *compact* ou *clear*, handoff préparé en fond par le provider de la tâche, cap de 3 resets ; native sur Claude et Codex, émulée ailleurs | un seuil calculé sur la fenêtre annoncée, pas sur la fenêtre *payable* (palier de prix à 200 k chez certains providers) |
| Tool clearing | boucles WorkPilot : `compact_messages` remplace les vieux résultats par un marqueur au-delà de 300 k caractères. Claude Code purge de son côté | pas de règle d'âge (« plus vieux que N tours »), pas de gain minimal |
| Troncature | rtk sur Bash ; boucles WorkPilot : résultat coupé à 10 k caractères (70 % tête / 30 % queue), recherche à 200 correspondances. Claude Code plafonne nativement (table ci-dessus) | `read_file` lit le fichier entier puis en coupe le milieu, sans `offset`/`limit` ; aucune pagination par curseur ; aucun plafond natif réglé par WorkPilot |
| Mémoire externe | cerveau (vault, `graph.json`, serveur MCP 9 outils), `implementation_plan.json`, `build-progress.txt`, `handoff_pending.md`, rapports de phase plafonnés | pas de déversement des sorties longues vers un fichier relisible dans les boucles WorkPilot |
| Sous-agents | registre `agents/subagents/`, roster ≤ 7 ; Claude et Copilot | « rends une synthèse structurée » n'est qu'une consigne : rien ne la vérifie ; Copilot les lance tous à la fois |
| Outils dynamiques | `AGENT_CONFIGS` par type d'agent ; MCP ajoutés selon la tâche ; schémas MCP différés sur Claude (`ENABLE_TOOL_SEARCH=auto:5`) | rien par phase dans une même tâche, ni pour les autres providers |
| Effort et routage | effort par phase (`phase_config.py`), traduit par provider (`reasoning_effort`, budget de réflexion) ; routeur de complexité et `model_router` presque toujours éteints | pas d'escalade automatique |
| Récupération de code | `context/search.py` : correspondance de sous-chaînes ; grepai seulement pour l'autofix | ni BM25, ni fusion, ni budget d'extraits |
| Évals | `tests/skills_eval/` : 6 épisodes rejoués sans LLM en CI | aucun banc qui fasse tourner l'agent sur des tâches réelles |

## La cible : trois couches, une seule boucle

Le découpage est celui d'une clean architecture : les décisions sont des fonctions pures testées
par table (comme `context_mgmt/decide.py` aujourd'hui), la boucle les orchestre, les providers sont
des adaptateurs derrière un port.

```
apps/backend/harness/
  domain/         pur, sans I/O, sans nom de provider — testé par table
    usage.py        un appel mesuré, quel que soit le format d'usage du provider
    ledger.py       la session : cumuls, taux de hit, réécritures de préfixe
    layout.py       segments ordonnés par stabilité, empreinte du préfixe
    budget.py       fenêtre effective, composition du contexte, seuils
    policies.py     arrêt, clearing, choix compact/clear (reprend context_mgmt/decide.py)
  application/
    loop.py         LA boucle WorkPilot : assembler → appeler → exécuter → réinjecter → mesurer → décider
    assembler.py    construit la requête depuis le layout ; refuse un volatil avant un stable
    tool_output.py  plafonds, pagination, déversement en fichier, rtk
    subagents.py    contrat de conclusion, lancement échelonné
  ports.py        ModelPort, ToolPort, MemoryPort, LedgerPort
  adapters/       un par protocole : chat compatible OpenAI, Ollama, Copilot, Windsurf
```

- **Le port de modèle** porte les capacités du provider (forme du cache, compaction native,
  purge native, champs d'usage, palier de prix, raisonnement lié au préfixe). Le domaine décide
  sur ces capacités.
- **Les cinq boucles WorkPilot** deviennent des adaptateurs de `harness/application/loop.py` : le
  protocole (format des messages, appel HTTP, parsing) reste dans l'adaptateur, la boucle et ses
  décisions sont écrites une fois. `create_agent_client()` reste la seule fabrique.
- **Les boucles tierces** gardent la leur (D1). Le harness leur fournit ce que chacune expose :
  le prompt assemblé par le layout, les seuils et plafonds réglables, les outils MCP de WorkPilot
  paginés, la mesure par tour, l'arrêt au plafond de coût.
- **La sécurité ne bouge pas** : chaque outil d'une boucle WorkPilot passe par `ToolExecutor`
  (outils déclarés, `command_refusal`, `_resolve_within_project`) ; le harness n'ajoute aucun
  chemin d'exécution.

## Les invariants du harness

1. **Stable d'abord.** Un segment porte une classe de stabilité (statique, projet, tâche, session,
   tour) ; l'assembleur refuse un segment plus volatil placé avant un plus stable. Aucun
   horodatage, identifiant ou ensemble non trié dans le préfixe ; JSON sérialisé trié.
2. **Append-only.** Dans une session, on ajoute, on ne réécrit pas : une consigne qui change arrive
   comme un nouveau message, pas comme une édition du system. C'est utile partout où il y a un cache
   de préfixe : une édition le réécrit à partir du point modifié. C'est obligatoire là où le provider
   lie le raisonnement au préfixe qui l'a produit (aujourd'hui les modèles Claude 5.x, qui renvoient
   un 400 sur un historique édité) : le harness lit cette contrainte dans une capacité, il ne la
   suppose pas. Sur ces providers, la purge et la compaction passent par le serveur, ou par une
   compaction *simple* (un résumé, rien d'autre de rejoué) — exactement le *clear* + handoff de
   `context_mgmt`.
3. **Troncature à la source.** Un outil de WorkPilot ne rend jamais plus que son plafond ; au-delà,
   il rend un extrait, le total, et le moyen de lire la suite (curseur, `offset`).
4. **Trois conditions d'arrêt, toujours** : fin naturelle, plafond d'itérations, plafond de coût.
   Plus l'absence de progrès, que Copilot détecte déjà.
5. **Chaque appel mesuré, dans une seule unité.** Un appel se décrit partout par les mêmes cinq
   nombres : entrée non cachée, lue depuis le cache, écrite dans le cache, sortie, raisonnement.
   Un champ que le provider ne rapporte pas vaut « inconnu », jamais zéro.
6. **Une décision, une fonction pure.** Seuils et choix vivent dans `harness/domain/`, testés par
   table ; la boucle ne contient pas de `if` de politique, ni de `if provider ==`.
7. **Les règles du dépôt tiennent.** Une sortie d'outil, un fichier relu depuis la mémoire ou un
   handoff entre délimité comme une donnée (S2). Le journal de contexte passe par
   `core/log_redaction.py` et ne garde que des nombres et des empreintes, jamais un corps (S1).
   Aucun nouvel appel réseau hors `core/offline_policy.py` (S7).

## Les décisions à prendre

**D1 — Garder les boucles tierces, ou les remplacer par des adaptateurs natifs ?**

| | A. Elles restent (recommandé) | B. Adaptateurs natifs sur les API brutes |
|---|---|---|
| Contrôle du contexte | ce que chaque boucle expose : prompt, seuils de compaction, plafonds de sortie, MCP, hooks là où il y en a | total : points de coupure du cache, purge et compaction côté serveur là où l'API les offre, budget de tâche, effort par message |
| Coût de construction | faible : layout, plafonds, mesure | élevé : réécrire dans `ToolExecutor` ce que chaque CLI donne (édition à remplacement exact, recherche, sous-agents, permissions, sandbox) |
| Règles | inchangées | pour Claude, la règle critique 1 (« Claude Agent SDK uniquement ») et `rules/backend.md` sont à amender explicitement |

Recommandation : **A**, et ne rouvrir B, provider par provider, que si la mesure du lot 0 montre
qu'une boucle tierce est le goulot (taux de hit bas qu'on ne peut pas corriger, compaction qui
coûte des passes QA). Le harness est construit pour que B reste un adaptateur de plus.

**D2 — Seuil de compaction.** La note dit 70–80 % ; `context_mgmt` vise 50 % par défaut. Les deux
se défendent : 50 % prépare le handoff tôt et limite le context rot, 70–80 % rentabilise mieux la
fenêtre. On tranche sur l'éval du lot 0 (passes QA et coût par sous-tâche à 50, 70, 80 %), et le
seuil s'applique à la fenêtre effective : `min(fenêtre, palier de prix)`. D'après les grilles relevées
par l'Atelier IA (août 2026), Grok facture un prompt de plus de 200 k entier au tarif long, et
Gemini Pro facture plus cher au-delà de 200 k : la fenêtre payable y est 200 k, quelle que soit
la fenêtre annoncée.

**D3 — Durée de vie du cache, là où elle se règle.** La plupart des providers cachent un préfixe
sans réglage. Deux exceptions : Anthropic, où l'écriture coûte 1,25× pour 5 minutes et 2× pour
1 heure (WorkPilot pose `ENABLE_PROMPT_CACHING_1H=1` ; `CLAUDE_CODE_PROMPT_CACHE_TTL` prime sur
lui, `FORCE_PROMPT_CACHING_5M=1` force 5 minutes), et le cache explicite de Gemini, facturé au
stockage par heure. Une durée longue ne rapporte que si deux appels qui partagent un préfixe
démarrent à plus de 5 minutes d'écart (attente humaine, revue) ; entre deux tours d'une session,
chaque lecture rafraîchit le cache. Le lot 0 mesure ces écarts pour tous les providers ; le
réglage suit, là où il existe.

**D4 — Contexte de code : recherche agentique ou injection.** Recommandation : un outil
`search_code` que le modèle appelle (toujours à jour, il suit les vraies références), hybride
BM25 + fusion RRF, plafonné à 5–8 extraits par appel, servi en MCP pour qu'il atteigne aussi les
boucles tierces. Pas d'injection préalable « au cas où ».

## Les lots, par priorité

Chaque lot se termine sur un critère mesuré, pas sur une date, et vaut pour tous les providers :
un lot qui ne servirait qu'une famille dit pourquoi.

### Lot 0 — Mesurer

Sans mesure, chaque lot suivant est un pari.

- `harness/domain/usage.py` : un appel se décrit par cinq nombres — entrée non cachée, lue depuis
  le cache, écrite dans le cache, sortie, raisonnement — chacun « inconnu » quand le provider ne
  le rapporte pas. Une fonction pure par **format d'usage**, pas par provider :

  | Format | Qui l'émet | Lecture |
  |---|---|---|
  | non caché + lu + écrit séparés | Claude Agent SDK (`AssistantMessage.usage`) | tels quels |
  | total + part cachée | OpenAI et compatibles (`prompt_tokens`, `prompt_tokens_details.cached_tokens`), Codex (`input_tokens`, `cached_input_tokens`) | non caché = total − cachée |
  | hit + miss | DeepSeek (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`) | lu = hit, non caché = miss |
  | non caché + `cache.read` + `cache.write` | OpenCode (`step_finish`) | tels quels |
  | entrée + lu, inclusion ambiguë | Antigravity | tranché par `total_tokens`, comme `context_tokens_from_usage` |
  | total sans cache | Ollama, LM Studio (`prompt_eval_count`), Copilot, Windsurf (`prompt_tokens`) | cache « inconnu » |

- `harness/domain/ledger.py` : la session cumule ses appels, calcule le taux de hit sur les seuls
  appels qui rapportent le cache, et compte les **réécritures de préfixe** (un appel après le
  premier dont l'écriture dépasse la moitié du prompt) — un signal qui ne demande pas de voir la
  requête, donc valable pour les boucles tierces aussi.
- Chaque client garde son parsing et y ajoute un appel au format qui lui correspond ;
  `record_client_usage` écrit le résumé de session, avec un `input_tokens` qui a enfin le même
  sens partout (cache compris).
- Le taux de hit rejoint l'événement `CONTEXT_USAGE` ; la jauge du panneau de tâche l'affiche,
  clés i18n `en` et `fr`, et « non rapporté » pour un provider sans champ de cache.
- Ligne de base : une dizaine de tâches réelles rejouées, sur plusieurs providers, avec coût par
  sous-tâche terminée, passes QA, resets de contexte, taux de hit, réécritures de préfixe.

*Sortie :* les KPI ci-dessous sont lus pour chaque tâche, quel que soit son provider, et la ligne
de base est écrite. *Tests :* chaque format d'usage par table, dont les champs absents ; le ledger
ne contient jamais un corps de message.

### Lot 1 — Une seule boucle

Le harness proprement dit : `harness/application/loop.py` remplace les cinq copies.

- La boucle porte les quatre arrêts : fin naturelle, `max_turns`, **`max_cost_usd`**, absence de
  progrès. Le coût vient du ledger, donc du même calcul pour tous.
- Les boucles tierces reçoivent le même plafond de coût côté WorkPilot : au-delà, la session est
  arrêtée à son prochain point sûr, comme le fait déjà `ContextGuard`.
- Les adaptateurs gardent le protocole ; `ToolExecutor` reste le seul exécuteur.

*Sortie :* les cinq boucles passent par `loop.py` ; les tests existants des clients passent sans
modification de leurs attentes. *Tests :* chaque condition d'arrêt, avec un modèle factice.

### Lot 2 — Un préfixe stable

- `harness/domain/layout.py` : le system devient une suite de segments typés par stabilité.
  `build_base_system_prompt`, partagé par tous les providers, en est la première implémentation.
- Le chemin absolu du worktree passe **après** les parties statiques (règles, `ARTIFACT_RULES`,
  skill de documents, rtk), pour que ce préfixe se partage d'une tâche à l'autre.
- Un **bloc de tâche** stable (constitution spec-kit, préambule d'effort, mémoire du projet) se
  place juste après le system, avant la partie propre à la sous-tâche : chaque nouvelle session
  de sous-tâche le relit depuis le cache au lieu de le repayer.
- Les rosters de sous-agents vides par défaut pour les types à tâche unique (`commit_message`…) :
  une définition inutile est du contexte payé à chaque tour (« The Unwired Loop »).
- D3 tranché sur la mesure, là où un réglage existe.

*Sortie :* à partir du deuxième appel d'une session, sur chaque provider qui rapporte le cache, le
cache couvre au moins le préfixe, et aucun appel ne réécrit plus de la moitié du prompt hors
compaction. *Tests :* deux assemblages successifs d'une même session ont un préfixe identique
octet pour octet ; l'assembleur refuse un segment volatil placé avant un stable.

### Lot 3 — Troncature à la source

La voie WorkPilot vaut pour tous ; la voie native est un réglage en plus, jamais une condition.

- `read_file(path, offset, limit)` et `search(pattern, max_results, cursor)` dans `ToolExecutor` ;
  la réponse dit combien il y a en tout et comment lire la suite.
- **Déversement** : une sortie au-delà du plafond est écrite dans le dossier de la spec
  (`path_guard` s'applique), le modèle reçoit un extrait, le total et le chemin à relire par
  `offset` — ce que Claude Code fait déjà pour Bash, étendu à toutes les boucles WorkPilot.
- Plafonds par outil plutôt qu'un plafond global de 10 k caractères ; rtk garde son rôle sur Bash.
- Les serveurs MCP de WorkPilot (cerveau, `workpilot`) paginent : 200 lignes au plus, un curseur
  pour la suite. C'est la voie qui atteint aussi les boucles tierces.
- Voie native, par capacité déclarée : Claude Code expose ses plafonds (table plus haut), posés
  dans `sdk_env` comme l'auto-compaction aujourd'hui. Pour Codex, OpenCode et Antigravity, on
  documente leurs réglages avant d'en dépendre.

*Sortie :* la part des sorties d'outils dans le contexte baisse sur la ligne de base, sans hausse
des passes QA. *Tests :* un fichier de 50 000 lignes rend un extrait, le total et un curseur
valide ; un chemin hors racine reste refusé.

### Lot 4 — Clearing et compaction

- **Clearing par lots**, voie WorkPilot (`harness/domain/policies.py`) : un résultat d'outil plus
  vieux que N tours devient un marqueur qui garde l'appel et dit comment relancer. On ne purge
  qu'au-delà d'un gain minimal : chaque purge réécrit le cache à partir du point purgé, purger un
  peu à chaque tour coûte plus qu'il ne rapporte. Remplace le seuil fixe de 300 k caractères de
  `compact_messages`.
- Sur une boucle tierce, la purge et la compaction sont les siennes : le harness règle le seuil
  (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `model_auto_compact_token_limit`, déjà posés par
  `context_mgmt`) et mesure. Claude Code purge déjà les vieux résultats ; rien à ajouter là.
- **Fenêtre effective** dans `context_mgmt/windows.py` : `min(fenêtre, palier de prix)` ; D2
  appliqué.
- La compaction émulée (« résumé + 8 dernières entrées ») reste sur les providers qui ne lient
  pas le raisonnement au préfixe ; les autres n'utilisent que la compaction serveur ou le *clear*.
- Jamais de compaction au milieu d'un tour d'outils : la règle du point sûr de `ContextGuard`
  s'applique aussi au clearing.

*Sortie :* resets de contexte par sous-tâche et coût par sous-tâche en baisse sur la ligne de
base, passes QA stables. *Tests :* la politique de clearing par table (âge, gain minimal, jamais
les N derniers messages, jamais un appel d'outil en attente).

### Lot 5 — Sous-agents et mémoire externe

- **Contrat de conclusion** : un sous-agent rend `{conclusion, fichiers, preuves}` dans un plafond
  de tokens. Là où WorkPilot reçoit le résultat (Copilot, et toute boucle WorkPilot qui en
  gagnerait), le harness tronque et le signale au lieu de faire confiance à la consigne ; sur une
  boucle tierce, par son hook de fin d'outil s'il existe (Claude Code : PostToolUse), et le ledger
  mesure ce qui remonte.
- **Lancement échelonné** : un cache n'est lisible qu'une fois la première réponse commencée. On
  lance un sous-agent, on attend son premier token, puis les autres, pour qu'ils lisent le préfixe
  au lieu de l'écrire chacun (Copilot les lance aujourd'hui tous à la fois).
- **Routage aux frontières** : un modèle plus petit sert un sous-agent ou une nouvelle session,
  jamais un changement de modèle au milieu d'une session (le cache est lié au modèle, chez tous).
- **Mémoire** : un `MemoryPort` unique au-dessus du cerveau et des fichiers de la spec, relu à la
  demande par outil (MCP) plutôt qu'injecté.

*Sortie :* tokens remontés par sous-agent bornés ; écritures de cache par vague de sous-agents
divisées. *Tests :* une conclusion hors contrat est tronquée et marquée.

### Lot 6 — Outils dynamiques et effort

- Jeu d'outils figé **par session**, choisi par phase et par sous-tâche : changer d'outils en cours
  de session reconstruit tout le cache. Là où le provider sait différer les schémas (Claude Code),
  on le règle ; ailleurs, WorkPilot réduit le jeu d'outils de la phase.
- Effort par phase depuis le réglage de l'utilisateur, fixe dans une session : chez les providers
  qui le rendent dans le préfixe, le changer en cours de route invalide le cache.

*Sortie :* les définitions d'outils pèsent moins dans le préfixe des phases qui n'en ont pas besoin.

### Lot 7 — Contexte de code

- Outil `search_code` (D4), servi en MCP : BM25 sur des morceaux découpés par symbole (fonction,
  classe), chaque morceau préfixé de son chemin et de son symbole — la version gratuite du
  contextual retrieval. Fusion RRF avec la recherche exacte (identifiants) ; vecteurs denses
  seulement en option, et locaux sous `airgapStrict`.
- 5 à 8 extraits par appel, curseur pour la suite.
- **Le test qui tranche** : les tâches de l'éval à 5, 20 et 50 extraits, courbe des passes QA et
  du coût. On garde le budget où la qualité plafonne.

### Lot 8 — Évals en continu

- **En CI, sans LLM** : des transcriptions enregistrées rejouées dans l'assembleur. On vérifie la
  stabilité du préfixe, la composition et les budgets, de façon déterministe, à chaque PR.
- **À la demande, avec LLM** : 50 tâches réelles réparties sur plusieurs providers, coût mesuré et
  approuvé avant chaque campagne. Jamais d'égalité stricte sur une sortie de modèle : on juge le
  résultat (tests, QA), pas le texte.
- Une régression de taux de hit ou de coût par sous-tâche bloque comme une régression de test.

## Les indicateurs

Calculés à partir du ledger, donc identiques pour tous les providers ; un provider qui ne rapporte
pas le cache n'a pas de taux de hit, il n'a pas un taux nul.

| Indicateur | Calcul | Ce qu'on fait quand il dérive |
|---|---|---|
| Taux de hit du cache | lu ÷ (non caché + lu + écrit), sur les appels qui rapportent le cache | chercher l'invalidateur : différence entre deux requêtes successives |
| Réécritures de préfixe | appels, hors premier et hors compaction, où l'écriture dépasse la moitié du prompt | même diagnostic ; c'est la régression silencieuse la plus chère |
| Part des sorties d'outils | tokens de résultats d'outils ÷ tokens du contexte | lot 3, puis lot 4 |
| Coût par sous-tâche terminée | coût cumulé ÷ sous-tâches terminées | jamais par requête : une requête moins chère qui demande plus de tours ne l'est pas |
| Resets de contexte | resets par sous-tâche, et sous-tâches au cap | seuil (D2), fenêtre effective, troncature |
| Qualité | passes QA, sous-tâches qui échouent | garde-fou : aucun lot ne se paie en qualité |

Les cibles chiffrées se fixent sur la ligne de base du lot 0, pas avant.

## Ce qui casse, et comment on l'évite

- **Le préfixe qui bouge sans qu'on le voie** : un champ dynamique ajouté au system, une liste
  d'outils construite dans un ordre variable. Les requêtes réussissent, la facture monte. Le
  compteur de réécritures du lot 0 et le test du lot 2 existent pour ça.
- **Éditer l'historique** : réécrit le cache à partir du point modifié, et, chez les providers qui
  lient le raisonnement au préfixe, invalide les blocs de raisonnement qui suivent. On ajoute, on
  ne réécrit pas.
- **Purger trop souvent** : chaque purge réécrit le cache ; on purge par lots.
- **Lancer N sous-agents à la fois** sur le même préfixe : N écritures, aucune lecture.
- **Changer de modèle ou d'outils en cours de session** : tout le cache repart.
- **Une pause plus longue que la durée du cache** (approbation humaine) : le cache est perdu. D3
  en décide.
- **Une grande fenêtre comme excuse** : la qualité se dégrade bien avant la limite, surtout pour
  l'information enfouie au milieu. Cinq extraits pertinents valent mieux que deux cents.
- **Un chiffre qui n'a pas le même sens d'un provider à l'autre** : c'est le cas de `input_tokens`
  aujourd'hui. Toute comparaison passe par le format commun du lot 0.

## Hors périmètre

- Changer les modèles, les poids ou l'échantillonnage : rien de cela ne nous appartient.
- Remplacer les boucles tierces (D1-A) : elles gardent leur boucle ; le harness les règle et les
  mesure.
- Un index vectoriel du dépôt construit à l'avance : il dérive, coupe les fonctions et rate
  l'appelant d'une méthode. La recherche reste agentique (D4).
