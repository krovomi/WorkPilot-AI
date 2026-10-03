"""The `verify_*` tools: one definition, two transports.

Every provider gets the same tools for the part of a verification that needs a
model — driving the app to the changed state, choosing the payloads, judging
the answer:

* **in-process** for the providers WorkPilot executes tools for (Copilot,
  OpenAI, Gemini, Mistral, Windsurf, Ollama and the local runtimes), through
  `core.runtimes.tool_executor` — the path the shared brain already takes;
* **over MCP** (`verify.mcp_server`, `workpilot-verify`) for the Claude Agent
  SDK, and for Claude Code, Codex or Copilot in an IDE attached by a person.

`TOOLS` is in MCP shape (``inputSchema``); `tool_definitions()` is the same
list in `tool_executor`'s shape (``parameters``). There is no second list.

The browser behind `verify_browser` is `verify.devtools.BrowserSession` —
Chrome DevTools MCP driven from Python, Playwright when it cannot start — kept
alive across calls by a `VerifyToolbox` per project and spec, so a snapshot's
`uid` is still valid on the next `click`.

What the agent does is recorded as it does it, not only when it remembers to
say so: every navigation, click and fill becomes a step of the scenario
(replayed without a model after QA, `verify.replay`), every endpoint call and
screenshot an entry of the record. `verify_record` remains for what only the
model knows — the state it confirmed, its verdict.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shlex
from pathlib import Path
from typing import Any

from .detect import Detection, Target, detect_targets
from .record import append_event
from .settings import load_settings
from .state import load_state, stop_all, stop_process, work_dir

logger = logging.getLogger(__name__)

__all__ = [
    "TOOLS",
    "TOOL_NAMES",
    "tool_definitions",
    "is_verify_tool",
    "VerifyToolbox",
    "toolbox_for",
    "execute_tool",
    "close_toolboxes",
]


def _schema(properties: dict, required: list[str] | None = None) -> dict:
    schema: dict = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


_TARGET = {
    "type": "string",
    "description": "Target name or kind (web-frontend, backend-api, desktop). Optional.",
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "verify_detect",
        "description": "List what can be launched in this project (web front end, API, desktop app, mobile app), with the launch command, and which ones the task touched.",
        "inputSchema": _schema({}),
    },
    {
        "name": "verify_launch",
        "description": "Launch (or relaunch after a fix) an app of this project and wait until it answers. Returns its URL, the errors it printed and the tail of its log.",
        "inputSchema": _schema(
            {
                "target": _TARGET,
                "restart": {
                    "type": "boolean",
                    "description": "Relaunch even if it already runs (after a code fix).",
                },
                "command": {
                    "type": "string",
                    "description": "Override the detected command (a project launcher only, e.g. `pnpm run dev`). Rarely needed.",
                },
            }
        ),
    },
    {
        "name": "verify_logs",
        "description": "The errors the running app printed since launch, and the tail of its log.",
        "inputSchema": _schema(
            {
                "target": _TARGET,
                "tail": {
                    "type": "integer",
                    "description": "Log characters to return (default 3000).",
                },
            }
        ),
    },
    {
        "name": "verify_stop",
        "description": "Stop an app launched by the verification (or all of them).",
        "inputSchema": _schema({"target": _TARGET}),
    },
    {
        "name": "verify_browser",
        "description": (
            "Drive a browser on the launched app (Chrome DevTools MCP). Actions: navigate (url or path), "
            "snapshot (lists elements with their uid), click (uid), fill (uid, value), press (key), "
            "wait_for (text), console, network, emulate (viewport: mobile|desktop), evaluate (script). "
            "Always snapshot before click/fill and use a uid from that snapshot."
        ),
        "inputSchema": _schema(
            {
                "action": {
                    "type": "string",
                    "enum": [
                        "navigate",
                        "snapshot",
                        "click",
                        "fill",
                        "press",
                        "wait_for",
                        "console",
                        "network",
                        "emulate",
                        "evaluate",
                    ],
                },
                "url": {
                    "type": "string",
                    "description": "navigate: absolute loopback URL or a path like /orders",
                },
                "uid": {
                    "type": "string",
                    "description": "click/fill: element uid from the last snapshot",
                },
                "value": {"type": "string", "description": "fill: the value to type"},
                "key": {"type": "string", "description": "press: e.g. Enter"},
                "text": {
                    "type": "string",
                    "description": "wait_for: text expected on the page",
                },
                "viewport": {
                    "type": "string",
                    "description": "emulate: mobile or desktop",
                },
                "script": {
                    "type": "string",
                    "description": "evaluate: a JS function, e.g. () => document.title",
                },
                "target": _TARGET,
            },
            ["action"],
        ),
    },
    {
        "name": "verify_screenshot",
        "description": "Save a screenshot of the current page (or of url) as evidence; it is filed where the visual QA review reads captures.",
        "inputSchema": _schema(
            {
                "label": {
                    "type": "string",
                    "description": "What the screenshot proves, e.g. 'order saved'",
                },
                "url": {"type": "string"},
                "full_page": {"type": "boolean"},
                "target": _TARGET,
            },
            ["label"],
        ),
    },
    {
        "name": "verify_perf_trace",
        "description": "Record a Chrome DevTools performance trace of a page (default: the current one) and return LCP, CLS, TBT and a 0-100 score, plus Lighthouse accessibility/best-practice scores when available.",
        "inputSchema": _schema({"url": {"type": "string"}, "target": _TARGET}),
    },
    {
        "name": "verify_endpoints",
        "description": "The API endpoints the task created or changed (from the running app's OpenAPI document), each with a ready-to-send call built from its schema.",
        "inputSchema": _schema(
            {
                "target": _TARGET,
                "all": {
                    "type": "boolean",
                    "description": "List every endpoint, not only the touched ones.",
                },
            }
        ),
    },
    {
        "name": "verify_call_endpoint",
        "description": "Call an endpoint of the launched API (loopback only) and check the status code and the response against its schema.",
        "inputSchema": _schema(
            {
                "method": {"type": "string"},
                "path": {
                    "type": "string",
                    "description": "Path with query string, e.g. /api/orders/1",
                },
                "body": {"description": "JSON body (object or array)"},
                "headers": {"type": "object"},
                "expect_status": {
                    "description": "Expected status code or list of codes"
                },
                "target": _TARGET,
            },
            ["method", "path"],
        ),
    },
    {
        "name": "verify_device",
        "description": "Mobile apps: actions devices (list emulators/simulators), launch (build, install, start, capture a frame, read the app log), screenshot, logs.",
        "inputSchema": _schema(
            {
                "action": {
                    "type": "string",
                    "enum": ["devices", "launch", "screenshot", "logs"],
                },
                "platform": {"type": "string", "enum": ["android", "ios"]},
            },
            ["action"],
        ),
    },
    {
        "name": "verify_record",
        "description": (
            "Record what only you know: kind=confirm (state, evidence) when the changed state is shown; "
            "kind=verdict (verdict: pass|fail|unknown, summary) at the end; kind=fix (file, summary) after a code fix; "
            "kind=step (action, note) for a step the tools did not capture."
        ),
        "inputSchema": _schema(
            {
                "kind": {
                    "type": "string",
                    "enum": ["confirm", "verdict", "fix", "step"],
                },
                "state": {"type": "string"},
                "evidence": {"type": "string"},
                "verdict": {"type": "string", "enum": ["pass", "fail", "unknown"]},
                "summary": {"type": "string"},
                "file": {"type": "string"},
                "action": {"type": "string"},
                "note": {"type": "string"},
            },
            ["kind"],
        ),
    },
]

TOOL_NAMES = frozenset(t["name"] for t in TOOLS)


def tool_definitions() -> list[dict[str, Any]]:
    """`TOOLS` in `tool_executor`'s shape."""
    return [
        {
            "name": t["name"],
            "description": t["description"],
            "parameters": t["inputSchema"],
        }
        for t in TOOLS
    ]


