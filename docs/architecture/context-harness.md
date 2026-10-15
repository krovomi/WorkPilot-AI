# Harness de contexte : le plan

> **Statut : plan ; livrés : le lot 0 (mesurer, sauf sa ligne de base), le lot 1a (un budget
> par session pour tous), le lot 2 (un préfixe stable, sauf D3) et le lot 3a (lire et chercher
> par pages).** Ce fichier fixe la cible
> et l'ordre des lots ; chaque lot livré remplace sa section par la justification de ce qui existe. [`docs/CLAUDE.md`](../CLAUDE.md)
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
| Propriété de la boucle | boucles tierces : Claude Agent SDK (`max_turns` 1000), Codex, OpenCode, Antigravity. Boucles WorkPilot : **cinq copies** de `for turn in range(self.max_turns)` dans `core/agent_clients/` (OpenAI et ses dérivés, Ollama/LM Studio, Copilot, Windsurf ×2). Lot 1a : un même plafond de coût par session pour tous | une boucle partagée (lot 1b) |
| Assemblage | un seul builder, `build_base_system_prompt` (`core/llm_optimization.py`), sans horodatage ; outils dans un ordre fixe ; `prompt_cache_key` côté OpenAI. Lot 2 : segments ordonnés par stabilité (`harness/domain/layout.py`), chemin du worktree en dernier, bloc de tâche en tête de chaque sous-tâche | des points de coupure de cache à la frontière tâche / sous-tâche chez Anthropic, que la CLI ne laisse pas poser |
| Mesure | lot 0 livré : chaque client lit l'usage de chaque appel dans l'unité commune de `harness/domain/` et le cumule dans son `usage_ledger` ; `record_client_usage` en tire les champs du suivi des coûts, `CONTEXT_USAGE` le taux de hit et les réécritures de préfixe | la ligne de base sur des tâches réelles ; le coût par appel (seul le coût de session est connu) |
| Compaction | `context_mgmt/` : garde par tâche, seuil 50 % par défaut (30–90), *compact* ou *clear*, handoff préparé en fond par le provider de la tâche, cap de 3 resets ; native sur Claude et Codex, émulée ailleurs | un seuil calculé sur la fenêtre annoncée, pas sur la fenêtre *payable* (palier de prix à 200 k chez certains providers) |
| Tool clearing | boucles WorkPilot : `compact_messages` remplace les vieux résultats par un marqueur au-delà de 300 k caractères. Claude Code purge de son côté | pas de règle d'âge (« plus vieux que N tours »), pas de gain minimal |
| Troncature | rtk sur Bash ; boucles WorkPilot : résultat coupé à 10 k caractères (70 % tête / 30 % queue). Lot 3a : `read_file`, `search_files` et `find_files` paginent sous ce plafond. Claude Code plafonne nativement (table ci-dessus) | `run_command` coupe encore le milieu d'une longue sortie ; les serveurs MCP de WorkPilot ne paginent pas ; aucun plafond natif réglé par WorkPilot |
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

### Lot 0 — Mesurer (livré, sauf la ligne de base)

Sans mesure, chaque lot suivant est un pari. Ce qui existe :

