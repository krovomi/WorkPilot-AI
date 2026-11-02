"""The three channels a server "needs you" goes out on: ntfy, Telegram, Teams.

The same formats as the desktop's senders (``apps/frontend/src/main/needs-you/
channels.ts``), written again here because those are TypeScript and the
server imports no feature unit: an ntfy POST of plain text with the title as
a query parameter, a Telegram ``sendMessage`` in plain text, a minimal
Adaptive Card to a Teams incoming webhook or Workflows URL.

Every destination is a person's input and the server posts to it, so each is
checked twice (security rule S1, and SSRF):

- **When it is saved**: ``https`` only, port 443, no credentials in the URL,
  a host name rather than an address; Teams only on Microsoft's webhook
  hosts, Telegram only on ``api.telegram.org``.
- **When it is sent**: the host is resolved once, every address must be
  public, and the request goes to that address (TLS still checks the name):
  a DNS answer that changes between the check and the connection reaches
  nothing new. A redirect is a failure, never followed.

A topic, a token and a webhook URL are secrets: nothing here logs a URL, a
header or an exception text, only the channel and what kind of failure.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx

logger = logging.getLogger(__name__)

CHANNELS: tuple[str, ...] = ("ntfy", "telegram", "teams")

NTFY_TOPIC = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PUBLIC_NTFY = "https://ntfy.sh"
PUBLIC_NTFY_HOST = "ntfy.sh"
#: On the public server the topic is the only secret: a short one is guessed.
PUBLIC_TOPIC_MIN = 16
TELEGRAM_BOT_TOKEN = re.compile(r"^\d{3,20}:[A-Za-z0-9_-]{20,64}$")
TELEGRAM_CHAT_ID = re.compile(r"^-?\d{1,20}$")
TELEGRAM_API = "https://api.telegram.org"
#: Where Teams incoming webhooks and Workflows (Power Automate) URLs live.
TEAMS_HOST_SUFFIXES: tuple[str, ...] = (
    ".webhook.office.com",
    ".logic.azure.com",
    ".api.powerplatform.com",
)
MAX_URL_LENGTH = 2048
TIMEOUT_SECONDS = 10

#: Why a destination was refused, in words a caller may read. The key
#: travels; never an exception's text, which could quote the secret.
REJECTIONS: dict[str, str] = {
    "url": "Not a valid https URL",
    "scheme": "Only https URLs are allowed",
    "credentials": "A URL may not carry a user name or password",
    "port": "Only the standard https port is allowed",
    "address": "Use a host name, not an IP address",
    "teams_host": "Not a Microsoft Teams webhook or Workflows URL",
    "topic": "Invalid ntfy topic",
    "short_topic": "On ntfy.sh, a topic needs at least 16 characters",
    "access_token": "Invalid ntfy access token",
    "bot_token": "Invalid Telegram bot token",
    "chat_id": "Invalid Telegram chat id",
    "private": "The host resolves to a private or reserved address",
    "unresolvable": "The host could not be resolved",
}


class ChannelRejected(ValueError):
    """A destination refused, named by a key into :data:`REJECTIONS`."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(REJECTIONS.get(reason, reason))


Resolver = Callable[[str], Awaitable[list[str]]]


@dataclass(frozen=True)
class Message:
    title: str
    body: str


# ── What is checked when a destination is saved ────────────────────────────


def _https_url(raw: object) -> tuple[str, str]:
    """``(normalised url, host)`` for a URL the server may post to."""
    if not isinstance(raw, str) or not raw.strip() or len(raw) > MAX_URL_LENGTH:
        raise ChannelRejected("url")
    try:
        parts = urlsplit(raw.strip())
        port = parts.port
    except ValueError:
        raise ChannelRejected("url") from None
    if parts.scheme.lower() != "https":
        raise ChannelRejected("scheme")
    if parts.username is not None or parts.password is not None:
        raise ChannelRejected("credentials")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host or any(c.isspace() for c in raw.strip()):
        raise ChannelRejected("url")
    if port not in (None, 443):
        raise ChannelRejected("port")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ChannelRejected("address")
    if "." not in host:
        # "localhost", "intranet": a name only a private resolver answers.
        raise ChannelRejected("private")
    normalised = urlunsplit(("https", host, parts.path, parts.query, ""))
    return normalised, host


def validate_ntfy(server_url: object, topic: object) -> str:
    """The ntfy server's base URL, once the server and the topic pass."""
    server, host = _https_url(server_url or PUBLIC_NTFY)
    if urlsplit(server).query:
        raise ChannelRejected("url")
    if not isinstance(topic, str) or not NTFY_TOPIC.match(topic):
        raise ChannelRejected("topic")
    if host == PUBLIC_NTFY_HOST and len(topic) < PUBLIC_TOPIC_MIN:
        raise ChannelRejected("short_topic")
    return server.rstrip("/")


def validate_telegram(bot_token: object, chat_id: object) -> str:
    """The chat id, as text, once the token and the chat pass."""
    if not isinstance(bot_token, str) or not TELEGRAM_BOT_TOKEN.match(bot_token):
        raise ChannelRejected("bot_token")
    chat = str(chat_id).strip() if isinstance(chat_id, (str, int)) else ""
    if not TELEGRAM_CHAT_ID.match(chat):
        raise ChannelRejected("chat_id")
    return chat


