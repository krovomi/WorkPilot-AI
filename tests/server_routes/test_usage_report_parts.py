"""The parts of the usage report that need no database: its settings as read
from an organization's row, the periods it covers, when it is due, and the
email it becomes, in French and English."""

from __future__ import annotations

from datetime import UTC, date, datetime, time

import pytest
from server.services import report_settings, usage_digest, usage_digest_mail
from server.services.report_settings import ReportSettings
from server.services.usage_digest import Period
from server.services.usage_report_schedule import due, today_in, usage_digest_at


def test_an_organization_without_settings_gets_the_defaults(monkeypatch):
    from server import config

    monkeypatch.setenv("WORKPILOT_REPORT_TIMEZONE", "America/New_York")
    monkeypatch.setenv("WORKPILOT_REPORT_LANGUAGE", "en")
    config.reset_settings_cache()
    settings = report_settings.of(None)
    assert settings == report_settings.of({"usage_report": "garbage"})
    assert settings.enabled and settings.time == "09:00"
    assert settings.timezone == "America/New_York" and settings.language == "en"
    assert settings.days == report_settings.EVERY_DAY
    assert settings.recipients == () and settings.names
    assert not settings.weekly and not settings.monthly
    assert settings.at == time(9, 0)


def test_a_default_that_does_not_read_falls_back(monkeypatch):
    from server import config

    monkeypatch.setenv("WORKPILOT_REPORT_TIMEZONE", "Mars/Olympus")
    monkeypatch.setenv("WORKPILOT_REPORT_LANGUAGE", "de")
    config.reset_settings_cache()
    settings = report_settings.of({})
    assert settings.timezone == "UTC" and settings.language == "fr"


def test_the_server_default_is_paris_in_french(monkeypatch):
    from server import config

    monkeypatch.delenv("WORKPILOT_REPORT_TIMEZONE", raising=False)
    monkeypatch.delenv("WORKPILOT_REPORT_LANGUAGE", raising=False)
    config.reset_settings_cache()
    settings = ReportSettings()
    assert settings.timezone == "Europe/Paris" and settings.language == "fr"


def test_stored_settings_read_back_and_bad_values_are_replaced():
    good = ReportSettings(
        enabled=False,
        time="07:45",
        timezone="Asia/Tokyo",
        days=(0, 1, 2, 3, 4),
        recipients=("boss@corp.example",),
        language="en",
        names=False,
        weekly=True,
        monthly=True,
    )
    assert report_settings.of({"usage_report": good.as_dict()}) == good
    bad = report_settings.of(
        {
            "usage_report": {
                "enabled": "yes",
                "time": "25:00",
                "timezone": "Nowhere/City",
                "days": [9, "1", -1],
                "recipients": "a@b.example",
                "language": "de",
                "names": 0,
                "weekly": None,
            }
        }
    )
    assert bad.enabled and bad.time == "09:00" and bad.days == (0, 1, 2, 3, 4, 5, 6)
    assert bad.recipients == () and bad.names and not bad.weekly
    assert bad.timezone == ReportSettings().timezone
    picked = report_settings.of({"usage_report": {"days": [6, 5, 5, "x"]}})
    assert picked.days == (5, 6)


def test_an_unknown_zone_still_reads_as_utc():
    assert ReportSettings(timezone="Nowhere/City").zone.key == "UTC"


@pytest.mark.parametrize(
    ("name", "known"),
    [
        ("Europe/Paris", True),
        ("UTC", True),
        ("", False),
        (None, False),
        (42, False),
        ("x" * 65, False),
        ("Not/AZone", False),
        ("../etc/passwd", False),
    ],
)
def test_a_zone_is_an_iana_name(name, known):
    assert (report_settings.zone_of(name) is not None) is known


def test_recipients_are_clean_addresses_each_once_at_most_twenty():
    many = [f"p{i}@corp.example" for i in range(25)]
    assert len(report_settings.clean_recipients(many)) == 20
    assert report_settings.clean_recipients(
        ["Ada@Corp.example", "ada@corp.example", "not an address", 3, "x@y"]
    ) == ("ada@corp.example",)
    assert report_settings.clean_recipients("ada@corp.example") == ()
    assert not report_settings.is_address("a" * 250 + "@corp.example")
    assert report_settings.valid_time("23:59") and not report_settings.valid_time(
        "9:00"
    )


