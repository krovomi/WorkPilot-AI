"""Turn a release's feature flags on and off with their provider.

A flag of the train file goes on once every service it names shipped in the
environment, and goes off before any of them rolls back. Three providers are
called over their REST API; ``manual`` asks the person to do it and confirm.

* Unleash: ``POST {url}/api/admin/projects/{project}/features/{key}/environments/{env}/on|off``,
  token ``UNLEASH_API_TOKEN`` in ``Authorization``.
* LaunchDarkly: ``PATCH {url}/api/v2/flags/{project}/{key}`` with a semantic
  patch (``turnFlagOn`` / ``turnFlagOff`` in ``environmentKey``), token
  ``LAUNCHDARKLY_API_TOKEN`` in ``Authorization``; ``url`` defaults to
  ``https://app.launchdarkly.com`` (``app.eu.launchdarkly.com`` or
  ``app.launchdarkly.us`` for the other instances).
* ConfigCat: ``PUT {url}/v1/environments/{env}/settings/{key}/value`` with
  ``{"value": true|false}``, ``configId`` = ``project`` when the key is not a
  number, basic auth ``CONFIGCAT_API_USER`` / ``CONFIGCAT_API_PASSWORD``;
  ``url`` defaults to ``https://api.configcat.com``.

The tokens come from the project's environment variables, which the app hands
to this process only for the flags the file declares (S1): never written to
the run, the journal or an error.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from .train_file import Flag

TOKENS: dict[str, tuple[str, ...]] = {
    "unleash": ("UNLEASH_API_TOKEN",),
    "launchdarkly": ("LAUNCHDARKLY_API_TOKEN",),
    "configcat": ("CONFIGCAT_API_USER", "CONFIGCAT_API_PASSWORD"),
    "manual": (),
}
DEFAULT_URLS = {
    "launchdarkly": "https://app.launchdarkly.com",
    "configcat": "https://api.configcat.com",
}
TIMEOUT_S = 20


class FlagError(ValueError):
    """A flag that cannot be switched as declared (nothing was sent)."""


@dataclass
class FlagRequest:
    method: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes | None = None


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def build_request(
    flag: Flag, on: bool, train_environment: str, env: Mapping[str, str]
) -> FlagRequest | None:
    """The call that switches ``flag``; None for a ``manual`` flag."""
    if flag.provider == "manual":
        return None
    missing = [name for name in TOKENS[flag.provider] if not env.get(name)]
    if missing:
        raise FlagError(
            f"{', '.join(missing)} is not set in the project's environment variables"
        )
    environment = flag.environment or train_environment
    base = flag.url or DEFAULT_URLS.get(flag.provider, "")
    if not base:
        raise FlagError(f"flag {flag.key} needs the provider's url")
    if flag.provider == "unleash":
        project = flag.project or "default"
        path = (
            f"/api/admin/projects/{_quote(project)}/features/{_quote(flag.key)}"
            f"/environments/{_quote(environment)}/{'on' if on else 'off'}"
        )
        return FlagRequest(
            "POST",
            base + path,
            {
                "Authorization": env["UNLEASH_API_TOKEN"],
                "Content-Type": "application/json",
            },
            b"{}",
        )
    if flag.provider == "launchdarkly":
        if not flag.project:
            raise FlagError(f"flag {flag.key} needs its LaunchDarkly project")
        body = {
            "environmentKey": environment,
            "comment": "WorkPilot release train",
            "instructions": [{"kind": "turnFlagOn" if on else "turnFlagOff"}],
        }
        return FlagRequest(
            "PATCH",
            f"{base}/api/v2/flags/{_quote(flag.project)}/{_quote(flag.key)}",
            {
                "Authorization": env["LAUNCHDARKLY_API_TOKEN"],
                "Content-Type": "application/json; domain-model=launchdarkly.semanticpatch",
            },
            json.dumps(body).encode(),
        )
    query = ""
    if not flag.key.isdigit():
        if not flag.project:
            raise FlagError(f"flag {flag.key} needs its ConfigCat config id (project)")
        query = "?configId=" + _quote(flag.project)
    credentials = f"{env['CONFIGCAT_API_USER']}:{env['CONFIGCAT_API_PASSWORD']}"
    return FlagRequest(
        "PUT",
        f"{base}/v1/environments/{_quote(environment)}/settings/{_quote(flag.key)}/value{query}",
        {
            "Authorization": "Basic " + base64.b64encode(credentials.encode()).decode(),
            "Content-Type": "application/json",
        },
        json.dumps({"value": on}).encode(),
    )


def send(request: FlagRequest) -> int:
    """The status the provider answered; 0 when nothing answered."""
    prepared = urllib.request.Request(
        request.url, data=request.body, headers=request.headers, method=request.method
    )
    try:
        with urllib.request.urlopen(prepared, timeout=TIMEOUT_S) as response:  # noqa: S310 - http(s) only, checked by the train file
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return 0


def switch(
    flag: Flag,
    on: bool,
    train_environment: str,
    env: Mapping[str, str],
    *,
    sender: Callable[[FlagRequest], int] = send,
) -> dict[str, object]:
    """Switch ``flag``: ``done``, ``manual`` (the person does it) or ``failed``."""
    base = {"key": flag.key, "provider": flag.provider, "on": on}
    try:
        request = build_request(flag, on, train_environment, env)
    except FlagError as exc:
        return {**base, "status": "failed", "detail": str(exc)}
    if request is None:
        return {**base, "status": "manual", "detail": ""}
    status = sender(request)
    if 200 <= status < 300:
        return {**base, "status": "done", "detail": "", "httpStatus": status}
    return {
        **base,
        "status": "failed",
        "detail": f"the provider answered {status}"
        if status
        else "the provider did not answer",
        "httpStatus": status or None,
    }


def token_names(flags: list[Flag]) -> list[str]:
    """The variables the app must hand over for these flags."""
    return sorted({name for flag in flags for name in TOKENS.get(flag.provider, ())})


__all__ = ["FlagError", "FlagRequest", "build_request", "send", "switch", "token_names"]
