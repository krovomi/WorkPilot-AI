"""A GitHub and a GitLab for the apps' end-to-end specs, on the loopback.

The server's forge relay (``shared_features/forge.py``, ``forge_gitlab.py``)
calls ``https://api.github.com`` and ``https://<gitlab host>/api/v4`` with the
token a person stored on the server. Those URLs are written in the server's
code, and a spec must not change them: the relay is what it tests. So the
spec's server reaches the real names through a proxy, as a server behind a
company proxy does, and the proxy is this module:

- it answers ``CONNECT api.github.com:443`` and ``CONNECT gitlab.e2e.test:443``
  (any other host is refused), ends the TLS session itself with a certificate
  of a certificate authority drawn for the run, and answers the calls of the
  apps' forge views with a small fixed repository: two issues, one pull or
  merge request;
- the server trusts that authority through ``SSL_CERT_FILE`` and goes through
  the proxy through ``HTTPS_PROXY`` (``env()``), the loopback excepted;
- ``git clone https://github.com/...`` of the project goes to the spec's
  local repository through ``url.<local>.insteadOf`` (``git_env()``).

Every call is recorded (method, host, path, a SHA-256 prefix of the token it
carried, the body of a write), and a plain ``GET /calls`` on the proxy's own
address gives the list: the spec checks who the forge saw without any token
being written out. Nothing here is kept: the certificates live in the run's
temporary directory.
"""

from __future__ import annotations

import datetime
import hashlib
import http.server
import ipaddress
import json
import ssl
import threading
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

GITHUB_HOST = "api.github.com"
GITLAB_HOST = "gitlab.e2e.test"
HOSTS = frozenset({GITHUB_HOST, GITLAB_HOST})

GITHUB_REPO = "e2e-team/team-site"
GITLAB_PROJECT = "e2e-team/team-docs"
GITHUB_CLONE_URL = f"https://github.com/{GITHUB_REPO}.git"
GITLAB_CLONE_URL = f"https://{GITLAB_HOST}/{GITLAB_PROJECT}.git"

#: When the fixed repository's issues and requests were opened and updated.
_OPENED = "2026-11-01T09:00:00Z"
_UPDATED = "2026-11-10T16:30:00Z"
_MAX_BODY = 1_000_000


def token_tag(token: str) -> str:
    """What the forge keeps of a token it was sent: enough to tell whose."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


# --- certificates ----------------------------------------------------------


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def write_certificates(directory: Path) -> tuple[Path, Path, Path]:
    """A certificate authority drawn for this run and the proxy's certificate
    for the forges' names, signed by it: ``(ca.pem, cert.pem, key.pem)``."""
    now = datetime.datetime.now(datetime.UTC)
    start, end = now - datetime.timedelta(hours=1), now + datetime.timedelta(days=1)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_ski = x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key())
    ca = (
        x509.CertificateBuilder()
        .subject_name(_name("WorkPilot E2E forge CA"))
        .issuer_name(_name("WorkPilot E2E forge CA"))
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start)
        .not_valid_after(end)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(ca_ski, critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    key = ec.generate_private_key(ec.SECP256R1())
    leaf = (
        x509.CertificateBuilder()
        .subject_name(_name(GITHUB_HOST))
        .issuer_name(ca.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start)
        .not_valid_after(end)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
        )
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName(host) for host in sorted(HOSTS)]
                + [x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
            ),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_subject_key_identifier(ca_ski),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    directory.mkdir(parents=True, exist_ok=True)
    ca_file, cert_file, key_file = (
        directory / "ca.pem",
        directory / "cert.pem",
        directory / "key.pem",
    )
    ca_file.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    cert_file.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_file.chmod(0o600)
    return ca_file, cert_file, key_file


# --- the fixed repository --------------------------------------------------


def _user_id(name: str) -> int:
    """A stable id for a user name (``hash()`` changes with each process)."""
    return int(hashlib.sha256(name.encode("utf-8")).hexdigest()[:6], 16)


def _github_user(login: str) -> dict[str, Any]:
    return {
        "login": login,
        "id": _user_id(login),
        "avatar_url": "",
        "html_url": f"https://github.com/{login}",
        "type": "User",
    }


