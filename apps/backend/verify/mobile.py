"""The mobile half of a verification: the right emulator, the app, a frame.

`mobile.readiness.doctor` answers first, in milliseconds, whether a platform
can be built on this machine at all — an iOS target off macOS is a property of
the machine, said once and not retried. Then a device: a booted one when there
is one, otherwise the first emulator/simulator defined, booted here. Then the
stack's own run command (`mobile.launch`), a frame, the app's own log read for
crashes, and the two numbers Android measures for free — cold start time and
janky frames.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .errors import VerifyError, collect_errors

logger = logging.getLogger(__name__)

__all__ = ["PlatformVerification", "verify_mobile"]


@dataclass
class PlatformVerification:
    platform: str
    #: ``verified``, ``failed``, ``blocked`` (machine cannot build it) or ``no-device``.
    status: str
    device: str = ""
    frame: str = ""
    startup_ms: float | None = None
    jank: dict = field(default_factory=dict)
    errors: list[VerifyError] = field(default_factory=list)
    detail: str = ""

    def to_dict(self) -> dict:
        data = asdict(self)
        data["errors"] = [e.to_dict() for e in self.errors]
        return data


def verify_mobile(
    project_dir: Path | str,
    spec_dir: Path | None,
    base: Path,
    platforms: list[str] | None = None,
    *,
    build: bool = True,
) -> list[PlatformVerification]:
    """One result per requested platform. Never raises."""
    project = Path(project_dir)
    try:
        from mobile.devices import list_devices
        from mobile.launch import (
            app_log,
            boot_device,
            build_and_run,
            capture_frame,
            jank_stats,
            launch_app,
            startup_ms,
        )
        from mobile.readiness import doctor
        from mobile.stacks import detect_stack
    except ImportError as exc:
        return [PlatformVerification("mobile", "blocked", detail=f"unavailable: {exc}")]

    stack = detect_stack(project)
    if stack is None:
        return []
    wanted = (
        tuple(p for p in (platforms or stack.platforms) if p in stack.platforms)
        or stack.platforms
    )
    reports = doctor(project, platforms=wanted, stack=stack)
    out: list[PlatformVerification] = []
    for platform in wanted:
        report = reports.get(platform)
        if report is not None and not report.ok:
            out.append(PlatformVerification(platform, "blocked", detail=report.blocker))
            continue
        listing = list_devices((platform,))
        devices = [d for d in listing.devices if d.platform == platform]
        device = next((d for d in devices if d.is_booted), None) or next(
            (d for d in devices if d.kind in ("emulator", "simulator")), None
        )
        if device is None:
            reason = (listing.unavailable or {}).get(
                platform
            ) or "no emulator or simulator defined"
            out.append(PlatformVerification(platform, "no-device", detail=reason))
            continue
        booted, why = boot_device(device)
        if not booted:
            out.append(
                PlatformVerification(
                    platform, "no-device", device=device.name, detail=why
                )
            )
            continue

        result = PlatformVerification(
            platform, "verified", device=f"{device.name} [{device.id}]"
        )
        if build:
            ok, output = build_and_run(stack, platform, project)
            if not ok:
                result.status = "failed"
                result.errors = collect_errors(
                    output, project, source=f"build:{platform}"
                ) or [
                    VerifyError(
                        "build",
                        f"the {platform} run command failed",
                        source=f"build:{platform}",
                    )
                ]
                result.detail = "build or install failed"
                out.append(result)
                continue
        launched, detail = launch_app(stack, platform, device.id)
        if not launched:
            result.detail = detail

        frame = base / "frames" / f"{platform}.png"
        if capture_frame(platform, device.id, frame):
            result.frame = str(frame)
            if spec_dir is not None:
                _save_capture(spec_dir, frame, platform)
        log = app_log(stack, platform, device.id)
        result.errors += collect_errors(log, project, source=f"device:{platform}")
        result.startup_ms = startup_ms(stack, platform, device.id)
        result.jank = jank_stats(stack, platform, device.id)
        if any(e.kind in ("crash", "exception") for e in result.errors):
            result.status = "failed"
        elif not result.frame:
            result.status = "failed"
            result.detail = result.detail or "no readable frame was captured"
        out.append(result)
    return out


def _save_capture(spec_dir: Path, frame: Path, platform: str) -> None:
    try:
        from docintel.visual_qa import save_capture

        save_capture(
            spec_dir,
            frame.read_bytes(),
            side="task",
            platform=platform,
            source="verifier",
            label="verify: app launched",
        )
    except Exception as exc:  # noqa: BLE001 - a capture never fails the verification
        logger.debug("verify: could not file the %s frame: %s", platform, exc)
