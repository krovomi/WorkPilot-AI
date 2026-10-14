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
agent » de l'« Atelier IA », la revue « The Unwired Loop » de ce dépôt, et la documentation de
l'API Claude (cache, context editing, compaction) relue en octobre 2026.

Les cinq techniques de §03, et ce qu'elles deviennent ici :

| Technique | Déclencheur | Dans le harness |
|---|---|---|
| Troncature à la source | à l'écriture de l'outil | chaque outil pagine et plafonne lui-même (lot 3) ; la seule qui empêche le problème au lieu de le réparer |
| Tool clearing | résultat consommé | le corps d'un vieux `tool_result` devient un marqueur, par lots (lot 4) |
| Compaction | ~70–80 % du plafond | le `ContextGuard` existant, calé sur la fenêtre *effective* (lot 4) |
| Mémoire externe | dès qu'un résultat resservira | la sortie longue va dans un fichier, le modèle relit par offset (lots 3 et 5) |
| Sous-agents | sous-tâche exploratoire | contexte neuf, seule la conclusion remonte, sous contrat vérifié (lot 5) |

Et la règle d'ordre qui rend le cache possible : **system → définitions d'outils → règles projet →
documents de référence → historique → question**, du plus stable au plus volatil, le préfixe
identique octet pour octet.

## Ce qui existe (au commit `55ea383`)

WorkPilot a déjà une bonne part de la mécanique ; ce qui manque, c'est la mesure fine, une boucle
unique, et la troncature à la source.

| Sujet | Aujourd'hui | Ce qui manque |
|---|---|---|
| Propriété de la boucle | Claude : le SDK (`core/client.py`, `max_turns` 1000, `max_budget_usd` 5). Codex, OpenCode, Antigravity : leur CLI. OpenAI (+ Google, Mistral, DeepSeek, xAI), Ollama/LM Studio, Copilot, Windsurf : **cinq copies** de `for turn in range(self.max_turns)` dans `core/agent_clients/` | une boucle partagée ; aucune de ces cinq n'a de plafond de coût |
| Assemblage et cache | un seul builder, `build_base_system_prompt` (`core/llm_optimization.py`), sans horodatage ; outils dans un ordre fixe ; `ENABLE_PROMPT_CACHING_1H=1` ; `prompt_cache_key` OpenAI | le chemin absolu du worktree est la **deuxième phrase** du system : le préfixe change d'une tâche à l'autre. La constitution spec-kit est inlinée dans le prompt de *chaque* sous-tâche. Aucun `cache_control` |
| Mesure | tokens et cache **par session** (`agents/session.py` → `core/usage_tracker.py`) ; remplissage par tour pour la jauge (`claude_context_fill`, `context_mgmt/sdk_usage.py`) | ni taux de hit, ni coût **par appel** ; les boucles maison ne lisent pas `cached_tokens` ; le contexte envoyé n'est pas journalisé |
| Compaction | `context_mgmt/` : garde par tâche, seuil 50 % par défaut (30–90), *compact* ou *clear*, handoff préparé en fond, cap de 3 resets ; natif sur Claude et Codex, émulé ailleurs | un seuil calculé sur la fenêtre annoncée, pas sur la fenêtre *payable* (palier de prix à 200 k chez certains providers) |
| Tool clearing | boucles maison seulement : `compact_messages` remplace les vieux résultats par un marqueur, au-delà de 300 k caractères | rien sur le chemin Claude ; pas de règle d'âge (« plus vieux que N tours ») |
| Troncature | rtk sur Bash ; boucles maison : résultat coupé à 10 k caractères (70 % tête / 30 % queue), recherche à 200 correspondances | `read_file` lit le fichier entier puis en coupe le milieu, sans `offset`/`limit` ; aucun plafond posé sur le chemin Claude ; aucune pagination par curseur |
| Mémoire externe | cerveau (vault, `graph.json`, serveur MCP 9 outils), `implementation_plan.json`, `build-progress.txt`, `handoff_pending.md`, rapports de phase plafonnés | pas de déversement des sorties longues vers un fichier relisible |
| Sous-agents | registre `agents/subagents/`, roster ≤ 7, en majorité lecture seule sur Sonnet ; Claude et Copilot | « rends une synthèse structurée » n'est qu'une consigne : rien ne la vérifie ; Copilot les lance en parallèle (N écritures de cache) |
| Outils dynamiques | `AGENT_CONFIGS` par type d'agent ; MCP ajoutés selon la tâche ; `ENABLE_TOOL_SEARCH=auto:5` sur Claude | rien par phase dans une même tâche |
| Effort et routage | effort par phase (`phase_config.py`) ; routeur de complexité et `model_router` presque toujours éteints | pas d'escalade automatique ; l'effort Opus est figé par type d'agent |
| Récupération de code | `context/search.py` : correspondance de sous-chaînes ; grepai seulement pour l'autofix | ni BM25, ni fusion, ni budget d'extraits |
| Évals | `tests/skills_eval/` : 6 épisodes rejoués sans LLM en CI | aucun banc qui fasse tourner l'agent sur des tâches réelles |

