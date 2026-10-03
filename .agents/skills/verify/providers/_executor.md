---
extends: verify
family: tool-executor
---
Ce fichier spécialise `verify` pour les fournisseurs dont WorkPilot exécute
lui-même les outils (OpenAI, Gemini, Copilot, Windsurf, Mistral, Ollama et les
autres modèles locaux). Il n'y a **pas** de serveur MCP dans cette session :
le navigateur, la trace Chrome DevTools et les appareils passent par les outils
`verify_*`, que WorkPilot exécute en relayant lui-même Chrome DevTools MCP.

## Outils

| Étape | Outil |
|---|---|
| détecter | `verify_detect` |
| lancer / relancer / arrêter | `verify_launch`, `verify_stop` |
| journal et erreurs | `verify_logs` |
| navigateur | `verify_browser` avec `action` : `navigate`, `snapshot`, `click`, `fill`, `press`, `wait_for`, `console`, `network`, `emulate` |
| trace de performance | `verify_perf_trace` (Chrome DevTools MCP, score calculé) |
| capture | `verify_screenshot` |
| endpoints | `verify_endpoints`, puis `verify_call_endpoint` |
| mobile | `verify_device` avec `action` : `devices`, `launch`, `screenshot`, `logs`, `perf` |
| journal de la preuve | `verify_record` |

Corriger le code se fait avec les outils de fichiers habituels
(`read_file`, `write_file`) ; relancer ensuite avec `verify_launch`.

## Frontend
<!-- append -->
Toujours `verify_browser` `snapshot` avant un `click` ou un `fill` : la
réponse liste les éléments avec leur `uid`, et c'est ce `uid` qui se passe à
l'action suivante. Ne jamais inventer un sélecteur CSS.

## Report
<!-- append -->
Enregistrer le verdict avec `verify_record` (`kind: "verdict"`) avant la ligne
`Verify:`.
