"""A Figma mockup linked to a task: its frames and their labels, read from the API.

A mockup reached the agents as a PNG export, and OCR read it back — `Commande`
as `Cornmande`, a button label merged with the one beside it, the frame it
belonged to lost. The Figma file already holds all of it as data: frames by
name, and every text layer's exact characters. Reading that is the
"structured first" rule applied to the one design tool with an API.

**The contract with the visual review** (the mockup / rendering comparison is
`visual_qa.py`'s job, through `labels.load_figma`) is one file per linked
mockup, ``<spec_dir>/attachments/<name>.figma.json``::

    {"source": "figma", "file_key": "…",
     "frames": [{"id": "…", "name": "…", "texts": ["Libellé 1", "…"]}]}

Anything that reads ``*.figma.json`` among the attachments reads that shape,
and nothing else is added to it: a field only one reader understands is how
two readers of one file start to disagree.

What is written has been through docintel's protection first, because the file
is read by later phases as it is: every label masked by the secret patterns
(`redact`), and every frame scanned by `injection_guard` — a frame whose labels
read like an instruction is left out of the file and counted, since a label in
a mockup is exactly where somebody else's text reaches a prompt.

**The token stays where the other integrations' do**: `FIGMA_ACCESS_TOKEN` in
the project's `.workpilot/.env` (written by the desktop app's main process,
never sent to its renderer) or the environment. It is sent to
``api.figma.com`` and nowhere else — the host is a constant, the link only
gives a file key and node ids, both matched by character class.

**A Figma call is a cloud call.** Under `airgapStrict` the import is refused,
like a cloud OCR engine: the policy says nothing leaves the machine, and a
request carrying a file key and a token does.

Nothing here raises: every failure is a ``reason`` on the result.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from . import redact, settings
from .files import clean, threat, writable

logger = logging.getLogger(__name__)

SUFFIX = ".figma.json"
TOKEN_ENV = "FIGMA_ACCESS_TOKEN"
API_BASE = "https://api.figma.com/v1"
MAX_RESPONSE_BYTES = 30 * 1024 * 1024
MAX_FRAMES = 50
MAX_TEXTS = 200
MAX_TEXT_CHARS = 300
#: The node types a designer draws a screen as.
FRAME_TYPES = {"FRAME", "COMPONENT", "COMPONENT_SET", "SECTION", "INSTANCE", "GROUP"}

_HOSTS = {"figma.com", "www.figma.com"}
_KEY = re.compile(r"^[A-Za-z0-9]{8,128}$")
_NODE = re.compile(r"^\d+[:-]\d+$")
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")

Fetch = Callable[[str, str], dict]


@dataclass
class FigmaImport:
    #: ``imported``, or why not: ``invalid-url``, ``no-token``, ``airgap``,
    #: ``http-403``, ``network``, ``too-large``, ``empty``, ``injection``,
    #: ``secret-scan-unavailable``, ``unwritable``.
    status: str
    path: str = ""
    file_key: str = ""
    frames: int = 0
    texts: int = 0
    #: Frames left out because `injection_guard` flagged their labels.
    withheld: int = 0
    #: Kinds of secret masked in the labels, never a value.
    secrets: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def parse_url(url: str) -> tuple[str, list[str]] | None:
    """(file key, node ids) of a Figma link, or None.

    The host is checked on the parsed URL, not searched for in the string:
    ``https://evil.test/?figma.com/file/…`` is not a Figma link.
    """
    try:
        parts = urllib.parse.urlsplit(str(url or "").strip())
    except ValueError:
        return None
    if parts.scheme != "https" or (parts.hostname or "").lower() not in _HOSTS:
        return None
    segments = [s for s in parts.path.split("/") if s]
    if len(segments) < 2 or segments[0] not in ("file", "design", "proto", "board"):
        return None
    key = segments[1]
    if not _KEY.match(key):
        return None
    ids: list[str] = []
    for value in urllib.parse.parse_qs(parts.query).get("node-id", []):
        for node in value.split(","):
            node = node.strip()
            if _NODE.match(node):
                ids.append(node.replace("-", ":"))
    return key, ids


def _texts(node: Any, out: list[str], seen: set[str]) -> None:
    """Every visible text layer under `node`, in document order, each once."""
    if not isinstance(node, dict) or node.get("visible") is False:
        return
    if len(out) >= MAX_TEXTS:
        return
    if node.get("type") == "TEXT":
        text = " ".join(str(node.get("characters") or "").split())
        if text and text not in seen:
            seen.add(text)
            out.append(text[:MAX_TEXT_CHARS])
    for child in node.get("children") or []:
        _texts(child, out, seen)


def _frame(node: dict) -> dict:
    texts: list[str] = []
    _texts(node, texts, set())
    return {
        "id": str(node.get("id") or ""),
        "name": str(node.get("name") or "")[:MAX_TEXT_CHARS],
        "texts": texts,
    }


def _screens(node: Any) -> list[dict]:
    """The frames a node stands for: a page's top-level frames, else itself."""
    if not isinstance(node, dict) or node.get("visible") is False:
        return []
    kind = node.get("type")
    if kind in ("DOCUMENT", "CANVAS"):
        found: list[dict] = []
        for child in node.get("children") or []:
            found.extend(_screens(child))
        return found
    return [node]


