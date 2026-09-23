"""One bounded request to the fixed TypeSafe endpoint; no retries or redirects."""

from __future__ import annotations

import asyncio
import json

import httpx

from .models import BypassReason

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
MAX_RESPONSE_BYTES = 256 * 1024


class JevRequestError(Exception):
    def __init__(self, reason: BypassReason) -> None:
        self.reason = reason
        super().__init__(reason)


def _invalid_constant(value: str) -> None:
    raise ValueError("non-finite JSON")


class JevClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport

    @staticmethod
    def check_status(status: int) -> None:
        if status in (401, 403):
            raise JevRequestError("unauthorized")
        if status == 429:
            raise JevRequestError("rate_limited")
        if status != 200:
            raise JevRequestError("unavailable")

    async def post(self, *, key: str, payload: dict, timeout_seconds: float) -> dict:
        try:
            async with asyncio.timeout(timeout_seconds):
                async with httpx.AsyncClient(
                    transport=self.transport, follow_redirects=False, trust_env=False
                ) as http:
                    async with http.stream(
                        "POST",
                        ENDPOINT,
                        headers={"Authorization": f"Bearer {key}"},
                        json=payload,
                    ) as response:
                        self.check_status(response.status_code)
                        body = bytearray()
                        async for chunk in response.aiter_bytes():
                            if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                                raise JevRequestError("invalid_response")
                            body.extend(chunk)
                try:
                    result = json.loads(body, parse_constant=_invalid_constant)
                except (ValueError, UnicodeError, RecursionError):
                    raise JevRequestError("invalid_response") from None
                if not isinstance(result, dict):
                    raise JevRequestError("invalid_response")
                return result
        except (TimeoutError, httpx.TimeoutException):
            raise JevRequestError("timeout") from None
        except httpx.HTTPError:
            raise JevRequestError("unavailable") from None
        except (ValueError, UnicodeError):
            raise JevRequestError("invalid_response") from None
