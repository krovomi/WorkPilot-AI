# Annexe A — Inventaire des fichiers candidats

## A.1 Frontend (F28 ; F25 ; F21) — à confirmer par `knip` avant suppression

| Fichier (`apps/frontend/src/…`) | Lignes | Preuve | Action |
|---|---:|---|---|
| ~~`renderer/components/UsageIndicatorAgnostic.tsx`~~ | 558 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/UsageIndicatorDumb.tsx`~~ | 550 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/UsageIndicatorSimple.tsx`~~ | 482 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/settings/ImprovedProviderSection.tsx`~~ | 261 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/settings/SophisticatedProviderSection.tsx`~~ | 326 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/settings/ThemedProviderSection.tsx`~~ | 401 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/settings/multiconnector/*` (5 fichiers)~~ | 759 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/settings/AccountSettings.tsx`~~ | 2 227 | test seul | **supprimé (L8)** |
| ~~`renderer/components/settings/ProfileList.tsx`~~ | 349 | test seul | **supprimé (L8)** |
| ~~`renderer/components/settings/LlmRouterSettings.tsx`~~ | 380 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/settings/CopilotAuthTerminal.tsx`~~ | 358 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/hooks/HooksDialog.tsx`~~ | 1 189 | aucun importeur | **supprimé (L8)** |
| `renderer/components/SDKRateLimitModal.tsx` | 596 | commentaire seul | **conservé (L8)** : feature cassée, pas morte — décision du mainteneur |
| `renderer/components/RateLimitModal.tsx` | 474 | commentaire seul | **conservé (L8)** : feature cassée, pas morte — décision du mainteneur |
| ~~`renderer/components/AppUpdateNotification.tsx`~~ | 365 | aucun importeur | **supprimé (L8)** |
| `renderer/components/StreamingTest.tsx` | 256 | test manuel | **déjà absent** à l'ouverture du lot L8 |
| ~~`renderer/components/ReferencedFilesSection.tsx`~~ | 190 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/AgentProfiles.tsx`~~ | 149 | aucun importeur | **supprimé (L8)** |
| `renderer/components/AuthFailureModal.tsx` | 136 | commentaire seul | **conservé (L8)** : feature cassée, pas morte — décision du mainteneur |
| ~~`renderer/components/ProfileBadge.tsx`~~ | 150 | test seul | **supprimé (L8)** |
| ~~`renderer/components/ProjectInitModal.tsx`~~ | 117 | test seul | **supprimé (L8)** |
| ~~`renderer/components/ProactiveSwapListener.tsx`~~ | 96 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/FolderExplorer.tsx`~~ | 56 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/auth/Can.tsx`~~ | 30 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/auto-refactor/AutoRefactorDialog.tsx`~~ | 523 | commentaire du store seul | **supprimé (L8)** |
| ~~`renderer/components/azure-devops-import/AzureDevOpsDragProvider.tsx`, `AzureDevOpsDropZone.tsx`~~ | 216 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/cost-predictor/CostPredictorDialog.tsx`~~ | 233 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/decision-logger/DecisionTimeline.tsx`~~ | 323 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/documentation-agent/DocumentationAgentDashboard.tsx`~~ | 312 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/memory/TeamSyncPanel.tsx`~~ | 580 | aucun importeur, Graphiti | **supprimé (L7)** |
| ~~`renderer/components/task-detail/ResumeWithProviderDropdown.tsx`~~ | 204 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/task-detail/TaskDetailModalHandlers.tsx`~~ | 212 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/task-detail/task-review/TerminalDropdown.tsx`~~ | 55 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/ui/sheet.tsx`~~ | 130 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/components/workspace/AddWorkspaceModal.tsx`~~ | 320 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/hooks/use-profile-swap-notifications.ts`~~ | 195 | test seul | **supprimé (L8)** |
| ~~`renderer/lib/flow-controller.ts`, `scroll-controller.ts`~~ | 287 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/lib/webgl-context-manager.ts`~~ | 205 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/lib/terminal-font-settings-verification.ts`~~ | 92 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/lib/compose-refs-fix.ts`~~ | 85 | aucun importeur | **supprimé (L8)** |
| ~~`renderer/test-logger.ts`~~ | 16 | aucun importeur | **supprimé (L8)** |
| ~~`shared/types/providers.generated.ts`~~ | 55 | généré, jamais importé | **supprimé (L8)** |
| ~~`shared/utils/powershell-color-support.ts`~~ | 102 | aucun importeur | **supprimé (L8)** |
| ~~`examples/colored-logs-example.ts`~~ | 57 | exemple | **supprimé (L8)** |
| ~~`main/terminal/pty-daemon.ts` (+ `pty-daemon-client.ts`)~~ | 586 | pas une entrée de build ; client jamais connecté | **supprimé (L8)** |
| ~~`main/services/sdk-session-recovery-coordinator.ts`~~ | 568 | test seul | **supprimé (L8)** |
| ~~`main/log-service.ts`~~ | 364 | aucun importeur | **supprimé (L8)** |
| ~~`main/fs-utils.ts`~~ | 155 | aucun importeur | **supprimé (L8)** |
| ~~`main/copilot-cli-utils.ts`~~ | 86 | aucun importeur | **supprimé (L8)** |
| ~~`main/ipc-handlers/renderer-log-handler.ts`~~ | 60 | jamais enregistré | **supprimé (L3)** |
| `main/ipc-handlers/context-aware-snippets-handlers.ts` | 77 | jamais enregistré | **câblé (L3), conservé** |
| ~~preload : `scanOllamaModels`, `downloadOllamaModel`, `initializeClaudeProfile`, `submitOAuthCode`, `getAzureDevOpsProjects`~~ | — | canaux sans handler | **supprimés (L3)** |

## A.2 Backend (F29 ; F21 ; F32)

| Fichier (`apps/backend/…` sauf mention) | Lignes | Preuve | Action |
|---|---:|---|---|
| `planner_lib/` | 939 | aucun import | supprimer |
| `prediction/` | 1 055 | aucun import | supprimer |
| `sandbox/` | 1 102 | importé par ses tests seulement | supprimer + tests |
| `core/agent_client/optimized_copilot_agent_client.py` | 481 | répertoire masqué par `core/agent_client.py` | supprimer |
| `core/runtimes/optimized_copilot_runtime.py` | 381 | aucun import | supprimer |
| `migration/models_fixed.py` | 326 | aucun import | supprimer |
| `runners/github/services/review_tools.py` | 619 | aucun import | supprimer |
| `runners/github/multi_repo.py` | 512 | aucun import (`multi_repo_runner` est autre chose) | supprimer |
| `streaming/integration_example.py` | 255 | exemple | supprimer |
| `runners/github/validator_example.py` | 221 | exemple | supprimer |
| `runners/github/bot_detection_example.py` | 154 | exemple | supprimer |
| `runners/jira/jira_work_items_example.py` | 140 | exemple | supprimer |
| `runners/time_travel_runner.py` | 227 | jamais lancé ; `replay/api.py` sert le time travel | supprimer |
| `core/output_schemas.py` | 162 | aucun import | supprimer |
| `cli/quality_commands.py` | 146 | aucun import | supprimer |
| `runners/context_aware_snippets_runner.py` | — | importait 3 modules inexistants | **réécrit (L3), conservé** |
| `src/connectors/llm_*.py` (racine du dépôt, 13 fichiers) | 1 769 | second registre ; `anthropic.Anthropic()` | migrer puis supprimer (F32) |

## A.3 Prompts orphelins (F10)

| Fichier (`apps/backend/prompts/…`) | Octets |
|---|---:|
| `github/pr_orchestrator.md` | 14 649 |
| `coder_recovery.md` | 8 858 |
| `intent_templates.md` | 4 391 |
| `environment_cloner.md` | 3 971 |
| `performance_profiler.md` | 3 070 |
| `github/issue_analyzer.md` | 3 020 |
| `documentation_agent.md` | 2 877 |
| `code_migration.md` | 2 871 |
| `multi_repo_planner.md` | 2 733 |
| `breaking_change_detector.md` | 2 308 |
| `browser_agent.md` | 2 251 |

## A.4 Shims racine `apps/backend/*.py` (F30)

| Shim | Importeurs | Cible |
|---|---:|---|
| `azure_devops_integration.py`, `client.py`, `critique.py`, `linear_config.py` | 0 | supprimer |
| `debug.py` | 58 | `core.debug` |
| `progress.py` | 32 | `core.progress` |
| ~~`graphiti_config.py`, `graphiti_providers.py`~~ | 0 au moment du lot | **supprimés (L7)** |
| `worktree.py` | 15 | `core.worktree` (chargé par importlib, voir F30) |
| `project_analyzer.py` | 13 | `project` |
| `prompts.py` | 9 | `prompts_pkg.prompts` |
| `agent.py`, `recovery.py` | 8, 8 | `core.agent`, `services.recovery` |
| `linear_updater.py`, `workspace.py` | 7, 7 | `integrations.linear.updater`, `core.workspace` |
| `auto_claude_tools.py` | 6 | `agents.tools_pkg` |
| `qa_loop.py`, `phase_event.py` | 4, 4 | `qa`, `core.phase_event` |
| `prompt_generator.py`, `risk_classifier.py` | 3, 3 | `prompts_pkg.prompt_generator`, `analysis.risk_classifier` |
| `ci_discovery.py`, `scan_secrets.py`, `analyzer.py` | 2 chacun | `analysis.ci_discovery`, `security.scan_secrets`, `analysis.analyzer` |
| `insight_extractor.py`, `linear_integration.py`, `security_scanner.py` | 1 chacun | `analysis.insight_extractor` (chargé par importlib, voir F30), `integrations.linear.integration`, `analysis.security_scanner` |

## A.5 Documentation et scripts (F33)

| Chemin | Taille | Action |
|---|---:|---|
| `utils/` (29 fichiers) | 3 719 lignes | archiver puis supprimer ; retirer de `lint.yml:82` |
| `shared_docs/FEATURE_IDEAS.md` | 203 Ko | fusionner / convertir en issues |
| `shared_docs/FEATURE_IMPROVEMENTS_AND_NEW_IDEAS.md` | 208 Ko | idem |
| `docs/CHANGELOG.md` | 107 Ko | fusionner avec `CHANGELOG.md` |
| `docs/pr-1575-fixes.md` | 9 Ko | archiver |
| `docs/superpowers/plans/`, `docs/superpowers/specs/` | 112 Ko | archiver |
| ~~`apps/backend/scripts/test_memory_save.py`~~ | — | **supprimé (L7)** |
| `.security-reports/` | vide | supprimer |
| `runners/github/test_context_gatherer.py` (racine) | — | déplacer dans `tests/` |

---

[Cahier de nettoyage](../AUDIT-NETTOYAGE.md)