def validate_teams(webhook_url: object) -> str:
    url, host = _https_url(webhook_url)
    if not host.endswith(TEAMS_HOST_SUFFIXES):
        raise ChannelRejected("teams_host")
    return url


# ── What is checked when it is sent ────────────────────────────────────────


def _public(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


async def system_resolver(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(
        host, 443, type=socket.SOCK_STREAM
    )
    return [str(info[4][0]) for info in infos]


async def _pinned(host: str, resolver: Resolver) -> str:
    """One public address of `host`; every address it has must be public."""
    try:
        addresses = await resolver(host)
    except OSError:
        raise ChannelRejected("unresolvable") from None
    if not addresses:
        raise ChannelRejected("unresolvable")
    if not all(_public(a) for a in addresses):
        raise ChannelRejected("private")
    address = addresses[0].split("%", 1)[0]
    return f"[{address}]" if ":" in address else address


async def post(
    client: httpx.AsyncClient,
    url: str,
    *,
    resolver: Resolver = system_resolver,
    **kwargs,
) -> httpx.Response:
    """POST to `url` on the address checked here, never following a redirect."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    netloc = await _pinned(host, resolver)
    pinned = urlunsplit(("https", netloc, parts.path, parts.query, ""))
    headers = {**kwargs.pop("headers", {}), "Host": host}
    return await client.post(
        pinned,
        headers=headers,
        extensions={"sni_hostname": host},
        follow_redirects=False,
        **kwargs,
    )


# ── The three senders ──────────────────────────────────────────────────────


async def send_ntfy(
    client: httpx.AsyncClient,
    server: str,
    topic: str,
    access_token: str | None,
    message: Message,
    resolver: Resolver = system_resolver,
) -> bool:
    # The title as a query parameter: a header cannot carry its UTF-8.
    query = urlencode(
        {"title": message.title[:200], "tags": "robot", "priority": "high"}
    )
    headers = {"Content-Type": "text/plain; charset=utf-8"}
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    response = await post(
        client,
        f"{server.rstrip('/')}/{topic}?{query}",
        resolver=resolver,
        headers=headers,
        content=message.body.encode("utf-8"),
    )
    return response.is_success


async def send_telegram(
    client: httpx.AsyncClient,
    bot_token: str,
    chat_id: str,
    message: Message,
    resolver: Resolver = system_resolver,
) -> bool:
    response = await post(
        client,
        f"{TELEGRAM_API}/bot{bot_token}/sendMessage",
        resolver=resolver,
        json={
            "chat_id": chat_id,
            # Plain text: a project's name is people's text, not markup.
            "text": f"{message.title}\n{message.body}",
            "disable_web_page_preview": True,
        },
    )
    if not response.is_success:
        return False
    try:
        return bool(response.json().get("ok"))
    except ValueError:
        return False


def teams_card(message: Message) -> dict:
    return {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": [
                        {
                            "type": "TextBlock",
                            "text": message.title,
                            "weight": "Bolder",
                            "wrap": True,
                        },
                        {"type": "TextBlock", "text": message.body, "wrap": True},
                    ],
                },
            }
        ],
    }


async def send_teams(
    client: httpx.AsyncClient,
    webhook_url: str,
    message: Message,
    resolver: Resolver = system_resolver,
) -> bool:
    response = await post(
        client, webhook_url, resolver=resolver, json=teams_card(message)
    )
    return response.is_success


async def deliver(
    channel: str,
    settings: dict,
    secrets: dict,
    message: Message,
    *,
    client: httpx.AsyncClient | None = None,
    resolver: Resolver = system_resolver,
) -> str:
    """Send on one channel; ``"sent"``, ``"refused"``, ``"blocked"`` or
    ``"unreachable"``. Never raises for the network, and logs no secret."""
    owned = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT_SECONDS)
    try:
        if channel == "ntfy":
            ok = await send_ntfy(
                client,
                str(settings.get("server") or PUBLIC_NTFY),
                str(secrets.get("topic") or ""),
                secrets.get("access_token") or None,
                message,
                resolver,
            )
        elif channel == "telegram":
            ok = await send_telegram(
                client,
                str(secrets.get("bot_token") or ""),
                str(settings.get("chat_id") or ""),
                message,
                resolver,
            )
        elif channel == "teams":
            ok = await send_teams(
                client, str(secrets.get("webhook_url") or ""), message, resolver
            )
        else:
            return "blocked"
    except ChannelRejected as e:
        logger.warning("Needs-you %s not sent: %s", channel, e.reason)
        return "blocked"
    except (httpx.HTTPError, OSError) as e:
        # The type only: an httpx error's text carries the URL, and the
        # URL carries the token or the webhook's key.
        logger.warning("Needs-you %s not sent: %s", channel, type(e).__name__)
        return "unreachable"
    finally:
        if owned:
            await client.aclose()
    if not ok:
        logger.warning("Needs-you %s not sent: refused by the service", channel)
        return "refused"
    return "sent"