def is_verify_tool(name: str) -> bool:
    return name in TOOL_NAMES


# A model may name its own launch command, but only a project launcher, and
# never a shell construct: the command runs without a shell on POSIX, and the
# allowlist keeps `verify_launch` from becoming a second, unguarded Bash.
_LAUNCHERS = {
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "npx",
    "node",
    "deno",
    "dotnet",
    "python",
    "python3",
    "uvicorn",
    "gunicorn",
    "flask",
    "streamlit",
    "go",
    "cargo",
    "mvn",
    "./mvnw",
    "mvnw",
    "gradle",
    "./gradlew",
    "gradlew",
    "java",
    "php",
    "rails",
    "bundle",
    "docker",
    "docker-compose",
    "uv",
    "poetry",
}
_SHELL_META = re.compile(r"[;&|`$<>\n\\]|\$\(")


def _launch_command_allowed(command: str) -> tuple[bool, str]:
    if _SHELL_META.search(command):
        return False, "shell operators are not accepted in a launch command"
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        return False, f"unparseable command: {exc}"
    if not argv:
        return False, "empty command"
    head = Path(argv[0]).name if not argv[0].startswith("./") else argv[0]
    if head not in _LAUNCHERS:
        return (
            False,
            f"`{head}` is not a project launcher ({', '.join(sorted(_LAUNCHERS)[:12])}…)",
        )
    return True, ""