## La cible : trois couches, une seule boucle

Le découpage est celui d'une clean architecture : les décisions sont des fonctions pures testées
par table (comme `context_mgmt/decide.py` aujourd'hui), la boucle les orchestre, les providers sont
des adaptateurs derrière un port.

```
apps/backend/harness/
  domain/         pur, sans I/O — testé par table
    layout.py       segments ordonnés par stabilité, points de coupure, empreinte du préfixe
    budget.py       fenêtre effective, composition du contexte, seuils
    policies.py     arrêt, clearing, choix compact/clear (reprend context_mgmt/decide.py)
    ledger.py       l'enregistrement d'un appel
  application/
    loop.py         LA boucle : assembler → appeler → exécuter → réinjecter → mesurer → décider
    assembler.py    construit la requête depuis le layout ; refuse un volatil avant un stable
    tool_output.py  plafonds, pagination, déversement en fichier, rtk
    subagents.py    contrat de conclusion, lancement échelonné
  ports.py        ModelPort, ToolPort, MemoryPort, LedgerPort
  adapters/       openai_compat, ollama, copilot, windsurf ; anthropic_messages si D1
```

- **Le port de modèle** déclare ce que le provider sait faire, depuis le bloc `context:` de
  `capabilities/providers.yaml` étendu : forme du cache (aucun, préfixe automatique, points de
  coupure explicites, cache facturé au stockage), compaction native, clearing côté serveur, champs
  d'usage du cache, palier de prix. Le domaine ne connaît que ces capacités, jamais un nom de provider.
- **Les cinq boucles de `core/agent_clients/`** deviennent des adaptateurs de `harness/loop.py` :
  le protocole (format des messages, appel HTTP, parsing) reste dans l'adaptateur, la boucle et
  ses décisions sont écrites une fois. `create_agent_client()` reste la seule fabrique.
- **Le chemin Claude Agent SDK** garde sa boucle (règle critique 1). Le harness lui fournit ce que
  le SDK expose : le system prompt assemblé par le layout, les plafonds de sortie, les outils MCP
  de WorkPilot paginés, la mesure par tour, le contrat des sous-agents.
- **La sécurité ne bouge pas** : chaque outil d'une boucle maison passe par `ToolExecutor`
  (outils déclarés, `command_refusal`, `_resolve_within_project`) ; le harness n'ajoute aucun
  chemin d'exécution.

## Les invariants du harness

1. **Stable d'abord.** Un segment porte une classe de stabilité (statique, projet, tâche, session,
   tour) ; l'assembleur refuse un segment plus volatil placé avant un plus stable. Aucun
   horodatage, identifiant ou ensemble non trié dans le préfixe ; JSON sérialisé trié.
