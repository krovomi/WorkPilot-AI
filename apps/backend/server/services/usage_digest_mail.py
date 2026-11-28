"""The usage report as an email, in French or English.

Text and HTML carry the same lines. Every name, model and organization name
is escaped in the HTML: they come from the database, not from this module.
"""

from __future__ import annotations

import html
from email.message import EmailMessage

TEXT = {
    "fr": {
        "colon": " : ",
        "subject": {
            "daily": "WorkPilot : l'usage de {org} le {start}",
            "weekly": "WorkPilot : l'usage de {org} du {start} au {end}",
            "monthly": "WorkPilot : l'usage de {org} du {start} au {end}",
        },
        "intro": {
            "daily": "L'usage de {org} le {start} (jour UTC).",
            "weekly": "L'usage de {org} du {start} au {end} (jours UTC).",
            "monthly": "L'usage de {org} du {start} au {end} (jours UTC).",
        },
        "previous": {
            "daily": "la veille",
            "weekly": "semaine d'avant",
            "monthly": "mois d'avant",
        },
        "average": "moyenne sur 7 jours",
        "figures": {
            "tokens": "Tokens",
            "cost_usd": "Coût",
            "active": "Personnes actives",
            "new_members": "Nouveaux membres",
            "runs": "Runs",
            "succeeded": "Runs réussis",
            "failed": "Runs en échec",
            "success_rate": "Taux de succès",
            "merged": "Tâches fusionnées",
            "cost_per_task_usd": "Coût par tâche livrée",
        },
        "budget": "Budget du mois : {used} tokens sur {limit} ({percent} %).",
        "dormant": "Comptes sans activité depuis 30 jours : {count}.",
        "top": "Ceux qui ont le plus consommé",
        "someone": "Personne {rank}",
        "erased": "Compte effacé",
        "engines": "Par fournisseur et modèle",
        "failures": "Causes des échecs",
        "causes": {
            "usage_limit": "limite d'usage atteinte",
            "provider_sign_in": "connexion au fournisseur",
            "timeout": "délai dépassé",
            "tests": "tests en échec",
            "other": "autre",
        },
        "failure_counts": "{runs} runs, {jobs} jobs",
        "alerts": "Alertes",
        "alert_budget": "{percent} % du budget mensuel de tokens est consommé (seuil de {threshold} %).",
        "alert_scope": "{target} : {percent} % de son budget mensuel de tokens (seuil de {threshold} %).",
        "targets": {
            "person": "Une personne",
            "group": "Groupe {name}",
            "project": "Projet {name}",
        },
        "none": "Rien à signaler.",
        "footer": "Envoyé par le serveur WorkPilot de votre équipe. Les destinataires se règlent dans Administration, Usage, Rapport.",
    },
    "en": {
        "colon": ": ",
        "subject": {
            "daily": "WorkPilot: {org}'s usage on {start}",
            "weekly": "WorkPilot: {org}'s usage from {start} to {end}",
            "monthly": "WorkPilot: {org}'s usage from {start} to {end}",
        },
        "intro": {
            "daily": "{org}'s usage on {start} (UTC day).",
            "weekly": "{org}'s usage from {start} to {end} (UTC days).",
            "monthly": "{org}'s usage from {start} to {end} (UTC days).",
        },
        "previous": {
            "daily": "day before",
            "weekly": "week before",
            "monthly": "month before",
        },
        "average": "7-day average",
        "figures": {
            "tokens": "Tokens",
            "cost_usd": "Cost",
            "active": "Active people",
            "new_members": "New members",
            "runs": "Runs",
            "succeeded": "Runs succeeded",
            "failed": "Runs failed",
            "success_rate": "Success rate",
            "merged": "Tasks merged",
            "cost_per_task_usd": "Cost per delivered task",
        },
        "budget": "This month's budget: {used} tokens of {limit} ({percent} %).",
        "dormant": "Accounts with no activity for 30 days: {count}.",
        "top": "Who used the most",
        "someone": "Person {rank}",
        "erased": "Erased account",
        "engines": "By provider and model",
        "failures": "Why runs failed",
        "causes": {
            "usage_limit": "usage limit reached",
            "provider_sign_in": "provider sign-in",
            "timeout": "timed out",
            "tests": "tests failed",
            "other": "other",
        },
        "failure_counts": "{runs} runs, {jobs} jobs",
        "alerts": "Alerts",
        "alert_budget": "{percent} % of the monthly token budget is used (threshold {threshold} %).",
        "alert_scope": "{target}: {percent} % of its monthly token budget (threshold {threshold} %).",
        "targets": {
            "person": "A person",
            "group": "Group {name}",
            "project": "Project {name}",
        },
        "none": "Nothing to report.",
        "footer": "Sent by your team's WorkPilot server. Recipients are set in Administration, Usage, Report.",
    },
}


def _number(value: float | int, language: str, digits: int = 0) -> str:
    text = f"{value:,.{digits}f}"
    if language == "fr":
        text = text.replace(",", " ").replace(".", ",")
    return text