GITHUB_ISSUES: list[dict[str, Any]] = [
    {
        "number": 7,
        "title": "The onboarding guide is missing",
        "body": "New teammates have nothing to read on their first day.",
        "labels": [{"id": 1, "name": "docs", "color": "0075ca", "description": ""}],
        "author": "dana",
        "comments": [
            {
                "id": 701,
                "author": "erin",
                "body": "A short page in docs/ would already help.",
            }
        ],
    },
    {
        "number": 8,
        "title": "Greeting fails for an empty team",
        "body": "`hello()` should not crash when nobody is there.",
        "labels": [{"id": 2, "name": "bug", "color": "d73a4a", "description": ""}],
        "author": "erin",
        "comments": [],
    },
]

GITHUB_PULL: dict[str, Any] = {
    "number": 12,
    "title": "Add a welcome banner",
    "body": "Shows the team's name at the top of the page.",
    "author": "erin",
    "head": "feat/welcome-banner",
    "base": "main",
    "sha": "4c2f9e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f",
}

GITLAB_ISSUES: list[dict[str, Any]] = [
    {
        "iid": 3,
        "title": "Write the release checklist",
        "description": "Every release should follow the same steps.",
        "labels": ["docs"],
        "author": "frank",
    }
]

GITLAB_MERGE_REQUEST: dict[str, Any] = {
    "iid": 5,
    "title": "Document the deploy steps",
    "description": "A first page for the operations guide.",
    "author": "frank",
    "source_branch": "docs/deploy",
    "target_branch": "main",
}


def _issue_json(issue: dict[str, Any]) -> dict[str, Any]:
    number = issue["number"]
    return {
        "id": 1000 + number,
        "node_id": f"I_{number}",
        "number": number,
        "title": issue["title"],
        "body": issue["body"],
        "state": "open",
        "locked": False,
        "user": _github_user(issue["author"]),
        "labels": issue["labels"],
        "assignees": [],
        "assignee": None,
        "milestone": None,
        "comments": len(issue["comments"]),
        "created_at": _OPENED,
        "updated_at": _UPDATED,
        "closed_at": None,
        "html_url": f"https://github.com/{GITHUB_REPO}/issues/{number}",
        "url": f"https://{GITHUB_HOST}/repos/{GITHUB_REPO}/issues/{number}",
        "repository_url": f"https://{GITHUB_HOST}/repos/{GITHUB_REPO}",
    }


def _comment_json(comment: dict[str, Any], number: int) -> dict[str, Any]:
    return {
        "id": comment["id"],
        "body": comment["body"],
        "user": _github_user(comment["author"]),
        "created_at": _UPDATED,
        "updated_at": _UPDATED,
        "html_url": f"https://github.com/{GITHUB_REPO}/issues/{number}"
        f"#issuecomment-{comment['id']}",
    }


def _pull_json() -> dict[str, Any]:
    pull = GITHUB_PULL
    return {
        "id": 2000 + pull["number"],
        "number": pull["number"],
        "title": pull["title"],
        "body": pull["body"],
        "state": "open",
        "draft": False,
        "merged": False,
        "mergeable": True,
        "mergeable_state": "clean",
        "user": _github_user(pull["author"]),
        "head": {"ref": pull["head"], "sha": pull["sha"], "label": pull["head"]},
        "base": {"ref": pull["base"], "sha": "0" * 40, "label": pull["base"]},
        "additions": 12,
        "deletions": 3,
        "changed_files": 1,
        "assignees": [],
        "requested_reviewers": [],
        "labels": [],
        "created_at": _OPENED,
        "updated_at": _UPDATED,
        "html_url": f"https://github.com/{GITHUB_REPO}/pull/{pull['number']}",
    }


_PULL_DIFF = (
    "diff --git a/app.py b/app.py\n"
    "--- a/app.py\n+++ b/app.py\n"
    "@@ -1,2 +1,5 @@\n"
    " def hello() -> str:\n     return 'hi'\n"
    "+\n+\n+def banner(team: str) -> str:\n+    return f'Welcome, {team}!'\n"
)


def _gitlab_user(username: str) -> dict[str, Any]:
    return {
        "id": _user_id(username),
        "username": username,
        "name": username.capitalize(),
        "avatar_url": "",
        "web_url": f"https://{GITLAB_HOST}/{username}",
        "state": "active",
    }


def _gitlab_issue_json(issue: dict[str, Any]) -> dict[str, Any]:
    iid = issue["iid"]
    return {
        "id": 3000 + iid,
        "iid": iid,
        "project_id": 42,
        "title": issue["title"],
        "description": issue["description"],
        "state": "opened",
        "labels": issue["labels"],
        "author": _gitlab_user(issue["author"]),
        "assignees": [],
        "assignee": None,
        "milestone": None,
        "user_notes_count": 0,
        "created_at": _OPENED,
        "updated_at": _UPDATED,
        "closed_at": None,
        "web_url": f"https://{GITLAB_HOST}/{GITLAB_PROJECT}/-/issues/{iid}",
    }