def test_store_keeps_the_other_settings():
    class Org:
        settings = {"usage": {"page_activity": True}}

    org = Org()
    report_settings.store(org, ReportSettings(time="08:00"))
    assert org.settings["usage"] == {"page_activity": True}
    assert org.settings["usage_report"]["time"] == "08:00"


def test_each_report_covers_its_last_full_period():
    wednesday = date(2026, 11, 25)
    assert usage_digest.period_of("daily", wednesday) == Period(
        "daily", date(2026, 11, 24), date(2026, 11, 24)
    )
    assert usage_digest.period_of("weekly", date(2026, 11, 30)) == Period(
        "weekly", date(2026, 11, 23), date(2026, 11, 29)
    )
    assert usage_digest.period_of("monthly", date(2026, 3, 1)) == Period(
        "monthly", date(2026, 2, 1), date(2026, 2, 28)
    )


def test_the_period_before_and_the_one_holding_a_day():
    month = Period("monthly", date(2026, 3, 1), date(2026, 3, 31))
    assert month.before() == Period("monthly", date(2026, 2, 1), date(2026, 2, 28))
    week = Period("weekly", date(2026, 11, 23), date(2026, 11, 29))
    assert week.before() == Period("weekly", date(2026, 11, 16), date(2026, 11, 22))
    day = Period("daily", date(2026, 1, 1), date(2026, 1, 1))
    assert day.before() == Period("daily", date(2025, 12, 31), date(2025, 12, 31))
    held = date(2026, 12, 17)
    assert usage_digest.period_containing("daily", held).start == held
    assert usage_digest.period_containing("weekly", held) == Period(
        "weekly", date(2026, 12, 14), date(2026, 12, 20)
    )
    assert usage_digest.period_containing("monthly", held) == Period(
        "monthly", date(2026, 12, 1), date(2026, 12, 31)
    )


def test_budget_alerts_at_eighty_and_a_hundred_percent():
    alerts = usage_digest._alerts
    assert alerts(None) == [] and alerts({"percent": None}) == []
    assert alerts({"percent": 79.9}) == []
    assert alerts({"percent": 80.0})[0]["threshold"] == 80
    assert alerts({"percent": 130.0})[0]["threshold"] == 100
    assert usage_digest._mean([None, None]) is None
    assert usage_digest._mean([1, None, 2]) == 1.5


def _local(text: str, zone: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=report_settings.zone_of(zone))


def test_a_report_is_due_once_its_hour_has_passed_on_its_days():
    settings = ReportSettings(time="09:00", timezone="Europe/Paris", days=(0, 2))
    monday = _local("2026-11-30T09:00", "Europe/Paris")
    assert [p.kind for p in due(settings, monday)] == ["daily"]
    assert due(settings, _local("2026-11-30T08:59", "Europe/Paris")) == []
    assert due(settings, _local("2026-12-01T10:00", "Europe/Paris")) == []
    assert due(ReportSettings(enabled=False), monday) == []
    both = ReportSettings(time="09:00", weekly=True, monthly=True, days=(1,))
    first_monday = _local("2027-02-01T09:30", "UTC")
    assert [p.kind for p in due(both, first_monday)] == ["weekly", "monthly"]


def test_the_hour_is_the_organization_s_own():
    tokyo = ReportSettings(time="09:00", timezone="Asia/Tokyo")
    # 01:00 UTC is 10:00 in Tokyo: due there, for Tokyo's yesterday.
    now = datetime(2026, 11, 26, 1, 0, tzinfo=UTC)
    (period,) = due(tokyo, now.astimezone(tokyo.zone))
    assert period.start == date(2026, 11, 25)
    paris = ReportSettings(time="09:00", timezone="Europe/Paris")
    assert due(paris, now.astimezone(paris.zone)) == []
    assert today_in(tokyo, now) == date(2026, 11, 26)
    assert isinstance(today_in(paris), date)


def test_a_moment_without_a_zone_reads_as_utc():
    assert usage_digest_at(datetime(2026, 1, 2, 3, 4)).endswith("+00:00")
    aware = datetime(2026, 1, 2, 3, 4, tzinfo=UTC)
    assert usage_digest_at(aware) == aware.isoformat()


