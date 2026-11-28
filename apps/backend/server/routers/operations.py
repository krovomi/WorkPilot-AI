"""What the server's operator watches: its health page and its metrics.

- ``GET /admin/platform/health`` (platform administrators): every check of
  ``services/server_health.py``, the answer ``/health`` gives in one word.
- ``GET /metrics``: the Prometheus text format (``services/metrics.py``), for
  a scraper that sends ``Authorization: Bearer <WORKPILOT_METRICS_TOKEN>``.
  No account opens it: without the variable (or with one shorter than 32
  characters) it answers 404, with a wrong token 401. The token is compared
  in constant time and never logged.
"""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from server.authz.deps import require_platform_admin
from server.config import get_settings
from server.db.engine import get_db
from server.services import metrics, server_health
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(tags=["operations"])

#: The shortest metrics token the server accepts.
MIN_TOKEN = 32


@router.get(
    "/admin/platform/health",
    dependencies=[Depends(require_platform_admin)],
)
async def health_page(db: AsyncSession = Depends(get_db)) -> dict:
    return await server_health.report(db)


@router.get("/metrics", include_in_schema=False)
async def read_metrics(
    request: Request, db: AsyncSession = Depends(get_db)
) -> Response:
    expected = get_settings().metrics_token
    if len(expected) < MIN_TOKEN:
        raise HTTPException(status_code=404, detail="Not Found")
    sent = request.headers.get("authorization", "")
    given = sent[7:] if sent.startswith("Bearer ") else ""
    if not hmac.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(
            status_code=401,
            detail="Invalid metrics token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return Response(content=await metrics.render(db), media_type=metrics.CONTENT_TYPE)