def _gitlab_mr_json() -> dict[str, Any]:
    mr = GITLAB_MERGE_REQUEST
    return {
        "id": 4000 + mr["iid"],
        "iid": mr["iid"],
        "project_id": 42,
        "title": mr["title"],
        "description": mr["description"],
        "state": "opened",
        "draft": False,
        "merge_status": "can_be_merged",
        "detailed_merge_status": "mergeable",
        "author": _gitlab_user(mr["author"]),
        "assignees": [],
        "reviewers": [],
        "labels": [],
        "source_branch": mr["source_branch"],
        "target_branch": mr["target_branch"],
        "sha": "9" * 40,
        "user_notes_count": 0,
        "created_at": _OPENED,
        "updated_at": _UPDATED,
        "web_url": f"https://{GITLAB_HOST}/{GITLAB_PROJECT}/-/merge_requests/{mr['iid']}",
    }


# --- the proxy and the two APIs ---------------------------------------------


class _Answer:
    def __init__(
        self,
        status: int,
        body: Any = None,
        *,
        text: str | None = None,
        total: int | None = None,
    ) -> None:
        self.status, self.body, self.text, self.total = status, body, text, total


_NOT_FOUND = _Answer(404, {"message": "Not Found"})


def _first_page(query: str) -> bool:
    """Whether a list call asks for its first page: the fixed lists fit in
    one, and a later page is empty, as the forges answer past the end."""
    page = parse_qs(query).get("page", ["1"])[0]
    return page in ("", "1")


def _github(method: str, path: str, body: Any, query: str = "") -> _Answer:
    prefix = f"/repos/{GITHUB_REPO}"
    if method == "POST" and path == "/graphql":
        pull = GITHUB_PULL
        node = {
            "number": pull["number"],
            "title": pull["title"],
            "body": pull["body"],
            "state": "OPEN",
            "author": {"login": pull["author"]},
            "headRefName": pull["head"],
            "baseRefName": pull["base"],
            "additions": 12,
            "deletions": 3,
            "changedFiles": 1,
            "assignees": {"nodes": []},
            "createdAt": _OPENED,
            "updatedAt": _UPDATED,
            "url": f"https://github.com/{GITHUB_REPO}/pull/{pull['number']}",
        }
        return _Answer(
            200,
            {
                "data": {
                    "repository": {
                        "pullRequests": {
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                            "nodes": [node],
                        }
                    }
                }
            },
        )
    if not path.lower().startswith(prefix):
        return _NOT_FOUND
    rest = [part for part in path[len(prefix) :].split("/") if part]
    issues = {issue["number"]: issue for issue in GITHUB_ISSUES}
    if method == "GET" and not rest:
        return _Answer(
            200,
            {
                "id": 1,
                "name": GITHUB_REPO.split("/")[1],
                "full_name": GITHUB_REPO,
                "private": True,
                "default_branch": "main",
                "description": "The team's shared board",
                "html_url": f"https://github.com/{GITHUB_REPO}",
                "owner": {"login": GITHUB_REPO.split("/")[0], "type": "Organization"},
                "open_issues_count": len(GITHUB_ISSUES) + 1,
            },
        )
    if method == "GET" and rest == ["issues"]:
        listed = GITHUB_ISSUES if _first_page(query) else []
        return _Answer(200, [_issue_json(issue) for issue in listed])
    if len(rest) >= 2 and rest[0] == "issues" and rest[1].isdigit():
        issue = issues.get(int(rest[1]))
        if issue is None and int(rest[1]) == GITHUB_PULL["number"]:
            if rest[2:] != ["comments"]:
                return _NOT_FOUND
            # A pull request is an issue too: its conversation is the issue's.
            issue = {"number": GITHUB_PULL["number"], "comments": []}
        if issue is None:
            return _NOT_FOUND
        if method == "GET" and len(rest) == 2:
            return _Answer(200, _issue_json(issue))
        if rest[2:] == ["comments"] and method == "GET":
            return _Answer(
                200, [_comment_json(c, issue["number"]) for c in issue["comments"]]
            )
        if rest[2:] == ["comments"] and method == "POST":
            text = body.get("body") if isinstance(body, dict) else None
            if not isinstance(text, str) or not text:
                return _Answer(422, {"message": "Body is required"})
            return _Answer(
                201,
                _comment_json(
                    {"id": 900, "author": "the-caller", "body": text}, issue["number"]
                ),
            )
    pull = str(GITHUB_PULL["number"])
    if rest[:2] == ["pulls", pull] and method == "GET":
        if len(rest) == 2:
            return _Answer(200, _pull_json())
        if rest[2:] == ["files"]:
            return _Answer(
                200,
                [
                    {
                        "filename": "app.py",
                        "status": "modified",
                        "additions": 12,
                        "deletions": 3,
                        "changes": 15,
                        "patch": _PULL_DIFF.split("@@", 1)[1],
                    }
                ],
            )
    if rest[:1] == ["commits"] and method == "GET":
        if rest[2:] == ["status"]:
            return _Answer(200, {"state": "success", "statuses": [], "total_count": 0})
        if rest[2:] == ["check-runs"]:
            return _Answer(200, {"total_count": 0, "check_runs": []})
    if rest == ["actions", "runs"] and method == "GET":
        return _Answer(200, {"total_count": 0, "workflow_runs": []})
    return _NOT_FOUND