- **Un appel, cinq nombres** (`harness/domain/usage.py`) : prompt (cache compris), lu depuis le
  cache, écrit dans le cache, sortie, raisonnement. Un champ que le provider ne rapporte pas vaut
  `None`, jamais 0. Une fonction pure par **format d'usage**, pas par provider :

  | Lecteur | Format | Qui l'émet |
  |---|---|---|
  | `from_split_cache` | non caché + lu + écrit séparés | Claude Agent SDK (`AssistantMessage.usage`) |
  | `from_chat_completion` | total + part cachée (`prompt_tokens_details.cached_tokens`), ou hit + miss (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`) | OpenAI et les compatibles (Google, Mistral, DeepSeek, xAI), Copilot, Windsurf REST, LM Studio |
  | `from_flat_cached_input` | `input_tokens` qui inclut `cached_input_tokens` | Codex CLI (`turn.completed`) |
  | `from_step_tokens` | `input` non caché, `cache.read`, `cache.write` | OpenCode (`step_finish`) |
  | `from_ambiguous_cache_read` | inclusion non documentée, tranchée par `total_tokens` | Antigravity (par étape) ; `context_tokens_from_usage` s'en sert aussi |
  | `from_eval_counts` | `prompt_eval_count`, `eval_count`, rien sur un cache | Ollama |

- **La session** (`harness/domain/ledger.py`, `UsageLedger`) : cumule les appels par fil (le fil
  principal, ou un sous-agent : chacun a son propre préfixe), calcule le taux de hit sur les seuls
  appels qui rapportent un cache, et compte les **réécritures de préfixe** : un appel qui relit
  moins de la moitié du prompt de l'appel précédent du même fil (au-delà de 1 024 tokens, sous
  lesquels aucun provider ne cache). Le préfixe a changé, ou le cache a expiré : dans les deux
  cas l'appel a payé ce qu'il aurait dû relire. Le signal ne demande pas de voir la requête, il
  vaut donc pour les boucles tierces.
- **Chaque client** garde son parsing et enregistre chaque appel au format qui lui correspond
  (`AgentClient._record_call`) ; le ledger repart à chaque réponse. Le client Claude compte un
  appel une fois, alors que la CLI envoie un `AssistantMessage` par bloc de contenu
  (`message_id`). `SdkUsageProbe` fait de même pour la création de spec, qui lit le flux brut.
- **Le suivi des coûts** : `session_usage_fields` (`agents/session.py`) prend le côté entrée dans
  le ledger, donc dans le sens que `core/usage_tracker.py` attend pour tous (`input_tokens` = part
  non cachée), et la sortie dans `last_usage`, dont le sens est le même partout et dont le total
  de session est le plus complet. Ce qui corrige deux erreurs : OpenCode comptait son cache deux
  fois, et le `cached_input_tokens` de Codex ne parvenait pas au suivi.
- **La jauge** : `CONTEXT_USAGE` porte `cacheHitRatio` et `prefixRewrites` ; le popover de la
  jauge les affiche (clés `tasks:contextManagement.gauge.cache*`, `en` et `fr`), et « non
  rapporté » pour un provider sans champ de cache.

Tests : `tests/harness/` (chaque format par table, champs absents compris ; le ledger ; chaque
client ; le suivi des coûts ; l'événement), les tests des clients CLI, et `ContextGauge.test.tsx`.

**Reste à faire** : la ligne de base. Une dizaine de tâches réelles, sur plusieurs providers,
avec coût par sous-tâche terminée, passes QA, resets de contexte, taux de hit, réécritures de
préfixe. Elle demande de vrais appels, donc un budget approuvé ; les cibles des lots suivants en
dépendent.

### Lot 1 — Une seule boucle

Le harness proprement dit. Découpé en deux : l'arrêt au plafond de coût, qui manquait à tous les
providers sauf Claude, d'abord ; le remplacement des cinq boucles ensuite.

**Lot 1a — Un budget par session, pour tous (livré).**

- `harness/domain/cost.py` : `TokenPrices` (USD par million de tokens, par nature de token),
  `call_cost` (le coût d'un appel du ledger), `over_budget` (la règle d'arrêt). Un fournisseur qui
  ne rapporte pas son cache est compté au tarif d'entrée plein sur tout le prompt : l'estimation
  se trompe vers le haut, jamais vers le bas. Une dépense inconnue n'arrête jamais une session.
- `harness/application/budget.py` : le plafond est `AUTO_CLAUDE_MAX_BUDGET_USD` (5 USD par défaut,
  0 ou moins le supprime, une valeur illisible retombe sur le défaut), la variable que le SDK
  Claude lisait déjà ; `create_client` la lit par la même fonction. Les prix viennent de
  `cost_intelligence/catalog.py`, une donnée par modèle ; un modèle `vendeur/modèle` (OpenCode)
  est cherché chez son vendeur.
- Le contrôle a lieu à un seul endroit, `_run_agent_client_session`, après chaque message, pour
  tout client qui ne plafonne pas lui-même (`enforces_own_budget`, vrai pour le seul client
  Claude, dont le SDK s'arrête à `max_budget_usd`). Au-delà, la session s'arrête comme le SDK
  l'arrête : statut `continue`, marqueur de session `error_max_budget_usd` pour que le Kanban
  propose de reprendre, et `{"budget_exceeded": True, "spent_usd": …}` pour l'appelant.
- Un modèle sans prix connu ne peut pas être mesuré : sa session n'est pas plafonnée, et le
  journal le dit une fois par provider et modèle. Le catalogue est donc la limite de ce lot : un
  modèle récent qui n'y figure pas n'a pas de plafond tant qu'on ne l'y ajoute pas.
- Le contrôle voit l'usage quand le client le rapporte : une CLI qui ne le donne qu'en fin de
  tour (Codex) n'est arrêtée qu'après ce tour.

Tests : `tests/harness/test_cost.py`, `tests/harness/test_session_budget.py` (la session s'arrête
à l'appel qui dépasse, va au bout sous le plafond, et un modèle sans prix tourne sans plafond).

**Lot 1b — Une seule boucle (reste à faire, après le lot 3).** `harness/application/loop.py`
remplace les cinq copies. C'est un remaniement : il n'économise aucun token, alors que les lots 2
et 3 en économisent. Il passe donc après eux.

- La boucle porte les arrêts restants : fin naturelle, `max_turns`, absence de progrès (que
  Copilot détecte seul aujourd'hui) ; le budget est déjà commun (1a).
- Les adaptateurs gardent le protocole ; `ToolExecutor` reste le seul exécuteur.

*Sortie :* les cinq boucles passent par `loop.py` ; les tests existants des clients passent sans
modification de leurs attentes. *Tests :* chaque condition d'arrêt, avec un modèle factice.

### Lot 2 — Un préfixe stable (livré, sauf D3)

Chaque provider qui cache un prompt cache un préfixe : un octet qui change tôt fait repayer tout
ce qui le suit. Deux choses changeaient trop tôt : le chemin absolu du worktree était la deuxième
phrase du system partagé, et les sections communes à toutes les sous-tâches d'une tâche venaient
après le texte propre à la sous-tâche.

- `harness/domain/layout.py` (pur) : un `Segment` porte un nom, un texte et une `Stability` —
  qui le partage : statique (toutes les tâches de l'installation, sur un provider donné), projet,
  tâche, session, tour. `assemble` joint les segments tels quels et refuse (`LayoutError`) un
  segment placé après un plus volatil que lui ; un segment vide ne tient aucune place.
  `shared_prefix` rend ce que partagent les détenteurs d'une classe.
- **Le system partagé** (`build_base_system_prompt`, tous les providers) est assemblé par
  `system_prompt_segments` : rôle et règles (`ARTIFACT_RULES` compris), rappel d'outils du
  provider, rtk, cerveau (statiques), skill de documents (projet), puis le chemin du worktree
  (tâche), en dernier. La règle d'accès disait « this directory » derrière le chemin ; elle dit
  désormais « your working directory, given at the end of this prompt ». L'addendum de domaine de
  la spec (`_inject_domain_addendum`) reste ajouté après lui : il est de la classe tâche.
- **Le bloc de tâche** (`_coding_task_segments`, `agents/coder.py`) ouvre le prompt de chaque
  sous-tâche : constitution spec-kit et règles de plateforme mobile (projet), préambule d'effort,
  ADR et pièces jointes, rapports des phases précédentes (tâche). Le texte de la sous-tâche vient
  ensuite, et son en-tête d'environnement, stable sur la tâche, le prolonge. Avant, seul le
  préambule d'effort précédait la sous-tâche ; le reste la suivait.
- **Rosters** : déjà en place. `agents/subagents/phases.py` donne le roster vide `solo` à chaque
  type à tâche unique (`commit_message`, `merge_resolver`…), et
  `tests/test_subagents_coverage.py` vérifie que seul `coder` retombe sur le roster par défaut.

Ce que l'ordre rapporte dépend de la forme du cache, que le harness lit et ne suppose pas :

| Cache | Providers | Gain |
|---|---|---|
| préfixe de tokens, automatique | OpenAI et les compatibles, DeepSeek, Gemini implicite ; Codex CLI, Antigravity et OpenCode, qui envoient notre system en tête de leur message | deux sous-tâches d'une tâche partagent system, outils, bloc de tâche et en-tête d'environnement ; deux tâches partagent le system jusqu'au chemin, pourvu qu'elles atteignent le même cache (OpenAI route par `prompt_cache_key`, posé par tâche et par phase, et une CLI peut placer son propre dossier de travail avant notre texte) |
| par blocs, jusqu'à un point de coupure | Anthropic (Claude Agent SDK) | rien de mesurable : le system et le premier message sont chacun un seul bloc, et une correspondance partielle à l'intérieur d'un bloc n'existe pas. Il faudrait un point de coupure à la frontière tâche / sous-tâche, que la CLI ne laisse pas poser. L'ordre n'y coûte rien |
| local ou non rapporté | Ollama, LM Studio, Copilot, Windsurf | un serveur local qui garde le KV d'un préfixe commun traite le prompt plus vite ; rien n'est facturé ni mesuré |

**Reste à faire** : D3, qui se tranche sur les écarts entre appels mesurés par la ligne de base
du lot 0. Et le critère de sortie, mesuré sur cette même ligne de base : à partir du deuxième
appel d'une session, sur chaque provider qui rapporte le cache, le cache couvre au moins le
préfixe, et le ledger ne compte aucune réécriture de préfixe hors compaction.

Tests : `tests/harness/test_layout.py` (ordre accepté ou refusé, segments vides, préfixe partagé
par classe), `tests/harness/test_stable_prefix.py` (deux worktrees envoient le même system
jusqu'à leur chemin, avec ou sans rappel d'outils ; le chemin est le seul segment de tâche et le
dernier ; deux sous-tâches partagent le bloc de tâche octet pour octet).

### Lot 3 — Troncature à la source

La voie WorkPilot vaut pour tous ; la voie native est un réglage en plus, jamais une condition.

**Lot 3a — Lire et chercher par pages (livré).** Les boucles WorkPilot (OpenAI et les compatibles,
Ollama/LM Studio, Copilot, Windsurf) lisent et cherchent par `ToolExecutor`, et coupaient ensuite un
long résultat en une tête et une queue : le milieu d'un long fichier était illisible, et le modèle ne
pouvait pas le demander.

- `harness/domain/paging.py` (pur) : `page_lines` rend une suite de lignes sous un plafond de
  caractères, `render_page` la fait suivre de sa plage et de l'`offset` qui lit la suite, `page_items`
  pagine une liste produite à la demande (une recherche s'arrête de parcourir les fichiers dès que la
  page est pleine).
- `read_file(path, offset, limit)` : un fichier qui tient sous le plafond revient entier, exactement
  comme avant ; un plus long revient page par page, chaque ligne atteignable.
  `search_files(…, offset)` et `find_files(…, offset)` paginent leurs résultats de la même façon. Les
  schémas offerts au modèle décrivent ces paramètres ; `offset` et `limit` reçus en chaîne sont lus.
- Le plafond est celui du client (`ToolExecutor.result_max_chars`) : le partagé
  (`LLM_TOOL_RESULT_MAX_CHARS`, 10 000 caractères), celui de la fenêtre d'Ollama
  (`_local_tool_result_cap`), 8 000 en mode texte Windsurf. Une page tient dessous, la coupe d'après
  ne la touche plus.

Tests : `tests/harness/test_paging.py`, `tests/core/runtimes/test_tool_executor_paging.py` (un fichier
de 3 000 lignes lu en entier page par page, recherche paginée sans doublon, chemin hors racine refusé).

**Reste à faire (lot 3b).**

- **Déversement** de `run_command` : une sortie au-delà du plafond est écrite dans le dossier de la
  spec (`path_guard` s'applique), le modèle reçoit un extrait, le total et le chemin à relire par
  `read_file` et `offset` — ce que Claude Code fait déjà pour Bash.
- Les serveurs MCP de WorkPilot (cerveau, `workpilot`) paginent : c'est la voie qui atteint aussi
  les boucles tierces.
- Voie native, par capacité déclarée : Claude Code expose ses plafonds (table plus haut), posés
  dans `sdk_env` comme l'auto-compaction aujourd'hui. Pour Codex, OpenCode et Antigravity, on
  documente leurs réglages avant d'en dépendre.

*Sortie :* la part des sorties d'outils dans le contexte baisse sur la ligne de base, sans hausse
des passes QA.

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
| Réécritures de préfixe | appels qui relisent moins de la moitié du prompt de l'appel précédent du même fil, hors compaction | même diagnostic ; c'est la régression silencieuse la plus chère |
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
