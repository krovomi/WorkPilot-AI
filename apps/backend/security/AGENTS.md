# AGENTS.md — index du paquet `security/`

Ce qui applique les règles de [`docs/rules/security.md`](../../../docs/rules/security.md) côté
backend, et ce qui n'applique rien. Les règles font foi ; ce fichier dit où regarder.

> Backend : [`../AGENTS.md`](../AGENTS.md) · Racine : [`../../../AGENTS.md`](../../../AGENTS.md)

## Les barrières actives

Posées par `create_client()` (`core/client.py`) comme hooks PreToolUse du SDK Claude ; les
providers hors SDK passent par `core/runtimes/tool_executor.py`, qui appelle les mêmes refus.

| Outil | Barrière | Où | Test |
|---|---|---|---|
| Bash | allowlist par projet + validateurs par commande | `hooks.py` (`bash_security_hook`) → `command_guard.py` (`validate_command_line`) → `validator_registry.py` | `tests/test_security_command_guard.py`, `tests/security/` |
| Bash | les étapes d'une procédure RUN jouées par Python (`workflows/execute.py`) passent par `hooks.command_refusal` avant toute exécution ; l'arrêt avant la phase irréversible est `workflows/runner.py` (`irreversible_gate`) | `hooks.py` → `command_guard.py` | `tests/test_workflows_run_execute.py` |
| Bash | profil de sécurité du projet (commandes de base + stack + scripts + perso) | `profile.py` (`get_security_profile`), `project/command_registry/` | `tests/test_security.py`, `tests/test_security_cache.py` |
| Bash | secrets dans un `git commit` émis par un agent | `git_validators.py` → `scan_secrets.py` | `tests/test_scan_secrets.py` |
| Bash | écriture de la configuration de sécurité (allowlist, profil, garde-fous, réglages SDK), quelle que soit la commande | `config_write_validators.py`, validateur de ligne (`LINE_VALIDATORS` de `validator_registry.py`) | `tests/security/test_config_write_validators.py` |
| Write / Edit | écritures confinées au projet, à la spec et à `<tmp>/workpilot` ; la configuration de sécurité refusée même dans le projet, et l'objectif de la tâche (`.workpilot-goal.json`) | `path_guard.py` (`make_write_path_hook`, `protected_config_refusal`) ; hors SDK `_resolve_within_project(..., for_write=True)` | `tests/test_security_path_guard.py` |
| write / edit (pi) | la même politique, jugée **dans le processus pi** : `core/agent_clients/pi_guard/workpilot-guard.js`, chargé par `--extension`, politique calculée depuis `path_guard` et passée par `WORKPILOT_PI_GUARD` ; le dossier de ressources de pi (.pi) et le garde-fou lui-même refusés en plus ; `bash` non jugé (comme OpenCode, Antigravity) | `tests/test_pi_cli_client.py`, fixtures réelles `tests/fixtures/pi/guard-*.jsonl` |
| Bash / Write | garde-fous déclarés par le projet (`.workpilot/guardrails.*`) | `guardrails.py` | — |
| Write / Edit | caractères invisibles retirés | `watermarks/` | `tests/test_watermarks_hook.py` |
| Read | fichiers retenus par la préparation des pièces jointes | `docintel/read_guard.py` | — |
| Bash (hors SDK), CLI OpenCode et pi | le processus tourne dans le bac à sable de l'OS : écritures dans le worktree, identifiants masqués, réseau par proxy filtrant ; Claude Code et Codex gardent le leur, rapporté | `os_sandbox/` (`session_sandbox`, `bwrap_argv`, `seatbelt_profile`, `FilteringProxy`), appelé par `core/client.py` (`_sandbox_at_launch`), `tool_executor._run_command`, `CliSubprocessAgentClient._launch` | `tests/os_sandbox/` |
| tous | outils non déclarés refusés | `agents/tools_pkg/permissions.py` (`undeclared_builtin_tools`) | `tests/test_agent_tool_declarations.py`, `tests/test_agent_tool_rights.py`, `tests/test_non_sdk_rights.py` |
| commande de l'objectif | environnement du backend sans ses identifiants, pour une commande qui exécute le code de la tâche | `child_env.py` (`env_without_credentials`), appelé par `goal/check.py` | `tests/goal/test_goal_protection.py`, `tests/goal/test_goal_check.py` |