def frames_from_payload(payload: Any) -> tuple[str, list[dict]]:
    """(file name, frames) of a `/files/:key` or `/files/:key/nodes` answer."""
    if not isinstance(payload, dict):
        return "", []
    roots: list[Any] = []
    if isinstance(payload.get("nodes"), dict):
        roots = [
            entry.get("document")
            for entry in payload["nodes"].values()
            if isinstance(entry, dict)
        ]
    elif isinstance(payload.get("document"), dict):
        roots = [payload["document"]]
    frames: list[dict] = []
    for root in roots:
        for node in _screens(root):
            if node.get("type") in FRAME_TYPES or node.get("type") == "TEXT":
                frame = _frame(node)
                if frame["texts"] or frame["name"]:
                    frames.append(frame)
            if len(frames) >= MAX_FRAMES:
                break
    return str(payload.get("name") or ""), frames[:MAX_FRAMES]


def protect(frames: list[dict]) -> tuple[list[dict], int, list[str]]:
    """Masked labels, and the frames `injection_guard` let through.

    Raises `redact.ScannerUnavailable`: "could not check" is not "clean".
    """
    kept: list[dict] = []
    withheld = 0
    kinds: set[str] = set()
    for frame in frames:
        masked: list[str] = []
        for text in frame.get("texts") or []:
            value, found = redact.redact_text(clean(str(text)))
            kinds.update(found)
            if value.strip():
                masked.append(value.strip())
        name, found = redact.redact_text(clean(str(frame.get("name") or "")))
        kinds.update(found)
        joined = "\n".join([name, *masked])
        if threat(joined, source="figma") != "safe":
            withheld += 1
            continue
        kept.append({"id": str(frame.get("id") or ""), "name": name, "texts": masked})
    return kept, withheld, sorted(kinds)


def _airgapped(policy_paths: tuple[Path, ...]) -> bool:
    try:
        from core.offline_policy import airgap_status

        return bool(airgap_status(*policy_paths).get("airgapStrict"))
    except Exception:  # noqa: BLE001 - unreadable policy: fail closed
        return True


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect instead of following it.

    `urllib` copies a request's custom headers onto the request that follows a
    redirect, whatever its host: a 3xx from the API would carry
    ``X-Figma-Token`` wherever ``Location`` points. The REST API answers
    directly, so a redirect is reported (``http-3xx``) rather than followed.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def fetch_file(file_key: str, token: str, node_ids: list[str]) -> dict:
    """The file (or the linked nodes) from the REST API. Raises on failure."""
    url = f"{API_BASE}/files/{file_key}"
    if node_ids:
        url += "/nodes?" + urllib.parse.urlencode({"ids": ",".join(node_ids)})
    request = urllib.request.Request(  # noqa: S310 - https, constant host
        url, headers={"X-Figma-Token": token, "Accept": "application/json"}
    )
    with _OPENER.open(request, timeout=30) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise OverflowError("too-large")
    return json.loads(body.decode("utf-8"))


def _attachment_target(spec_dir: Path, name: str) -> Path | None:
    """`<spec_dir>/attachments/<name>`, or None if it would leave that folder.

    The name is already reduced to ``[A-Za-z0-9._-]``; this is the
    normalise-then-prefix check on top of it, so the confinement does not rest
    on a regex alone.
    """
    base = os.path.normpath(os.path.join(os.path.abspath(spec_dir), "attachments"))
    full = os.path.normpath(os.path.join(base, name))
    if not full.startswith(base + os.sep):
        return None
    return Path(full)


