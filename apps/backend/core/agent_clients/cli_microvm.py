"""An agent CLI inside the task's Docker Sandboxes microVM.

With Settings > Sandbox > microVM and its "agent CLIs" switch on, a CLI whose
``providers.yaml`` sandbox block has a ``microvm:`` entry (OpenCode) runs in
the task's VM instead of the host's OS sandbox, for the API keys the person
stored in sbx (``sbx secret set openai``…). WorkPilot never copies a key:
inside the VM the CLI's variables hold a placeholder, and the sbx proxy adds
the real key to the requests that leave it. Without such a key (a
subscription sign-in, a local model, nothing stored), the CLI stays on the
host and the card says why. Design: docs/architecture/os-sandbox.md.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CliVm:
    """How one CLI runs in the VM: its name there and its placeholders."""

    command: str
    install: str
    variables: tuple[str, ...]

    def launch(self, sandbox: Any, command: list[str], env: dict[str, str], cwd: str):
        """`command` (its host executable first) as started in the VM."""
        from os_sandbox.microvm import SECRET_PLACEHOLDER

        vm_env = dict.fromkeys(self.variables, SECRET_PLACEHOLDER)
        # A Node/Bun CLI may read PWD before its working directory.
        vm_env["PWD"] = sandbox.vm.target_of(cwd)
        return sandbox.wrap(
            [self.command, *command[1:]], env, cwd=cwd, stdin=True, vm_env=vm_env
        )


def plan(
    spec: Any, label: str, model_service: str | None
) -> tuple[CliVm | None, str | None]:
    """Whether this CLI runs in the VM: (how, None), or (None, why not).

    ``(None, None)`` when the person did not ask for it. ``model_service`` is
    the sbx service the chosen model needs (``anthropic`` for
    ``anthropic/claude-…``); ``""`` for a model no sbx service signs (a local
    one), None when the CLI picks its own.
    """
    from security.agent_safety_settings import load_settings

    settings = load_settings().sandbox.microvm
    if not (settings.enabled and settings.cli_agents):
        return None, None
    profile = getattr(spec, "microvm", None) if spec is not None else None
    if profile is None:
        return None, f"{label} has no microVM profile in capabilities/providers.yaml"
    if model_service == "":
        return None, f"{label}'s model is not signed by a key stored in sbx"

    from os_sandbox.microvm import probe_microvm, secret_services

    status = probe_microvm()
    if not status.available:
        return None, status.reason
    stored = secret_services()
    usable = [
        (service, names)
        for service, names in profile.secrets
        if service in stored and model_service in (None, service)
    ]
    if not usable:
        wanted = model_service or "/".join(service for service, _ in profile.secrets)
        return None, (
            f"no key stored in sbx for {label} ({wanted}); "
            "`sbx secret set <service>` puts one there"
        )
    variables = tuple(dict.fromkeys(name for _, names in usable for name in names))
    return CliVm(profile.command, profile.install, variables), None


def model_service(model: str | None, services: tuple[str, ...]) -> str | None:
    """The sbx service of a ``provider/model`` id among `services`.

    None for no model (the CLI's own default); ``""`` for a provider none of
    them is (``ollama/…``): such a model cannot run in the VM.
    """
    if not model or model == "default" or "/" not in model:
        return None
    provider = model.split("/", 1)[0].lower()
    return provider if provider in services else ""


def open_session(
    open_sandbox: Any, spec: Any, label: str, model: str | None
) -> tuple[Any, CliVm | None]:
    """The CLI's sandbox, in the VM when `plan` allows and the CLI installs.

    `open_sandbox(microvm=…)` is the client's `os_sandbox.session_sandbox`
    call. When the CLI stays on the host for a reason, the reason is kept as
    the session's ``fallback_reason`` (shown on the card).
    """
    services = tuple(
        s for s, _ in getattr(getattr(spec, "microvm", None), "secrets", ())
    )
    how, why = plan(spec, label, model_service(model, services))
    sandbox = open_sandbox(microvm=how is not None)
    if how is not None and getattr(sandbox, "vm", None) is not None:
        from os_sandbox.microvm import MicrovmError, ensure_tool

        try:
            ensure_tool(sandbox.vm, how.command, how.install)
            return sandbox, how
        except MicrovmError as error:
            why = f"{label} could not be installed in the microVM: {error}"
            logger.warning("[microvm] %s", why)
            sandbox = open_sandbox(microvm=False)
    elif how is not None:
        # session_sandbox fell back on its own and says why.
        return sandbox, None
    if (
        why
        and getattr(sandbox, "vm", None) is None
        and hasattr(sandbox, "fallback_reason")
    ):
        if not sandbox.fallback_reason:
            sandbox = replace(sandbox, fallback_reason=why[:500])
    return sandbox, None