def _json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=1, default=str)


_SNAPSHOT_ROW = re.compile(r"uid=(?P<uid>[\w-]+)\s+(?P<desc>.+)$")


class VerifyToolbox:
    """The tools' state for one project and spec: targets, browser, documents."""

    def __init__(
        self,
        project_dir: Path | str,
        spec_dir: Path | str | None = None,
        changed_files: list[str] | None = None,
    ):
        self.project_dir = Path(project_dir).resolve()
        self.spec_dir = Path(spec_dir).resolve() if spec_dir else None
        self.base = work_dir(self.project_dir, self.spec_dir)
        self.settings = load_settings(self.project_dir)
        self.changed_files = changed_files
        self._detection: Detection | None = None
        self._browser = None
        self._browser_lock = asyncio.Lock()
        self._documents: dict[str, dict] = {}
        self._snapshot_rows: dict[str, str] = {}
        self._current_url = ""

    # -- targets -------------------------------------------------------------

    def detection(self) -> Detection:
        if self._detection is None:
            self._detection = detect_targets(
                self.project_dir, self.changed_files or self._changed_files()
            )
        return self._detection

    def _changed_files(self) -> list[str]:
        if self.changed_files is not None:
            return self.changed_files
        try:
            from verify.git import changed_files

            self.changed_files = changed_files(self.project_dir)
        except Exception:  # noqa: BLE001
            self.changed_files = []
        return self.changed_files

    def target(self, wanted: str | None, kinds: tuple[str, ...] = ()) -> Target | None:
        detection = self.detection()
        pool = detection.primary()
        if wanted:
            for target in detection.targets:
                if target.name == wanted or target.kind == wanted:
                    return target
            return None
        for target in pool:
            if not kinds or target.kind in kinds:
                return target
        for target in detection.targets:
            if not kinds or target.kind in kinds:
                return target
        return None

    def url_of(self, target: Target | None) -> str:
        if target is None:
            return ""
        entry = load_state(self.base)["processes"].get(target.name) or {}
        return str(entry.get("url") or "")

    # -- browser -------------------------------------------------------------

    async def browser(self, target: Target | None = None):
        async with self._browser_lock:
            if self._browser is None:
                from .devtools import BrowserSession

                browser_url = ""
                if target is not None and target.kind == "desktop":
                    browser_url = self.url_of(target)
                session = BrowserSession(
                    self.base,
                    project_dir=self.project_dir,
                    chrome_path=self.settings.chrome_path,
                    browser_url=browser_url,
                    prefer=self.settings.browser,
                )
                await session.start()
                self._browser = session
            return self._browser

    async def aclose(self) -> None:
        if self._browser is not None:
            await self._browser.close()
            self._browser = None

    def _resolve_url(self, url: str, target: Target | None) -> str:
        url = (url or "").strip()
        if not url:
            return self._current_url or self.url_of(target)
        if url.startswith("/"):
            base = self.url_of(target) or self._current_url
            base = (
                re.match(r"^https?://[^/]+", base).group(0)
                if base and re.match(r"^https?://[^/]+", base)
                else ""
            )
            return base + url if base else ""
        if re.match(
            r"^https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:/|$)", url
        ):
            return url
        return ""

    # -- the tools -----------------------------------------------------------

    async def call(self, name: str, args: dict[str, Any]) -> str:
        args = dict(args or {})
        handler = getattr(self, f"_t_{name.removeprefix('verify_')}", None)
        if handler is None:
            return f"Error: unknown verify tool {name!r}"
        try:
            return await handler(args)
        except Exception as exc:  # noqa: BLE001 - a tool answers, it does not crash the session
            logger.warning("verify tool %s failed: %s", name, exc)
            return f"Error: {exc}"

    async def _t_detect(self, args: dict) -> str:
        return _json(self.detection().to_dict())

    async def _t_launch(self, args: dict) -> str:
        from .launch import launch

        target = self.target(
            args.get("target"), ("backend-api", "web-frontend", "desktop")
        )
        if target is None:
            return "Error: no launchable target (see verify_detect); mobile apps use verify_device"
        command = args.get("command")
        if command:
            ok, why = _launch_command_allowed(str(command))
            if not ok:
                return f"Error: {why}"
        result = await asyncio.to_thread(
            launch,
            target,
            self.project_dir,
            self.base,
            timeout=float(self.settings.launch_timeout),
            command=command,
            restart=bool(args.get("restart")),
        )
        data = result.to_dict()
        data["log_tail"] = data["log_tail"][-1500:]
        return _json(data)

    async def _t_logs(self, args: dict) -> str:
        from .errors import collect_errors
        from .launch import read_log

        target = self.target(
            args.get("target"), ("backend-api", "web-frontend", "desktop")
        )
        if target is None:
            return "Error: no target"
        entry = load_state(self.base)["processes"].get(target.name) or {}
        log = read_log(entry.get("log") or (self.base / "logs" / f"{target.name}.log"))
        tail = int(args.get("tail") or 3000)
        errors = collect_errors(log, self.project_dir, source=f"log:{target.name}")
        return _json(
            {
                "target": target.name,
                "errors": [e.to_dict() for e in errors],
                "log_tail": log[-max(200, min(tail, 20000)) :],
            }
        )

    async def _t_stop(self, args: dict) -> str:
        wanted = args.get("target")
        if wanted:
            target = self.target(wanted)
            if target is None:
                return "Error: no such target"
            return _json(
                {
                    "stopped": [target.name]
                    if stop_process(self.base, target.name)
                    else []
                }
            )
        return _json({"stopped": stop_all(self.base)})

    def _remember_snapshot(self, text: str) -> None:
        rows = {}
        for line in (text or "").splitlines():
            match = _SNAPSHOT_ROW.search(line.strip())
            if match:
                rows[match.group("uid")] = match.group("desc")[:160]
        if rows:
            self._snapshot_rows = rows

    async def _t_browser(self, args: dict) -> str:
        action = str(args.get("action") or "")
        target = self.target(
            args.get("target"), ("web-frontend", "desktop", "backend-api")
        )
        browser = await self.browser(target)
        if not browser.available:
            return "Error: no browser could start — " + "; ".join(browser.reasons)
        if action == "navigate":
            url = self._resolve_url(str(args.get("url") or ""), target)
            if not url:
                return "Error: navigate needs a loopback URL or a path, and the app must be launched (verify_launch)"
            answer = await browser.navigate(url)
            self._current_url = url
            self._step("navigate", url=url)
            return answer
        if action == "snapshot":
            answer = await browser.snapshot()
            self._remember_snapshot(answer)
            return answer
        if action == "click":
            uid = str(args.get("uid") or "")
            answer = await browser.click(uid)
            self._step("click", uid=uid, text=self._snapshot_rows.get(uid, ""))
            return answer
        if action == "fill":
            uid, value = str(args.get("uid") or ""), str(args.get("value") or "")
            answer = await browser.fill(uid, value)
            self._step(
                "fill", uid=uid, value=value, text=self._snapshot_rows.get(uid, "")
            )
            return answer
        if action == "press":
            key = str(args.get("key") or "Enter")
            self._step("press", value=key)
            return await browser.press(key)
        if action == "wait_for":
            text = str(args.get("text") or "")
            if not text:
                return "Error: wait_for needs text"
            self._step("wait_for", value=text)
            return await browser.wait_for([text])
        if action == "console":
            return await browser.console()
        if action == "network":
            return await browser.network()
        if action == "emulate":
            return await browser.emulate(str(args.get("viewport") or "mobile"))
        if action == "evaluate":
            script = str(args.get("script") or "")
            if not script:
                return "Error: evaluate needs script"
            return await browser.evaluate(script)
        return f"Error: unknown browser action {action!r}"

    def _step(self, action: str, **fields: Any) -> None:
        append_event(
            self.base,
            "step",
            {
                "action": action,
                **{k: v for k, v in fields.items() if v not in (None, "")},
            },
        )

    async def _t_screenshot(self, args: dict) -> str:
        target = self.target(
            args.get("target"), ("web-frontend", "desktop", "backend-api")
        )
        browser = await self.browser(target)
        if not browser.available:
            return "Error: no browser could start — " + "; ".join(browser.reasons)
        if args.get("url"):
            url = self._resolve_url(str(args["url"]), target)
            if not url:
                return "Error: a loopback URL or a path is expected"
            await browser.navigate(url)
            self._current_url = url
        label = str(args.get("label") or "screenshot")[:120]
        slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:50] or "screenshot"
        path = self.base / "screenshots" / f"{slug}.png"
        ok = await browser.screenshot(path, full_page=bool(args.get("full_page")))
        if not ok:
            return "Error: the screenshot could not be taken"
        filed = self._file_capture(path, label, target)
        append_event(
            self.base,
            "screenshot",
            {
                "path": str(path),
                "label": label,
                "target": target.name if target else "",
                "url": self._current_url,
                "platform": "desktop" if target and target.kind == "desktop" else "web",
            },
        )
        return _json({"path": str(path), "filed_for_visual_review": filed})

    def _file_capture(self, path: Path, label: str, target: Target | None) -> bool:
        if self.spec_dir is None:
            return False
        try:
            from docintel.visual_qa import save_capture

            saved = save_capture(
                self.spec_dir,
                path.read_bytes(),
                side="task",
                platform="desktop"
                if target is not None and target.kind == "desktop"
                else "web",
                source="verifier",
                url=self._current_url,
                label=label,
            )
            return saved.status == "saved"
        except Exception:  # noqa: BLE001
            return False

    async def _t_perf_trace(self, args: dict) -> str:
        if not self.settings.perf_trace:
            return "Performance tracing is turned off (VERIFY_PERF_TRACE=false)."
        target = self.target(
            args.get("target"), ("web-frontend", "desktop", "backend-api")
        )
        browser = await self.browser(target)
        if not browser.available:
            return "Error: no browser could start — " + "; ".join(browser.reasons)
        url = self._resolve_url(str(args.get("url") or ""), target)
        if not url:
            return "Error: no page to trace — launch the app and navigate first"
        slug = re.sub(r"[^a-z0-9]+", "-", url.split("://", 1)[-1].lower()).strip("-")[
            :60
        ]
        result = await browser.perf_trace(url, self.base / "traces" / f"{slug}.json.gz")
        result.lighthouse = await browser.lighthouse()
        self._current_url = url
        data = result.to_dict()
        append_event(self.base, "perf", data)
        return _json(data)

    async def _document(self, target: Target) -> tuple[dict, str]:
        from .endpoints import fetch_openapi

        url = self.url_of(target)
        if not url:
            return {}, ""
        if url not in self._documents:
            document, path = await asyncio.to_thread(fetch_openapi, url)
            self._documents[url] = {"document": document, "path": path}
        cached = self._documents[url]
        return cached["document"], cached["path"]

    async def _t_endpoints(self, args: dict) -> str:
        from .endpoints import build_call, negative_call, operations, touched_operations

        target = self.target(args.get("target"), ("backend-api",))
        if target is None:
            return "Error: no API target in this project"
        if not self.url_of(target):
            return "Error: the API is not running — call verify_launch first"
        document, path = await self._document(target)
        if not document:
            return _json(
                {
                    "openapi": None,
                    "note": "the app publishes no OpenAPI document; read the controllers in the task's files and call verify_call_endpoint yourself",
                }
            )
        ops = operations(document)
        chosen = (
            ops
            if args.get("all")
            else touched_operations(
                ops, self.project_dir, self._changed_files(), target.root
            )
        )
        calls = []
        for op in chosen[:30]:
            call = build_call(op, document)
            call.pop("response_schema", None)
            negative = negative_call(op, document)
            calls.append(
                {"summary": op.summary, "call": call, "negative_call": negative}
            )
        return _json(
            {
                "openapi": path,
                "total_operations": len(ops),
                "touched": len(chosen) if not args.get("all") else None,
                "calls": calls,
                "note": ""
                if chosen
                else "no operation is served by a file this task changed; pass all=true to list every endpoint",
            }
        )

    async def _t_call_endpoint(self, args: dict) -> str:
        from .endpoints import call_endpoint, operations

        target = self.target(args.get("target"), ("backend-api", "web-frontend"))
        if target is None:
            return "Error: no API target"
        base = self.url_of(target)
        if not base:
            return "Error: the API is not running — call verify_launch first"
        expect = args.get("expect_status")
        if isinstance(expect, (int, str)) and str(expect).isdigit():
            expect = [int(expect)]
        elif isinstance(expect, list):
            expect = [int(e) for e in expect if str(e).isdigit()]
        else:
            expect = []
        method = str(args.get("method") or "GET").upper()
        path = str(args.get("path") or "/")
        document, _ = await self._document(target)
        schema = None
        if document:
            # The operation this call targets: its documented success status
            # when the caller named none, and the schema to check it against.
            route = path.split("?", 1)[0]
            for op in operations(document):
                pattern = (
                    "^" + re.sub(r"\\\{[^}]+\\\}", "[^/]+", re.escape(op.path)) + "$"
                )
                if op.method == method and re.match(pattern, route):
                    if not expect and op.expected_status:
                        expect = [op.expected_status]
                    if expect:
                        schema = op.responses.get(str(expect[0]))
                    break
        result = await asyncio.to_thread(
            call_endpoint,
            base,
            method,
            path,
            body=args.get("body"),
            headers=args.get("headers")
            if isinstance(args.get("headers"), dict)
            else None,
            expect_status=expect,
            response_schema=schema,
            document=document,
            allow_mutations=self.settings.allow_mutations,
        )
        data = result.to_dict()
        data["target"] = target.name
        append_event(self.base, "endpoint", data)
        return _json(data)

    async def _t_device(self, args: dict) -> str:
        action = str(args.get("action") or "devices")
        platform = args.get("platform")
        if action == "devices":
            from mobile.devices import list_devices

            listing = await asyncio.to_thread(
                list_devices, (platform,) if platform else None
            )
            return _json(listing.to_dict())
        from .mobile import verify_mobile

        results = await asyncio.to_thread(
            verify_mobile,
            self.project_dir,
            self.spec_dir,
            self.base,
            [platform] if platform else None,
            build=action == "launch",
        )
        for item in results:
            if item.frame:
                append_event(
                    self.base,
                    "screenshot",
                    {
                        "path": item.frame,
                        "label": f"{item.platform}: app launched",
                        "platform": item.platform,
                    },
                )
        return _json([r.to_dict() for r in results])

    async def _t_record(self, args: dict) -> str:
        kind = str(args.get("kind") or "")
        if kind not in ("confirm", "verdict", "fix", "step"):
            return "Error: kind must be confirm, verdict, fix or step"
        payload = {
            k: str(v)[:2000] for k, v in args.items() if k != "kind" and v is not None
        }
        if kind == "confirm":
            payload.setdefault("url", self._current_url)
        append_event(self.base, kind, payload)
        return f"Recorded ({kind})."