2. **Append-only.** Dans une session, on ajoute, on ne réécrit pas : une consigne qui change arrive
   comme un nouveau message, pas comme une édition du system. Sur les modèles Claude actuels, un
   bloc de pensée est lié au préfixe exact qui l'a produit : supprimer côté client un vieux
   `tool_result`, réécrire le system ou compacter « en gardant la queue » renvoie un 400 sur les
   comptes créés après le 31 août 2026. Le clearing et la compaction passent donc par le serveur
   (adaptateur Anthropic) ou par une compaction *simple* (un résumé, rien d'autre de rejoué) —
   c'est exactement le *clear* + handoff de `context_mgmt`.
3. **Troncature à la source.** Un outil ne rend jamais plus que son plafond ; au-delà, il rend un
   extrait, le total, et le moyen de lire la suite (curseur, `offset`).
4. **Trois conditions d'arrêt, toujours** : fin naturelle, plafond d'itérations, plafond de coût.
   Plus l'absence de progrès, que Copilot détecte déjà.
5. **Chaque appel mesuré.** Pas de décision de contexte sans le chiffre qui la justifie.
6. **Une décision, une fonction pure.** Seuils et choix vivent dans `harness/domain/`, testés par
   table ; la boucle ne contient pas de `if` de politique.
7. **Les règles du dépôt tiennent.** Une sortie d'outil, un fichier relu depuis la mémoire ou un
   handoff entre délimité comme une donnée (S2). Le journal de contexte passe par
   `core/log_redaction.py` et ne garde par défaut que tailles et empreintes, jamais un corps (S1).
   Aucun nouvel appel réseau hors `core/offline_policy.py` (S7).

## Les décisions à prendre

**D1 — Qui fait tourner la boucle pour Claude ?**

| | A. Le SDK reste (recommandé) | B. Adaptateur natif sur l'API Messages |
|---|---|---|
| Contrôle du contexte | ce que le SDK expose : system, plafonds, MCP, seuil d'auto-compaction | total : `cache_control` explicite, context editing serveur (`clear_tool_uses_20250919`), compaction serveur, outil `memory_20250818`, tool search, `task_budget`, effort par message |
| Coût de construction | faible : on agit sur le layout, les plafonds et la mesure | élevé : réécrire dans `ToolExecutor` ce que Claude Code donne (Edit à remplacement exact, Grep, sous-agents natifs, permissions) |
| Règles | inchangées | la règle critique 1 (« Claude Agent SDK uniquement, jamais `anthropic.Anthropic()` ») et `rules/backend.md` sont à amender explicitement |

Recommandation : **A**, et ne rouvrir B que si la mesure du lot 0 montre que le chemin SDK est le
goulot (taux de hit bas qu'on ne peut pas corriger, compaction qui coûte des passes QA). Le
harness est construit pour que B reste un adaptateur de plus, pas une réécriture.

**D2 — Seuil de compaction.** La note dit 70–80 % ; `context_mgmt` vise 50 % par défaut. Les deux
se défendent : 50 % prépare le handoff tôt et limite le context rot, 70–80 % rentabilise mieux la
fenêtre. On tranche sur l'éval du lot 0 (passes QA et coût par sous-tâche à 50, 70, 80 %), et le
seuil s'applique à la fenêtre effective : `min(fenêtre, palier de prix)`. D'après les grilles relevées
par l'Atelier IA (août 2026), Grok facture un prompt de plus de 200 k entier au tarif long, et
Gemini Pro facture plus cher au-delà de 200 k : la fenêtre payable y est 200 k, quelle que soit
la fenêtre annoncée.

**D3 — TTL du cache.** `ENABLE_PROMPT_CACHING_1H=1` paie l'écriture 2× au lieu de 1,25×. Il ne
rapporte que si deux appels qui partagent un préfixe démarrent à plus de 5 minutes d'écart (attente
humaine, revue). Entre deux tours d'une même session, le TTL de 5 minutes se rafraîchit à chaque
lecture. Le lot 0 mesure la distribution de ces écarts ; on garde 1 h seulement si elle le justifie.

**D4 — Contexte de code : recherche agentique ou injection.** Recommandation : un outil
`search_code` que le modèle appelle (toujours à jour, il suit les vraies références), hybride
BM25 + fusion RRF, plafonné à 5–8 extraits par appel. Pas d'injection préalable « au cas où ».

## Les lots, par priorité

Chaque lot se termine sur un critère mesuré, pas sur une date.

### Lot 0 — Mesurer

Sans mesure, chaque lot suivant est un pari.

- `harness/domain/ledger.py` : un enregistrement par appel — provider, modèle, tour, tokens
  d'entrée non cachés, lus depuis le cache, écrits dans le cache, de sortie, coût, et la
  composition du contexte par catégorie (préfixe, règles, référence, historique, sorties d'outils,
  raisonnement, question).
- Lecture des champs de cache de chaque provider : Anthropic `cache_read_input_tokens` /
  `cache_creation_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`, DeepSeek
  `prompt_cache_hit_tokens`, Gemini `cachedContentTokenCount`. Sur le SDK, `AssistantMessage.usage`
  par tour, déjà lu pour la jauge par `claude_context_fill` : le ledger garde les trois champs
  séparés au lieu de leur somme.
- Une empreinte du préfixe par appel ; une alarme quand elle change dans une même session.
- Ligne de base : une dizaine de tâches réelles rejouées, avec coût par sous-tâche terminée,
  passes QA, resets de contexte, taux de hit, part des sorties d'outils.
- Un indicateur de plus dans la jauge du panneau de tâche (taux de hit), clés i18n `en` et `fr`.

*Sortie :* les KPI ci-dessous sont lus pour chaque tâche, et la ligne de base est écrite.
*Tests :* le calcul du taux de hit et de la composition, par table ; le ledger ne contient jamais
un corps de message (test avec une valeur factice en forme de clé).

### Lot 1 — Une seule boucle

Le harness proprement dit : `harness/application/loop.py` remplace les cinq copies.

- La boucle porte les quatre arrêts : fin naturelle, `max_turns`, **`max_cost_usd`** (aujourd'hui
  absent hors SDK ; le coût est déjà calculé par `_openai_cost_usd`), absence de progrès.
- Les adaptateurs gardent le protocole ; `ToolExecutor` reste le seul exécuteur.
- Le ledger du lot 0 est branché une fois, dans la boucle.

*Sortie :* les cinq boucles passent par `loop.py` ; les tests existants des clients passent sans
modification de leurs attentes. *Tests :* chaque condition d'arrêt, avec un modèle factice.

### Lot 2 — Un préfixe stable

- `harness/domain/layout.py` : le system devient une suite de segments typés par stabilité.
  `build_base_system_prompt` en est la première implémentation.
- Le chemin absolu du worktree passe **après** les parties statiques (règles, `ARTIFACT_RULES`,
  skill de documents, rtk), pour que ce préfixe se partage d'une tâche à l'autre.
- Un **bloc de tâche** stable (constitution spec-kit, préambule d'effort, mémoire du projet) se
  place juste après le system, avant la partie propre à la sous-tâche : chaque nouvelle session
  de sous-tâche le relit depuis le cache au lieu de le repayer.
- Les rosters de sous-agents vides par défaut pour les types à tâche unique (`commit_message`…) :
  une définition inutile est du contexte payé à chaque tour (« The Unwired Loop »).
- D3 tranché sur la mesure.

*Sortie :* sur les tâches de la ligne de base, à partir du deuxième appel d'une session, le cache
couvre au moins le préfixe entier, et aucun appel ne réécrit plus de la moitié du prompt hors
compaction. *Tests :* deux assemblages successifs d'une même session ont un préfixe identique
octet pour octet ; l'assembleur refuse un segment volatil placé avant un stable.

### Lot 3 — Troncature à la source

- `read_file(path, offset, limit)` et `search(pattern, max_results, cursor)` dans `ToolExecutor` ;
  la réponse dit combien il y a en tout et comment lire la suite.
- **Déversement** : une sortie au-delà du plafond est écrite dans le dossier de la spec
  (`path_guard` s'applique), le modèle reçoit un extrait, le total et le chemin à relire par
  `offset`. C'est la mémoire externe au plus près de la source.
- Plafonds par outil plutôt qu'un plafond global de 10 k caractères ; rtk garde son rôle sur Bash.
- Les outils MCP de WorkPilot (cerveau, `workpilot`) paginent : 200 lignes au plus, un curseur
  pour la suite.
- Sur le chemin Claude, les plafonds de sortie que le SDK accepte, posés dans `sdk_env` comme
  l'auto-compaction aujourd'hui.

*Sortie :* la part des sorties d'outils dans le contexte baisse sur la ligne de base, sans hausse
des passes QA. *Tests :* un fichier de 50 000 lignes rend un extrait, le total et un curseur
valide ; un chemin hors racine reste refusé.

### Lot 4 — Clearing et compaction

- **Clearing par lots** (`harness/domain/policies.py`) : un résultat d'outil plus vieux que N tours
  devient un marqueur qui garde l'appel et dit comment relancer. On ne purge qu'au-delà d'un gain
  minimal : chaque purge réécrit le cache à partir du point purgé, purger un peu à chaque tour
  coûte plus qu'il ne rapporte. Remplace le seuil fixe de 300 k caractères de `compact_messages`.
- **Fenêtre effective** dans `context_mgmt/windows.py` : `min(fenêtre, palier de prix)` ; D2
  appliqué.
- La compaction émulée (« résumé + 8 dernières entrées ») reste sur les providers sans pensée
  liée ; un adaptateur Anthropic (D1-B) n'utiliserait que la compaction serveur ou le *clear*.
- Jamais de compaction au milieu d'un tour d'outils : la règle du point sûr de `ContextGuard`
  s'applique aussi au clearing.

*Sortie :* resets de contexte par sous-tâche et coût par sous-tâche en baisse sur la ligne de
base, passes QA stables. *Tests :* la politique de clearing par table (âge, gain minimal, jamais
les N derniers messages, jamais un `tool_use` en attente).

### Lot 5 — Sous-agents et mémoire externe

- **Contrat de conclusion vérifié** : un sous-agent rend `{conclusion, fichiers, preuves}` dans
  un plafond de tokens ; au-delà, le harness tronque et le signale, au lieu de faire confiance à
  la consigne. Les fichiers lus par le sous-agent ne remontent jamais.
- **Lancement échelonné** : un cache n'est lisible qu'une fois la première réponse commencée. On
  lance un sous-agent, on attend son premier token, puis les autres, pour qu'ils lisent le préfixe
  au lieu de l'écrire chacun (Copilot les lance aujourd'hui tous à la fois).
- **Routage aux frontières** : un modèle plus petit sert un sous-agent ou une nouvelle session,
  jamais un changement de modèle au milieu d'une session (le cache est lié au modèle).
- **Mémoire** : un `MemoryPort` unique au-dessus du cerveau et des fichiers de la spec, relu à la
  demande par outil plutôt qu'injecté.

*Sortie :* tokens remontés par sous-agent bornés ; écritures de cache par vague de sous-agents
divisées. *Tests :* une conclusion hors contrat est tronquée et marquée.

### Lot 6 — Outils dynamiques et effort

- Jeu d'outils figé **par session**, choisi par phase et par sous-tâche : changer d'outils en cours
  de session reconstruit tout le cache. Au-delà de quelques MCP, la recherche d'outils charge les
  schémas à la demande, en ajoutant sans échanger.
- Effort par phase depuis le réglage de l'utilisateur, fixe dans une session ; un changement
  d'effort en cours de route passe par un message, pas par le paramètre de tête.

*Sortie :* les définitions d'outils pèsent moins dans le préfixe des phases qui n'en ont pas besoin.

### Lot 7 — Contexte de code

- Outil `search_code` (D4) : BM25 sur des morceaux découpés par symbole (fonction, classe), chaque
  morceau préfixé de son chemin et de son symbole — la version gratuite du contextual retrieval.
  Fusion RRF avec la recherche exacte (identifiants) ; vecteurs denses seulement en option, et
  locaux sous `airgapStrict`.
- 5 à 8 extraits par appel, curseur pour la suite.
- **Le test qui tranche** : les tâches de l'éval à 5, 20 et 50 extraits, courbe des passes QA et
  du coût. On garde le budget où la qualité plafonne.

### Lot 8 — Évals en continu

- **En CI, sans LLM** : des transcriptions enregistrées rejouées dans l'assembleur. On vérifie la
  stabilité du préfixe, la composition et les budgets, de façon déterministe, à chaque PR.
- **À la demande, avec LLM** : 50 tâches réelles, coût mesuré et approuvé avant chaque campagne.
  Jamais d'égalité stricte sur une sortie de modèle : on juge le résultat (tests, QA), pas le texte.
- Une régression de taux de hit ou de coût par sous-tâche bloque comme une régression de test.

## Les indicateurs

| Indicateur | Calcul | Ce qu'on fait quand il dérive |
|---|---|---|
| Taux de hit du cache | lu depuis le cache ÷ (non caché + lu + écrit) | chercher l'invalidateur : différence entre deux requêtes successives |
| Réécritures de préfixe | appels, hors compaction, où l'écriture dépasse la moitié du prompt | même diagnostic ; c'est la régression silencieuse la plus chère |
| Part des sorties d'outils | tokens de `tool_result` ÷ tokens du contexte | lot 3, puis lot 4 |
| Coût par sous-tâche terminée | coût cumulé ÷ sous-tâches terminées | jamais par requête : une requête moins chère qui demande plus de tours ne l'est pas |
| Resets de contexte | resets par sous-tâche, et sous-tâches au cap | seuil (D2), fenêtre effective, troncature |
| Qualité | passes QA, sous-tâches qui échouent | garde-fou : aucun lot ne se paie en qualité |

Les cibles chiffrées se fixent sur la ligne de base du lot 0, pas avant.

## Ce qui casse, et comment on l'évite

- **Le préfixe qui bouge sans qu'on le voie** : un champ dynamique ajouté au system, une liste
  d'outils construite dans un ordre variable. Les requêtes réussissent, la facture monte. L'alarme
  d'empreinte du lot 0 et le test du lot 2 existent pour ça.
- **Éditer l'historique** : invalide le cache à partir du point modifié et, sur les modèles Claude
  actuels, les blocs de pensée qui suivent. On ajoute, on ne réécrit pas.
- **Purger trop souvent** : chaque purge réécrit le cache ; on purge par lots.
- **Lancer N sous-agents à la fois** sur le même préfixe : N écritures, aucune lecture.
- **Changer de modèle ou d'outils en cours de session** : tout le cache repart.
- **Une pause plus longue que le TTL** (approbation humaine) : le cache est perdu. D3 en décide.
- **Une grande fenêtre comme excuse** : la qualité se dégrade bien avant la limite, surtout pour
  l'information enfouie au milieu. Cinq extraits pertinents valent mieux que deux cents.

## Hors périmètre

- Changer les modèles, les poids ou l'échantillonnage : rien de cela ne nous appartient.
- Remplacer les CLI de Codex, OpenCode et Antigravity : ils gardent leur boucle ; le harness
  mesure ce qu'ils rapportent.
- Un index vectoriel du dépôt construit à l'avance : il dérive, coupe les fonctions et rate
  l'appelant d'une méthode. La recherche reste agentique (D4).
