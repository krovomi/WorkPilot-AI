---
feature: Coût d'une tâche triviale
summary: >-
  Une session Claude ne reçoit que les outils natifs que son type déclare ; un résumé de phase plus
  court que sa cible n'ouvre pas de session ; une courte question est simple sans évaluateur ; la
  validation écrit sans modèle ce qui ne demande pas de décision ; le spec suit le moteur changé sur
  la carte pendant qu'il tourne.
---

# Coût d'une tâche triviale

Le 2026-11-28, la carte « Juste dis-moi si tu vois ce ticket ? » a coûté 1,36 M tokens
(1,13 M de lectures de cache) et 0,72 € pour ne rien changer. Ses transcripts disent où :

| Poste | Tokens | Cause |
|---|---:|---|
| Préfixe fixe relu à chacun des 27 appels | ~580 k | ~20 k tokens de schémas d'outils natifs que la tâche n'utilise jamais (DesignSync, Agent, Monitor, SendMessage, Workflow, Cron, worktrees…) |
| Correcteur de validation, 9 tours | 490 k | le quick spec n'écrivait ni `context.json`, ni les sections que le validateur exige, ni `feature` dans le plan ; deux tours perdus sur `python3` et `node`, refusés par l'allowlist |
| Évaluateur de complexité | 171 k | l'heuristique, en anglais seulement, laissait une question française à 0,75 (< 0,8) |
| Trois résumés de phase | 95 k | une session complète pour résumer 150 à 1 200 caractères |
| Tout le spec sur Sonnet 5 | 96 % du coût | le moteur passé à Haiku 5.5 sur la carte 26 s après le lancement n'atteignait pas le spec |

## Ce qui change

**Outils natifs.** `agents/tools_pkg/builtin_base.py` traduit la déclaration du type
(`AGENT_CONFIGS[...]["tools"]`) en option `tools` du SDK (`--tools` du CLI), posée par
`create_client` et `create_simple_client`. Elle s'ajoute à `disallowed_tools`, qui reste le droit :
`tools` dit ce qui existe, `disallowed_tools` gagne toujours. Le type garde `ToolSearch` (le CLI
peut encore différer les outils MCP), `Agent` s'il a des sous-agents, `Skill` s'il lit les réglages
de la personne (le codeur), `REPL` en mode code. Les autres providers fonctionnaient déjà ainsi
(`ToolExecutor` n'offre que les outils déclarés). Mesuré contre une API simulée, taille de la
première requête : résumé 51,9 k → 5,6 k caractères, rédacteur de spec 60,0 k → 28,7 k, relecteur
QA 61,8 k → 30,4 k, codeur 79,0 k → 55,9 k. `WORKPILOT_CLI_TOOL_BASE=0` rend le jeu complet.

**Résumés de phase.** `spec/compaction.py` rend tel quel un résultat plus court que le résumé
demandé (`verbatim_max_chars`, 6 caractères par mot cible) : aucune session.

**Complexité.** `spec/complexity.py` lit une carte d'une courte question (160 caractères au plus,
terminée par `?`, `？` ou `؟`) comme SIMPLE à 0,85, sauf intégration, infrastructure ou mot
complexe : indépendant de la langue, là où les listes de mots sont en anglais.

**Validation.** `phase_validation` écrit d'abord ce que le validateur demande et qui ne porte
aucune décision : `context.json` minimal (celui de la phase contexte) et `feature` /
`workflow_type` du plan (`auto_fix_plan`). Le gabarit de `prompts/spec_quick.md` porte les quatre
sections exigées et `feature` ; `prompts/validation_fixer.md` ne montre plus de script
`python3 -c` ni de heredoc, refusés ou cassés sous Windows.

**Moteur du spec.** `spec/pipeline/live_engine.py` relit `task_metadata.json` avant chaque phase
(ligne `spec` d'une tâche verrouillée, `planning` d'abord pour une ancienne, comme
`spec-launch-config.ts`) et l'orchestrateur prend le modèle et l'effort qui ont changé. Un
changement de provider n'est pas appliqué en cours de spec : il demande d'autres identifiants.
Côté Electron, `hot-swap-marker.ts` fusionne une demande de bascule avec celle encore en attente
pour la même phase : « modèle » puis « effort » à deux secondes d'écart ne perdent plus le modèle.

## Ce qui reste

- La phase `reproduce` d'une carte `bug_fix` tourne même pour une question : le type est le choix
  de la personne, et le workflow la déclare `always`.
- Le relevé de coûts ignore les appels de compaction du CLI et deux petits appels Haiku : le bilan
  sous-compte d'environ 20 %.
- Une session qui reprend le journal d'une autre phase (« replayed after provider switch ») ajoute
  quelques milliers de tokens.