_TOOLBOXES: dict[tuple, VerifyToolbox] = {}


def toolbox_for(
    project_dir: Path | str, spec_dir: Path | str | None = None
) -> VerifyToolbox:
    """The toolbox of this project/spec in the running event loop."""
    try:
        loop_id = id(asyncio.get_running_loop())
    except RuntimeError:
        loop_id = 0
    key = (
        str(Path(project_dir).resolve()),
        str(Path(spec_dir).resolve()) if spec_dir else "",
        loop_id,
    )
    box = _TOOLBOXES.get(key)
    if box is None:
        box = VerifyToolbox(project_dir, spec_dir)
        _TOOLBOXES[key] = box
    return box


async def execute_tool(
    name: str,
    arguments: dict[str, Any],
    *,
    project_dir: Path | str,
    spec_dir: Path | str | None = None,
) -> str:
    """`tool_executor`'s entry point."""
    return await toolbox_for(project_dir, spec_dir).call(name, arguments)


async def close_toolboxes(project_dir: Path | str | None = None) -> None:
    """Close the browsers of the toolboxes (all, or one project's)."""
    wanted = str(Path(project_dir).resolve()) if project_dir else None
    for key in list(_TOOLBOXES):
        if wanted is None or key[0] == wanted:
            box = _TOOLBOXES.pop(key)
            await box.aclose()
