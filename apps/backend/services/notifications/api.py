"""Multi-channel notification service — API endpoints.

Mounted in provider_api.py. Used by the project settings UI to test a
webhook URL server-side (browser fetch would be blocked by CORS on most
webhook providers).

  POST /api/notifications/test   body: {"channel": "...", "url": "https://..."}
"""

from __future__ import annotations

import logging
import os
from typing import Annotated, Any

from fastapi import APIRouter, Body

from .channels import (
    build_text_payload,
    post_json,
    rejection_text,
    validate_webhook_url,
)
from .models import NotificationChannel

logger = logging.getLogger(__name__)

router = APIRouter()

_TEST_MESSAGES = {
    "en": "✅ WorkPilot AI — test notification. Your channel is configured correctly!",
    "fr": "✅ WorkPilot AI — notification de test. Votre canal est bien configuré !",
}


@router.post("/api/notifications/test")
def test_notification_webhook(body: Annotated[dict[str, Any], Body(...)]):
    """Send a test message to the given webhook URL."""
    try:
        channel = NotificationChannel(str(body.get("channel", "webhook")))
    except ValueError:
        return {"success": False, "error": f"Unknown channel: {body.get('channel')}"}

    url = str(body.get("url", "")).strip()
    try:
        validate_webhook_url(url)
    except ValueError as exc:
        # `rejection_text` rather than `safe_error`: both keep the exception
        # text out of the response, but this one names the rule that was
        # broken instead of flattening every rejection to "Invalid input".
        # Someone pasting a webhook URL needs to know *which* check refused it.
        logger.warning("[Notifications] webhook test rejected: %s", exc)
        return {"success": False, "error": rejection_text(exc)}

    lang = os.environ.get("APP_LANGUAGE", "en")
    message = _TEST_MESSAGES.get(lang, _TEST_MESSAGES["en"])
    payload = build_text_payload(channel, message)
    success, status_code, error = post_json(url, payload)
    return {"success": success, "status_code": status_code, "error": error}
