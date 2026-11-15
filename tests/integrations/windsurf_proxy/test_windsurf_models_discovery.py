"""Model name mapping and extension field discovery for Windsurf."""

from __future__ import annotations

from pathlib import Path

import pytest
from integrations.windsurf_proxy import discovery, models

# --------------------------------------------------------------------------
# models.py
# --------------------------------------------------------------------------


def test_exact_names_map_to_their_enum_and_model_constant():
    assert models.resolve_model("claude-4-sonnet") == (281, "MODEL_CLAUDE_4_SONNET")
    assert models.resolve_model("  GPT-5  ") == (340, "MODEL_GPT_5")


def test_swe_1_6_routes_by_slug_with_no_enum():
    assert models.resolve_model("SWE-1.6") == (0, "swe-1-6")
    assert models.resolve_model("swe-1.6-fast") == (0, "swe-1-6-fast")
    assert models.requires_cascade(" swe-1.6 ") is True
    assert models.requires_cascade("claude-4-sonnet") is False


def test_a_partial_name_is_matched_to_a_known_one(caplog):
    caplog.set_level("DEBUG", logger=models.logger.name)
    enum_val, name = models.resolve_model("deepseek-r1-fast-preview")
    assert name.startswith("MODEL_DEEPSEEK_R1")
    assert enum_val == int(models.ChatModelType[name.removeprefix("MODEL_")])
    assert "Fuzzy matched" in caplog.text


def test_an_unknown_name_falls_back_to_the_default(caplog):
    caplog.set_level("WARNING", logger=models.logger.name)
    default = models.MODEL_NAME_TO_ENUM[models.DEFAULT_MODEL]
    assert models.resolve_model("zz-unknown-zz") == (
        int(default),
        f"MODEL_{default.name}",
    )
    assert "Unknown model 'zz-unknown-zz'" in caplog.text


def test_every_friendly_name_resolves_to_its_own_enum():
    for friendly, enum_val in models.MODEL_NAME_TO_ENUM.items():
        if friendly in models._SLUG_MODEL_UIDS:
            continue
        assert models.resolve_model(friendly) == (
            int(enum_val),
            f"MODEL_{enum_val.name}",
        )


# --------------------------------------------------------------------------
# discovery.py
# --------------------------------------------------------------------------

EXTENSION_JS = (
    'x=newFieldList(()=>[{no:1,name:"event_name"},{no:2,name:"api_key"},{no:3,name:"ide_name"}]);'
    'y=newFieldList(()=>[{no:7,name:"api_key",kind:9},{no:8,name:"ide_name",kind:9},'
    '{no:9,name:"session_id",kind:9}]);'
)


@pytest.fixture(autouse=True)
def _no_cached_fields(monkeypatch):
    monkeypatch.setattr(discovery, "_cached_fields", None)


def _install_extension(home: Path, system: str, content: str | None) -> Path:
    if system == "Darwin":
        base = home / "Applications" / "Windsurf.app" / "Contents" / "Resources" / "app"
    elif system == "Linux":
        base = home / ".local" / "share" / "windsurf" / "resources" / "app"
    else:
        base = home / "Programs" / "Windsurf" / "resources" / "app"
    path = base / "extensions" / "windsurf" / "dist" / "extension.js"
    path.parent.mkdir(parents=True)
    if content is not None:
        path.write_text(content, encoding="utf-8")
    return path


@pytest.mark.parametrize("system", ["Darwin", "Linux", "Windows"])
def test_extension_found_in_the_user_install(monkeypatch, tmp_path, system):
    monkeypatch.setattr(discovery.platform, "system", lambda: system)
    monkeypatch.setattr(discovery.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    expected = _install_extension(tmp_path, system, "content")
    assert discovery._find_extension_file() == expected


def test_no_extension_on_an_unknown_os(monkeypatch, tmp_path):
    monkeypatch.setattr(discovery.platform, "system", lambda: "Plan9")
    assert discovery._find_extension_file() is None


def test_metadata_fields_come_from_the_non_telemetry_list():
    fields = discovery._parse_metadata_fields(EXTENSION_JS)
    assert fields == {
        **discovery.DEFAULT_METADATA_FIELDS,
        "api_key": 7,
        "ide_name": 8,
        "session_id": 9,
    }


def test_no_metadata_list_means_none():
    assert (
        discovery._parse_metadata_fields('newFieldList(()=>[{no:1,name:"event_name"}])')
        is None
    )
    assert discovery._parse_metadata_fields("") is None


def test_discovered_fields_are_cached(monkeypatch, tmp_path):
    ext = tmp_path / "extension.js"
    ext.write_text(EXTENSION_JS, encoding="utf-8")
    monkeypatch.setattr(discovery, "_find_extension_file", lambda: ext)

    first = discovery.get_metadata_fields()
    ext.write_text("changed", encoding="utf-8")

    assert first["api_key"] == 7
    assert discovery.get_metadata_fields() is first


@pytest.mark.parametrize("case", ["missing", "unparsable", "unreadable"])
def test_defaults_when_discovery_finds_nothing(monkeypatch, tmp_path, case):
    if case == "missing":
        found = None
    elif case == "unparsable":
        found = tmp_path / "extension.js"
        found.write_text("no field lists here", encoding="utf-8")
    else:
        found = tmp_path / "a-directory"
        found.mkdir()
    monkeypatch.setattr(discovery, "_find_extension_file", lambda: found)

    fields = discovery.get_metadata_fields()

    assert fields == discovery.DEFAULT_METADATA_FIELDS
    assert fields is not discovery.DEFAULT_METADATA_FIELDS