def _report(**over) -> dict:
    report = {
        "kind": "daily",
        "organization": "Acme <b>",
        "start": "2026-11-26",
        "end": "2026-11-26",
        "names": True,
        "figures": {
            "tokens": {"value": 12345, "previous": 1000, "average": 2000.5},
            "cost_usd": {"value": 1234.5, "previous": 0.0, "average": None},
            "success_rate": {"value": 0.5, "previous": None, "average": 0.25},
            "active": {"value": 2, "previous": 1, "average": 1.0},
        },
        "budget": {
            "monthly_token_budget": 100000,
            "used_this_month": 85000,
            "percent": 85.0,
        },
        "dormant": 3,
        "top": [
            {"name": "<script>Ada</script>", "tokens": 900, "cost_usd": 1.5},
            {"name": None, "tokens": 10, "cost_usd": 0.0},
        ],
        "engines": [
            {"provider": "anthropic", "model": None, "tokens": 5, "cost_usd": 0.1}
        ],
        "failures": [
            {"cause": "timeout", "runs": 2, "jobs": 1},
            {"cause": "unheard_of", "runs": 1, "jobs": 0},
        ],
        "alerts": [
            {"kind": "budget", "threshold": 80, "percent": 85.0},
            {"kind": "something_else"},
        ],
    }
    report.update(over)
    return report


def test_the_report_in_french():
    text = usage_digest_mail.lines(_report(), "fr")
    assert text["subject"] == "WorkPilot : l'usage de Acme <b> le 2026-11-26"
    assert text["figures"][0] == (
        "Tokens : 12\u202f345 (la veille 1\u202f000, moyenne sur 7 jours 2\u202f000,5)"
    )
    assert text["figures"][1] == "Coût : 1\u202f234,50 $ (la veille 0,00 $)"
    assert text["figures"][2] == (
        "Taux de succès : 50 % (la veille –, moyenne sur 7 jours 25 %)"
    )
    assert text["notes"][0] == (
        "Budget du mois : 85\u202f000 tokens sur 100\u202f000 (85,0 %)."
    )
    assert text["top"][1] == "2. Compte effacé : 10 tokens, 0,00 $"
    assert text["engines"] == ["anthropic / ? : 5 tokens, 0,10 $"]
    assert text["failures"] == [
        "délai dépassé : 2 runs, 1 jobs",
        "autre : 1 runs, 0 jobs",
    ]
    assert len(text["alerts"]) == 1 and "seuil de 80 %" in text["alerts"][0]


def test_the_report_in_english_without_names_or_budget():
    report = _report(
        kind="weekly",
        end="2026-11-29",
        names=False,
        organization=None,
        budget={"monthly_token_budget": None},
    )
    report["top"] = [{"name": None, "tokens": 1, "cost_usd": 2.0}]
    text = usage_digest_mail.lines(report, "en")
    assert text["subject"] == "WorkPilot: 's usage from 2026-11-26 to 2026-11-29"
    assert text["figures"][1] == "Cost: $1,234.50 (week before $0.00)"
    assert text["notes"] == ["Accounts with no activity for 30 days: 3."]
    assert text["top"] == ["1. Person 1: 1 tokens, $2.00"]
    assert usage_digest_mail.lines(report, "de")["subject"].startswith("WorkPilot :")


def test_the_email_escapes_every_name_and_carries_both_forms():
    msg = usage_digest_mail.message(
        _report(), "en", "workpilot@corp.example", ["a@corp.example", "b@x.example"]
    )
    assert msg["To"] == "a@corp.example, b@x.example"
    assert msg["From"] == "workpilot@corp.example"
    plain = msg.get_body(("plain",)).get_content()
    rich = msg.get_body(("html",)).get_content()
    assert "<script>Ada</script>" in plain
    assert "<script>" not in rich and "&lt;script&gt;Ada&lt;/script&gt;" in rich
    assert "Acme &lt;b&gt;" in rich
    empty = _report(top=[], engines=[], failures=[], alerts=[])
    quiet = usage_digest_mail.message(empty, "fr", "w@corp.example", ["a@x.example"])
    assert "- Rien à signaler." in quiet.get_body(("plain",)).get_content()
    assert "<li>Rien à signaler.</li>" in quiet.get_body(("html",)).get_content()
