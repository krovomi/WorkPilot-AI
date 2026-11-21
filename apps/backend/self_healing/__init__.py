"""
Self-Healing
============

The Incident Responder: three modes that turn a signal into an incident and
the facts a fixer needs.

- CI/CD (`cicd/`): a failed pipeline, the first bad commit by bisect.
- Production (`production/`): a monitoring report, its fingerprint and group,
  the suspect commits.
- Proactive (`proactive/`): fragile files and the trend of their risk.

`incident_responder.IncidentResponderOrchestrator` drives them; the runner is
`runners/self_healing_runner.py`, which the app's Self-Healing view calls.

Usage:
    from self_healing.incident_responder import IncidentResponderOrchestrator

    orchestrator = IncidentResponderOrchestrator(project_dir)
    operation = await orchestrator.handle_cicd_failure(commit_sha, branch, output)
"""

__all__ = ["IncidentResponderOrchestrator"]


# Lazy import: the subpackages import `incident_responder.models`.
def __getattr__(name):
    if name == "IncidentResponderOrchestrator":
        from .incident_responder import IncidentResponderOrchestrator

        return IncidentResponderOrchestrator
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