def _gitlab(method: str, path: str, body: Any, query: str = "") -> _Answer:
    if method == "GET" and path == "/api/v4/user":
        return _Answer(200, _gitlab_user("the-caller"))
    encoded = GITLAB_PROJECT.replace("/", "%2F")
    prefix = f"/api/v4/projects/{encoded}"
    if not path.lower().startswith(prefix.lower()):
        return _NOT_FOUND
    rest = [part for part in path[len(prefix) :].split("/") if part]
    mr = str(GITLAB_MERGE_REQUEST["iid"])
    if method == "GET" and not rest:
        return _Answer(
            200,
            {
                "id": 42,
                "name": GITLAB_PROJECT.split("/")[1],
                "path_with_namespace": GITLAB_PROJECT,
                "default_branch": "main",
                "web_url": f"https://{GITLAB_HOST}/{GITLAB_PROJECT}",
                "description": "The team's documentation",
            },
        )
    if method == "GET" and rest == ["issues"]:
        listed = GITLAB_ISSUES if _first_page(query) else []
        return _Answer(
            200,
            [_gitlab_issue_json(issue) for issue in listed],
            total=len(GITLAB_ISSUES),
        )
    if method == "GET" and len(rest) >= 2 and rest[0] == "issues":
        found = [i for i in GITLAB_ISSUES if str(i["iid"]) == rest[1]]
        if not found:
            return _NOT_FOUND
        if len(rest) == 2:
            return _Answer(200, _gitlab_issue_json(found[0]))
        if rest[2:] == ["notes"]:
            return _Answer(200, [], total=0)
    if method == "GET" and rest == ["merge_requests"]:
        listed = [_gitlab_mr_json()] if _first_page(query) else []
        return _Answer(200, listed, total=1)
    if rest[:2] == ["merge_requests", mr]:
        if method == "GET" and len(rest) == 2:
            return _Answer(200, _gitlab_mr_json())
        if method == "GET" and rest[2:] == ["changes"]:
            return _Answer(
                200,
                {
                    **_gitlab_mr_json(),
                    "changes": [
                        {
                            "old_path": "docs/deploy.md",
                            "new_path": "docs/deploy.md",
                            "new_file": True,
                            "diff": "@@ -0,0 +1 @@\n+# Deploy\n",
                        }
                    ],
                },
            )
        if method == "GET" and rest[2:] == ["commits"]:
            return _Answer(200, [])
        if method == "POST" and rest[2:] == ["notes"]:
            text = body.get("body") if isinstance(body, dict) else None
            if not isinstance(text, str) or not text:
                return _Answer(400, {"message": "body is missing"})
            return _Answer(
                201,
                {"id": 901, "body": text, "author": _gitlab_user("the-caller")},
            )
    return _NOT_FOUND


