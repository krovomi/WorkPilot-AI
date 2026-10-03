---
extends: verify
family: claude-agent-sdk
---
Ce fichier spécialise `verify` pour les sessions pilotées par le Claude Agent
SDK (Claude, et les fournisseurs qui passent par lui). Les outils MCP y sont
natifs.

## Outils

| Étape | Outil |
|---|---|
| détecter, lancer, relancer, lire le journal | `mcp__workpilot-verify__verify_detect`, `verify_launch`, `verify_logs`, `verify_stop` |
| piloter le navigateur | `mcp__chrome-devtools__navigate_page`, `take_snapshot`, `click`, `fill`, `press_key`, `wait_for`, `list_console_messages`, `list_network_requests` |
| trace de performance | `mcp__chrome-devtools__performance_start_trace` (`reload: true`, `autoStop: true`), `performance_stop_trace`, `performance_analyze_insight` — ou `mcp__workpilot-verify__verify_perf_trace`, qui calcule le score |
| capture | `mcp__workpilot-verify__verify_screenshot` (elle est rangée là où la revue visuelle la lit) |
| endpoints | `mcp__workpilot-verify__verify_endpoints` (candidats + payloads depuis le schéma), `verify_call_endpoint` |
| mobile | `mcp__workpilot-verify__verify_device` |
| journal de la preuve | `mcp__workpilot-verify__verify_record` |

Hors de WorkPilot (Claude Code dans un IDE), `workpilot-verify` n'est présent
que si quelqu'un l'a branché
(`claude mcp add workpilot-verify -- python apps/backend/runners/verify_mcp.py --project-dir .`).
Sans lui : lancer l'app avec `Bash` en arrière-plan, et garder
`chrome-devtools` pour le navigateur et la trace.

## Frontend
<!-- append -->
Le serveur `chrome-devtools` et `verify_browser` pilotent le **même** usage,
pas forcément le même navigateur : choisir l'un et s'y tenir pendant tout le
parcours. Après chaque `click`, refaire un `take_snapshot` avant de viser
l'élément suivant — les `uid` changent quand la page se redessine.

Un sous-agent peut lancer et surveiller l'application pendant que la session
principale navigue ; ce n'est jamais lui qui confirme l'état.

## Report
<!-- append -->
Enregistrer le verdict avec `verify_record` (`kind: "verdict"`) avant la ligne
`Verify:` : c'est ce qui alimente la carte du Kanban.