def _target_name(file_name: str, file_key: str) -> str:
    stem = _UNSAFE.sub("-", file_name).strip("-.")[:60] or file_key
    return f"{stem}{SUFFIX}"


def import_figma(
    spec_dir: Path,
    project_dir: Path | None,
    url: str,
    *,
    fetch: Fetch | None = None,
) -> FigmaImport:
    """Read the linked mockup and write it as the task's ``.figma.json``."""
    parsed = parse_url(url)
    if parsed is None:
        return FigmaImport(status="invalid-url")
    file_key, node_ids = parsed
    token = settings.read_keys(project_dir, (TOKEN_ENV,)).get(TOKEN_ENV, "").strip()
    if not token:
        return FigmaImport(status="no-token", file_key=file_key)
    policy = tuple(Path(p) for p in (spec_dir, project_dir) if p is not None)
    if _airgapped(policy):
        return FigmaImport(status="airgap", file_key=file_key)

    try:
        payload = (fetch or _fetch_with_node_ids(node_ids))(file_key, token)
    except urllib.error.HTTPError as exc:
        return FigmaImport(status=f"http-{exc.code}", file_key=file_key)
    except OverflowError:
        return FigmaImport(status="too-large", file_key=file_key)
    except Exception:  # noqa: BLE001 - network, JSON: the card says so
        logger.debug("docintel: Figma fetch failed", exc_info=True)
        return FigmaImport(status="network", file_key=file_key)

    name, frames = frames_from_payload(payload)
    if not frames:
        return FigmaImport(status="empty", file_key=file_key)
    try:
        kept, withheld, kinds = protect(frames)
    except redact.ScannerUnavailable:
        return FigmaImport(status="secret-scan-unavailable", file_key=file_key)
    result = FigmaImport(
        status="imported",
        file_key=file_key,
        frames=len(kept),
        texts=sum(len(f["texts"]) for f in kept),
        withheld=withheld,
        secrets=kinds,
    )
    if not kept:
        result.status = "injection"
        return result

    target = _attachment_target(Path(spec_dir), _target_name(name, file_key))
    if target is None or not writable(target, Path(spec_dir)):
        result.status = "unwritable"
        return result
    document = {"source": "figma", "file_key": file_key, "frames": kept}
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(document, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError:
        result.status = "unwritable"
        return result
    result.path = target.relative_to(spec_dir).as_posix()
    return result


def _fetch_with_node_ids(node_ids: list[str]) -> Fetch:
    return lambda key, token: fetch_file(key, token, node_ids)


# ---------------------------------------------------------------------------
# Reading the contract back: the preflight
# ---------------------------------------------------------------------------


def is_figma_file(path: Path) -> bool:
    return path.name.lower().endswith(SUFFIX)


def read_figma(text: str) -> dict | None:
    """The contract's document, reduced to its fields, or None.

    Whoever wrote the file, only ``source``, ``file_key`` and the frames'
    ``id``, ``name`` and ``texts`` are read — within the same caps as an
    import — so a hand-edited file cannot smuggle anything past the shape.
    """
    try:
        payload = json.loads(text)
    except ValueError:
        return None
    if not isinstance(payload, dict) or payload.get("source") != "figma":
        return None
    frames = payload.get("frames")
    if not isinstance(frames, list):
        return None
    out: list[dict] = []
    for frame in frames[:MAX_FRAMES]:
        if not isinstance(frame, dict):
            continue
        texts = [
            str(t)[:MAX_TEXT_CHARS]
            for t in (frame.get("texts") or [])[:MAX_TEXTS]
            if isinstance(t, (str, int, float)) and str(t).strip()
        ]
        out.append(
            {
                "id": str(frame.get("id") or "")[:64],
                "name": str(frame.get("name") or "")[:MAX_TEXT_CHARS],
                "texts": texts,
            }
        )
    return {
        "source": "figma",
        "file_key": str(payload.get("file_key") or "")[:128],
        "frames": out,
    }


def render_figma(document: dict) -> str:
    """The labels as text a model reads: one heading per frame."""
    lines = [f"Figma mockup (file {document.get('file_key') or '?'})"]
    for frame in document.get("frames") or []:
        lines.append("")
        lines.append(f"## Frame: {frame.get('name') or frame.get('id') or '?'}")
        lines.extend(f"- {text}" for text in frame.get("texts") or [])
    return "\n".join(lines).strip()
