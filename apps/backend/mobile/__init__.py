"""Building smartphone applications — Android and Apple — as first-class work.

The repository already knew how to run a *web* project: `app_emulator_runner`
detects a framework and a port, and the Kanban previews the result in a
webview. A phone application has neither. It is compiled, installed onto a
device or an emulator, and looked at through a screenshot; the toolchain that
does that may not even be installable on the machine the agent is running on
(no Xcode outside macOS), and the question "can this build at all here?" has to
be answerable *before* a build phase spends an hour discovering it cannot.

So the mobile support is one module with four separable answers:

``stacks``   which mobile stack this project is, and the commands it responds to
``devices``  the emulators and simulators actually available on this machine
``doctor``   whether the toolchain for a target is usable, and what is missing
``prompt``   the section every agent phase gets when a task targets a phone

Everything else — the runner, the Electron service, the subagent overlay, the
workflow phases — reads these and adds nothing of its own. The alternative was
a detector in the Python runner, a second one inline in TypeScript, and a third
in the prompt layer, which is how the web side ended up with two.
"""

from __future__ import annotations

from .devices import MobileDevice, list_devices
from .prompt import mobile_section, requested_targets
from .readiness import ToolCheck, doctor
from .stacks import (
    ANDROID,
    IOS,
    MobilePlatform,
    MobileStack,
    detect_stack,
    is_mobile_project,
    normalise_targets,
)

__all__ = [
    "ANDROID",
    "IOS",
    "MobileDevice",
    "MobilePlatform",
    "MobileStack",
    "ToolCheck",
    "detect_stack",
    "doctor",
    "is_mobile_project",
    "list_devices",
    "mobile_section",
    "normalise_targets",
    "requested_targets",
]