class FakeForge:
    """The proxy, its two forges and what they were asked; a context manager."""

    def __init__(self, directory: Path) -> None:
        self.ca_file, cert_file, key_file = write_certificates(directory)
        self._tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._tls.load_cert_chain(cert_file, key_file)
        self._calls: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        forge = self

        class Handler(_ProxyHandler):
            pass

        Handler.forge = forge
        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def __enter__(self) -> FakeForge:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()

    def env(self, origin_url: str) -> dict[str, str]:
        """The server's environment for the forges: the proxy, its authority,
        the GitLab host named, and both clone URLs led to ``origin_url``."""
        return {
            "HTTPS_PROXY": self.url,
            "https_proxy": self.url,
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
            "SSL_CERT_FILE": str(self.ca_file),
            "WORKPILOT_GITLAB_HOSTS": GITLAB_HOST,
            **git_env({GITHUB_CLONE_URL: origin_url, GITLAB_CLONE_URL: origin_url}),
        }

    def record(self, call: dict[str, Any]) -> None:
        with self._lock:
            self._calls.append(call)

    def calls(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._calls)

    def tls_wrap(self, connection: Any) -> ssl.SSLSocket:
        return self._tls.wrap_socket(connection, server_side=True)


def git_env(rewrites: dict[str, str]) -> dict[str, str]:
    """Git's ``url.<to>.insteadOf <from>`` for each pair, in the environment
    (``GIT_CONFIG_COUNT``), so that a clone of ``from`` reads ``to``."""
    env = {"GIT_CONFIG_COUNT": str(len(rewrites))}
    for index, (source, target) in enumerate(rewrites.items()):
        env[f"GIT_CONFIG_KEY_{index}"] = f"url.{target}.insteadOf"
        env[f"GIT_CONFIG_VALUE_{index}"] = source
    return env


class _ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    forge: FakeForge
    tunnel_host = ""

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def do_CONNECT(self) -> None:  # noqa: N802 - the HTTP method's name
        host, _, port = self.path.rpartition(":")
        if port != "443" or host.lower() not in HOSTS:
            self.send_error(403, "Not a forge of this run")
            self.close_connection = True
            return
        self.send_response(200, "Connection established")
        self.end_headers()
        self.wfile.flush()
        tls = self.forge.tls_wrap(self.connection)
        self.connection = tls
        self.rfile = tls.makefile("rb")
        self.wfile = tls.makefile("wb")
        self.tunnel_host = host.lower()
        self.close_connection = False

    def do_GET(self) -> None:  # noqa: N802
        self._serve("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._serve("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._serve("PUT")

    def do_PATCH(self) -> None:  # noqa: N802
        self._serve("PATCH")

    def do_DELETE(self) -> None:  # noqa: N802
        self._serve("DELETE")

    def _token(self) -> str:
        if self.tunnel_host == GITLAB_HOST:
            return self.headers.get("PRIVATE-TOKEN", "")
        scheme, _, token = self.headers.get("Authorization", "").partition(" ")
        return token if scheme.lower() in ("bearer", "token") else ""

    def _body(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > _MAX_BODY:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except ValueError:
            return None

    def _serve(self, method: str) -> None:
        body = self._body()
        if not self.tunnel_host:
            # The proxy's own address: what the forges were asked, for the spec.
            if method == "GET" and self.path == "/calls":
                self._send(_Answer(200, self.forge.calls()))
            else:
                self._send(_Answer(403, {"message": "Not a proxy for plain HTTP"}))
            return
        split = urlsplit(self.path)
        token = self._token()
        self.forge.record(
            {
                "host": self.tunnel_host,
                "method": method,
                "path": split.path,
                "query": split.query,
                "token": token_tag(token) if token else "",
                "body": body if method != "GET" else None,
            }
        )
        if not token:
            self._send(_Answer(401, {"message": "Requires authentication"}))
            return
        api = _gitlab if self.tunnel_host == GITLAB_HOST else _github
        answer = api(method, split.path, body, split.query)
        if (
            answer.status == 200
            and self.tunnel_host == GITHUB_HOST
            and "diff" in self.headers.get("Accept", "")
            and unquote(split.path).endswith(f"/pulls/{GITHUB_PULL['number']}")
        ):
            answer = _Answer(200, text=_PULL_DIFF)
        self._send(answer)

    def _send(self, answer: _Answer) -> None:
        if answer.text is not None:
            payload, kind = answer.text.encode("utf-8"), "text/plain; charset=utf-8"
        else:
            payload = json.dumps(answer.body).encode("utf-8")
            kind = "application/json; charset=utf-8"
        self.send_response(answer.status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(payload)))
        if answer.total is not None:
            self.send_header("X-Total", str(answer.total))
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()


__all__ = [
    "GITHUB_CLONE_URL",
    "GITHUB_HOST",
    "GITHUB_REPO",
    "GITLAB_CLONE_URL",
    "GITLAB_HOST",
    "GITLAB_PROJECT",
    "FakeForge",
    "git_env",
    "token_tag",
]
