"""Automations of a server project, run on the server.

The desktop's rule engine (``apps/frontend/src/main/automations/``) runs a
project's rules while the app is open. A server project's rules are stored on
the server (``project_automations``), shared by the team, and run by the
server process every five minutes (``scheduler``): the same rules, schema,
caps and ledger (``rules``, ``store``, ``run``), the same sources read from
the project's forge, GitHub or GitLab (``sources``, ``forge_api``), cards
written by the *Automations* service account (``cards``), each rule acting
with the authority and the token of the person who saved it (``live``), and
routes by ``project_id`` (``api``).

See ``docs/architecture/automations.md``.
"""