def _value(name: str, value: float | int | None, language: str) -> str:
    if value is None:
        return "–"
    if name == "success_rate":
        return f"{_number(value * 100, language)} %"
    if name in ("cost_usd", "cost_per_task_usd"):
        amount = _number(value, language, 2)
        return f"{amount} $" if language == "fr" else f"${amount}"
    if isinstance(value, float) and not value.is_integer():
        return _number(value, language, 1)
    return _number(value, language)


def _spend(row: dict, language: str) -> str:
    tokens = _number(row["tokens"], language)
    return f"{tokens} tokens, {_value('cost_usd', row['cost_usd'], language)}"


def lines(report: dict, language: str) -> dict:
    """The report as lists of plain lines, by section, in ``language``."""
    words = TEXT[language if language in TEXT else "fr"]
    kind = report["kind"]
    colon = words["colon"]
    where = {
        "org": report["organization"] or "",
        "start": report["start"],
        "end": report["end"],
    }
    figures = []
    for name, compared in report["figures"].items():
        line = (
            words["figures"][name] + colon + _value(name, compared["value"], language)
        )
        others = [
            f"{words['previous'][kind]} {_value(name, compared['previous'], language)}"
        ]
        if compared.get("average") is not None:
            others.append(
                f"{words['average']} {_value(name, compared['average'], language)}"
            )
        figures.append(f"{line} ({', '.join(others)})")
    notes = []
    budget = report.get("budget")
    if budget and budget.get("monthly_token_budget"):
        notes.append(
            words["budget"].format(
                used=_number(budget["used_this_month"], language),
                limit=_number(budget["monthly_token_budget"], language),
                percent=_number(budget["percent"] or 0, language, 1),
            )
        )
    notes.append(words["dormant"].format(count=report["dormant"]))
    top = []
    for rank, person in enumerate(report["top"], start=1):
        name = person["name"]
        if name is None:
            name = (
                words["someone"].format(rank=rank)
                if not report["names"]
                else words["erased"]
            )
        top.append(f"{rank}. {name}{colon}{_spend(person, language)}")
    engines = [
        f"{e['provider'] or '?'} / {e['model'] or '?'}{colon}{_spend(e, language)}"
        for e in report["engines"]
    ]
    failures = [
        words["causes"].get(f["cause"], words["causes"]["other"])
        + colon
        + words["failure_counts"].format(runs=f["runs"], jobs=f["jobs"])
        for f in report["failures"]
    ]
    alerts = []
    for a in report["alerts"]:
        if a["kind"] not in ("budget", "budget_scope"):
            continue
        percent = _number(a["percent"], language, 1)
        if a["kind"] == "budget":
            alerts.append(
                words["alert_budget"].format(percent=percent, threshold=a["threshold"])
            )
        else:
            target = (
                a["name"]
                if a["scope"] == "person" and a["name"]
                else words["targets"][a["scope"]].format(name=a["name"])
            )
            alerts.append(
                words["alert_scope"].format(
                    target=target, percent=percent, threshold=a["threshold"]
                )
            )
    return {
        "subject": words["subject"][kind].format(**where),
        "intro": words["intro"][kind].format(**where),
        "figures": figures,
        "notes": notes,
        "top_title": words["top"],
        "top": top,
        "engines_title": words["engines"],
        "engines": engines,
        "failures_title": words["failures"],
        "failures": failures,
        "alerts_title": words["alerts"],
        "alerts": alerts,
        "none": words["none"],
        "footer": words["footer"],
    }


def _section_text(title: str, items: list[str], none: str) -> str:
    body = "\n".join(f"- {item}" for item in items) if items else f"- {none}"
    return f"{title}\n{body}\n"


def _section_html(title: str, items: list[str], none: str) -> str:
    body = (
        "".join(f"<li>{html.escape(i)}</li>" for i in items)
        or f"<li>{html.escape(none)}</li>"
    )
    return f"<h3>{html.escape(title)}</h3><ul>{body}</ul>"


def message(report: dict, language: str, sender: str, to: list[str]) -> EmailMessage:
    """The email of the report, to ``to`` (one message, every address in To)."""
    text = lines(report, language)
    sections = [
        (text["alerts_title"], text["alerts"]),
        (text["top_title"], text["top"]),
        (text["engines_title"], text["engines"]),
        (text["failures_title"], text["failures"]),
    ]
    msg = EmailMessage()
    msg["Subject"] = text["subject"]
    msg["From"] = sender
    msg["To"] = ", ".join(to)
    plain = [text["intro"], "", *text["figures"], "", *text["notes"], ""]
    plain += [_section_text(title, items, text["none"]) for title, items in sections]
    plain.append(text["footer"])
    msg.set_content("\n".join(plain))
    rich = "".join(f"<li>{html.escape(f)}</li>" for f in text["figures"])
    notes = "".join(f"<p>{html.escape(n)}</p>" for n in text["notes"])
    parts = "".join(
        _section_html(title, items, text["none"]) for title, items in sections
    )
    msg.add_alternative(
        '<html><body style="font-family:sans-serif;line-height:1.5">'
        f"<h2>WorkPilot AI</h2><p>{html.escape(text['intro'])}</p>"
        f"<ul>{rich}</ul>{notes}{parts}"
        f'<p style="color:#666;font-size:13px">{html.escape(text["footer"])}</p>'
        "</body></html>",
        subtype="html",
    )
    return msg
