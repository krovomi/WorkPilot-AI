"""Azure AI Document Intelligence (`prebuilt-read`): the one engine that is not local.

It exists because some teams already pay for it, keep it in their own Azure
tenant, and read handwriting and dense scans far better with it than with any
local engine. It is also the one engine that sends the image off the machine,
so everything about it is opt-in and nothing about it is a default:

- it runs only when `DOCINTEL_OCR_ENGINE` names it **and** an endpoint and a
  key are configured — listing it alone does nothing;
- the chain refuses it under `airgapStrict` before it is asked anything, with
  a message naming both switches (`chain.py`);
- the Kanban preview never calls it (``preview = False``): opening a panel is
  not a reason to upload a screenshot, and it is metered.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .. import settings
from .base import OcrBox, OcrOutcome, http_opener

logger = logging.getLogger(__name__)

API_VERSION = "2024-11-30"
_TIMEOUT_SECONDS = 30
_POLL_SECONDS = 1.0
_MAX_POLLS = 60


def parse_analyze_result(payload: dict) -> tuple[str, list[OcrBox]]:
    """`analyzeResult` -> (text, word boxes). Words are assigned to the line
    whose span contains their offset, which is how the service links them."""
    result = payload.get("analyzeResult") or {}
    texts: list[str] = []
    boxes: list[OcrBox] = []
    for page in result.get("pages") or []:
        lines = page.get("lines") or []
        spans: list[tuple[int, int, int]] = []
        for line in lines:
            content = str(line.get("content") or "").strip()
            if not content:
                continue
            index = len(texts)
            texts.append(content)
            for span in line.get("spans") or []:
                start = int(span.get("offset", 0))
                spans.append((start, start + int(span.get("length", 0)), index))
        for word in page.get("words") or []:
            content = str(word.get("content") or "").strip()
            polygon = word.get("polygon") or []
            if not content or len(polygon) < 8:
                continue
            offset = int((word.get("span") or {}).get("offset", -1))
            line = next((i for s, e, i in spans if s <= offset < e), 0)
            xs, ys = polygon[0::2], polygon[1::2]
            left, top = int(min(xs)), int(min(ys))
            boxes.append(
                OcrBox(
                    text=content,
                    left=left,
                    top=top,
                    width=max(1, int(max(xs)) - left),
                    height=max(1, int(max(ys)) - top),
                    confidence=float(word.get("confidence", -0.01)) * 100,
                    line=line,
                )
            )
    return "\n".join(texts).strip(), boxes


def same_origin(url: str, endpoint: str) -> bool:
    """https, and the same host and port as the configured endpoint."""
    a, b = urllib.parse.urlparse(url), urllib.parse.urlparse(endpoint)
    return (
        a.scheme == "https"
        and b.scheme == "https"
        and (a.hostname or "").lower() == (b.hostname or "").lower()
        and bool(a.hostname)
        and (a.port or 443) == (b.port or 443)
    )


class AzureDocumentIntelligenceEngine:
    name = "azure-document-intelligence"
    local = False
    preview = False

    def available(self, env: dict[str, str]) -> str | None:
        endpoint, key = settings.azure_endpoint(env), settings.azure_key(env)
        if not endpoint or not key:
            return "not-configured"
        if not endpoint.startswith("https://"):
            # The key travels in a header: never over plain HTTP.
            return "not-configured"
        return None

    def recognize(self, image: Path, langs: str, env: dict[str, str]) -> OcrOutcome:
        if reason := self.available(env):
            return OcrOutcome(reason=reason, engine=self.name)
        endpoint, key = settings.azure_endpoint(env), settings.azure_key(env)
        url = (
            f"{endpoint.rstrip('/')}/documentintelligence/documentModels/"
            f"prebuilt-read:analyze?api-version={API_VERSION}"
        )
        opener = http_opener()
        try:
            request = urllib.request.Request(
                url,
                data=image.read_bytes(),
                headers={
                    "Ocp-Apim-Subscription-Key": key,
                    "Content-Type": "application/octet-stream",
                },
                method="POST",
            )
            with opener.open(request, timeout=_TIMEOUT_SECONDS) as response:
                location = response.headers.get("Operation-Location", "")
            if not same_origin(location, endpoint):
                # The poll carries the key: it goes back to the endpoint the
                # person configured, never to a host a response named.
                return OcrOutcome(reason="failed", engine=self.name)
            payload: dict = {}
            for _ in range(_MAX_POLLS):
                poll = urllib.request.Request(
                    location, headers={"Ocp-Apim-Subscription-Key": key}
                )
                with opener.open(poll, timeout=_TIMEOUT_SECONDS) as response:
                    payload = json.loads(
                        response.read().decode("utf-8", errors="replace")
                    )
                status = str(payload.get("status", "")).lower()
                if status in ("succeeded", "failed"):
                    break
                time.sleep(_POLL_SECONDS)
            else:
                return OcrOutcome(reason="timeout", engine=self.name)
        except TimeoutError:
            return OcrOutcome(reason="timeout", engine=self.name)
        except (OSError, ValueError, urllib.error.URLError):
            # Never log the exception text: an HTTPError can echo the request.
            logger.debug("docintel: %s request failed", self.name)
            return OcrOutcome(reason="failed", engine=self.name)

        if str(payload.get("status", "")).lower() != "succeeded":
            return OcrOutcome(reason="failed", engine=self.name)
        text, boxes = parse_analyze_result(payload)
        if not text:
            return OcrOutcome(reason="empty", engine=self.name)
        return OcrOutcome(text=text, engine=self.name, boxes=tuple(boxes))
