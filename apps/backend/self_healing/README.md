# Self-Healing

The Incident Responder: a failed pipeline, a production error or a fragile file becomes an
incident, with the facts a fixer needs, computed without a model.

| Mode | Code | What it adds |
|---|---|---|
| CI/CD | `incident_responder/cicd_mode.py`, `cicd/` | the failing tests and build errors, the stack's own test command, the last green commit, the first bad commit by bisect |
| Production | `incident_responder/production_mode.py`, `production/` | the stack trace read by `docintel.stacktrace`, a fingerprint that groups one bug seen by several tools, the suspect commits |
| Proactive | `incident_responder/proactive_mode.py`, `incident_responder/fragility_analyzer.py`, `proactive/` | complexity, churn and coverage per file, the trend of its risk across scans |

`incident_responder/orchestrator.py` drives the three modes and keeps their state in
`.workpilot/self-healing/` (`incidents.json`, `operations.json`, `fragility_reports.json`). The
runner is `runners/self_healing_runner.py`, called by the app's Self-Healing view.

Why it is built this way: [`docs/architecture/self-healing-insights.md`](../../../docs/architecture/self-healing-insights.md).