## Contenu externe

| Quoi | Où |
|---|---|
| nettoyage + scan d'injection + journal | `untrusted.py` (`clean_untrusted`, `quote_untrusted`, `record_untrusted`) ; `_FORGE_PATTERNS` : ce qu'un texte de forge demande à l'agent (script distant, secret, push sans revue, garde-fou, contrôle coupé), noté `suspect` ici seulement |
| scanner d'injection | `injection_guard/` (`get_default_scanner`) ; `WORKPILOT_INJECTION_GUARD=block` durcit `quote_untrusted` |
| nettoyage brut | `content_sanitizer.py` (utilisé par `untrusted.py`) |
| appliqué aujourd'hui à | GitHub (`runners/github/context_gatherer.py`, `runners/github/batch_issues.py`) ; les corps de skills à l'émission (`skills_registry/injection_gate.py`, gate 4 du resolver) ; GitLab et Azure DevOps ont encore leur propre assainisseur |
| refus plutôt que nettoyage, pour un corps de skill | `skills_registry/injection_gate.py` (liste fermée de verdicts ; `WORKPILOT_INJECTION_GUARD=report` rétrograde en avertissement) |

Tests : `tests/test_security_untrusted.py`, `tests/injection_guard/test_middleware.py`,
`tests/injection_guard/test_corpus.py` (51 charges de `corpus.yaml` : neutralisée ou signalée, jamais hors du cadre ; 10 rapports ordinaires jamais bloqués),
`tests/backend/security_suite/`, `tests/test_skills_registry_injection_gate.py`.

## Hors de ce paquet

| Sujet | Où | Test |
|---|---|---|
| Autorisation du mode serveur | `server/authz/` (`require_permission`, `mount_guarded`, `scope.py`), `server/integration.py` | `tests/backend/test_feature_router_authz.py`, `tests/backend/test_project_scope_coverage.py` |
| Authentification du mode serveur | `server/auth/` (JWT, argon2id, OIDC), `server/ratelimit.py` | `tests/backend/test_auth_session_lifecycle.py` |
| Chemins côté API | `foundation/api_safety.py` (`validated_dir`) | `tests/test_api_safety.py` |
| Redaction des logs | `foundation/log_redaction.py` (installé par `run.py`, chaque runner, l'API) | `tests/core/test_log_redaction.py`, `tests/test_entrypoints_redaction.py` |
| Hors-ligne strict | `offline_policy/` | `tests/test_offline_mode.py` |
| Secrets des pièces jointes | `docintel/redact.py` | `tests/backend/security_suite/test_secret_scanning.py` |
| Secrets d'un commit sur ce dépôt | `.husky/pre-commit` → `scan_secrets.py --staged-only` (lit l'index) | `tests/test_scan_secrets.py` |
| Sandbox Codex | `core/codex_cli_client.py` (`codex_sandbox_for`) | `tests/test_non_sdk_rights.py` |

## Ce qui ne protège rien aujourd'hui

À ne pas citer comme une barrière : ces modules existent mais ne sont branchés sur aucun chemin
d'exécution d'agent.

- `sandbox.py`, `anomaly_detector.py` : n'alimentent qu'un endpoint de statut.
- `git_hooks.py`, `auto_integration.py` : `initialize_security` n'a aucun appelant, et le dépôt
  utilise `.husky/` (`core.hooksPath`), que `git_hooks.py install` ne touche pas.
- `audit_trail.py`, `main.py` : sans importeur ; l'audit vivant est le paquet `audit_trail/`.
- `secure_subprocess.py` : un seul appelant ; la plupart des sous-processus appellent
  `subprocess` directement (voir la règle S4).
- `tool_input_validator.py` : extrait l'entrée d'un outil pour l'affichage, ne refuse rien.

Brancher l'un d'eux, c'est une PR avec un test qui prouve le refus.

## Outils manuels

```bash
# depuis la racine : c'est là que vit .secretsignore
python apps/backend/security/scan_secrets.py --staged-only   # ou --all-files, --path <dir>, --json
cd apps/backend && python -m security.security_orchestrator  # scan complet (Bandit, secrets, rapports)
```
