# Security Policy

WorkPilot AI runs LLM agents that read external content, write code and execute commands on
the user's machine. We take reports about that attack surface seriously and thank anyone who
reports responsibly.

## Supported versions

Security fixes ship in the next release. Only the latest release line is supported; upgrade
before reporting if you can.

| Version | Supported |
| ------- | --------- |
| 1.2.x (latest) | ✅ |
| < 1.2 | ❌ |

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion, and do not post details on Discord.**

1. Use GitHub's private reporting: **Security → Report a vulnerability** on
   [krovomi/WorkPilot-AI](https://github.com/krovomi/WorkPilot-AI/security/advisories/new).
2. If that form is unavailable, open a public issue titled *"Security contact request"* with
   **no technical detail**; a maintainer will open a private channel.

Please include:

- the affected version or commit, and the platform (Windows, macOS, Linux; desktop, CLI or server mode);
- the component (Electron main/renderer, backend API, agent tools, server mode, CI);
- reproduction steps or a proof of concept, and the impact you observed;
- whether the issue requires a malicious repository, a malicious ticket/issue (prompt injection),
  local access, or network access.

## What happens next

- We acknowledge the report in the advisory thread and confirm whether we can reproduce it.
- Once confirmed, the fix is developed in the advisory's temporary private fork, released, then
  the GitHub Security Advisory is published with credit to the reporter (unless you prefer to
  stay anonymous).
- Please keep the details private until the advisory is published.

## Scope

In scope:

- command execution or file writes outside what an agent is allowed (allowlist, write-path guard,
  tool rights), including through prompt injection from issues, PRs, tickets, web pages,
  attachments or MCP output;
- credential exposure: OAuth tokens, API keys, secrets written in clear, logged or sent to a third party;
- Electron: renderer-to-main escalation, IPC abuse, unsafe navigation or `openExternal`;
- server mode: authentication bypass, missing permission on a route, cross-tenant access,
  client-supplied filesystem paths;
- supply chain: release artifacts, auto-update, CI workflows, vendored code.

Out of scope:

- an agent doing something harmful **because the user explicitly asked for it** within the
  permissions they granted;
- vulnerabilities in a third-party LLM provider, Claude Code or another upstream tool (report
  them upstream);
- findings that require an already compromised machine or user account.

## For contributors and coding agents

The rules every change follows are in [`docs/rules/security.md`](rules/security.md). A fix for an
undisclosed vulnerability is described in neutral terms in its commit and pull request until the
advisory is published.
