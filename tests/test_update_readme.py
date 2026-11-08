"""The README download table must describe the release that actually exists.

v1.2.0 shipped without a macOS Intel build — the packaging job passed
`--arm64` and `--x64` together and produced arm64 twice — while the README
went on advertising `WorkPilot-AI-1.2.0-darwin-x64.dmg`. The link 404'd for
the whole release cycle, and it would have carried into every release after
it: the old code substituted the version number into the previous table
rather than regenerating it.

These tests pin the property that prevents that: a row exists only when its
asset does.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "update-readme.py"


@pytest.fixture(scope="module")
def ur():
    spec = importlib.util.spec_from_file_location("update_readme", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _assets(version: str, *suffixes: str) -> list[str]:
    return [f"WorkPilot-AI-{version}{suffix}" for suffix in suffixes]


class TestTableFollowsTheAssets:
    def test_every_platform_present_gives_every_row(self, ur):
        assets = _assets("2.0.0", *[suffix for _, suffix in ur.PLATFORM_ASSETS])
        table = ur.build_download_table("2.0.0", assets)
        for label, suffix in ur.PLATFORM_ASSETS:
            assert f"**{label}**" in table
            assert f"WorkPilot-AI-2.0.0{suffix}" in table

    def test_a_missing_platform_is_not_advertised(self, ur):
        """The v1.2.0 regression, stated directly."""
        present = [s for _, s in ur.PLATFORM_ASSETS if s != "-darwin-x64.dmg"]
        table = ur.build_download_table("1.2.0", _assets("1.2.0", *present))
        assert "darwin-x64" not in table
        assert "macOS (Intel)" not in table
        # …and the platforms that were built are still offered.
        assert "WorkPilot-AI-1.2.0-darwin-arm64.dmg" in table
        assert "WorkPilot-AI-1.2.0-win32-x64.exe" in table

    def test_a_missing_platform_is_reported(self, ur, capsys):
        present = [s for _, s in ur.PLATFORM_ASSETS if s != "-darwin-x64.dmg"]
        ur.build_download_table("1.2.0", _assets("1.2.0", *present))
        out = capsys.readouterr().out
        assert "::warning::" in out
        assert "macOS (Intel)" in out

    def test_no_assets_at_all_says_so(self, ur):
        """v1.1.0's shape: a published release carrying nothing.

        Six dead links is the worst answer here; a sentence is the right one.
        """
        table = ur.build_download_table("1.1.0", [])
        assert "WorkPilot-AI-1.1.0" not in table
        assert "releases/tag/v1.1.0" in table

    def test_unknown_assets_fall_back_to_listing_everything(self, ur):
        """`None` means "could not ask", not "nothing was built"."""
        table = ur.build_download_table("3.1.4", None)
        for _, suffix in ur.PLATFORM_ASSETS:
            assert f"WorkPilot-AI-3.1.4{suffix}" in table

    def test_unrelated_assets_do_not_create_rows(self, ur):
        table = ur.build_download_table(
            "2.0.0",
            [
                "checksums.sha256",
                "latest.yml",
                "WorkPilot-AI-2.0.0-win32-x64.exe.blockmap",
            ],
        )
        # The blockmap must not be mistaken for the installer it describes.
        assert "WorkPilot-AI-2.0.0-win32-x64.exe]" not in table
        assert "releases/tag/v2.0.0" in table

    def test_a_different_version_is_not_matched(self, ur):
        """Assets from the previous release must not fill this one's table."""
        table = ur.build_download_table("2.0.0", _assets("1.9.0", "-win32-x64.exe"))
        assert "WorkPilot-AI-2.0.0" not in table


class TestRegenerationNotSubstitution:
    def test_a_stale_row_is_dropped_on_the_next_release(self, ur):
        """The bug that let one bad release poison every later README.

        The old code rewrote the version inside the existing table, so a row
        for a platform that stopped being built survived indefinitely.
        """
        readme = (
            f"{ur.STABLE_DL_START}\n"
            "| Platform | Download |\n"
            "|----------|----------|\n"
            "| **macOS (Intel)** | [WorkPilot-AI-1.2.0-darwin-x64.dmg]"
            "(https://example.invalid/WorkPilot-AI-1.2.0-darwin-x64.dmg) |\n"
            f"{ur.STABLE_DL_END}\n"
        )
        updated = ur.replace_section_content(
            readme,
            ur.STABLE_DL_START,
            ur.STABLE_DL_END,
            ur.build_download_table("1.3.0", _assets("1.3.0", "-win32-x64.exe")),
        )
        assert "darwin-x64" not in updated
        assert "WorkPilot-AI-1.3.0-win32-x64.exe" in updated


class TestFetchIsForgiving:
    def test_a_network_failure_returns_none_rather_than_raising(self, ur, monkeypatch):
        """A release must not fail to publish because api.github.com blinked."""

        def boom(*_args, **_kwargs):
            raise OSError("network down")

        monkeypatch.setattr(ur.urllib.request, "urlopen", boom)
        assert ur.fetch_release_assets("2.0.0") is None


class TestBothLanguages:
    """README.md and README.fr.md are refreshed together, each in its language."""

    def test_french_table_has_french_header(self, ur):
        table = ur.build_download_table(
            "2.0.0", _assets("2.0.0", "-win32-x64.exe"), "fr"
        )
        assert table.startswith("| Plateforme | Téléchargement |")
        assert "WorkPilot-AI-2.0.0-win32-x64.exe" in table

    def test_french_no_binaries_sentence(self, ur):
        table = ur.build_download_table("1.1.0", [], "fr")
        assert "Aucun binaire" in table
        assert "releases/tag/v1.1.0" in table

    def test_every_readme_is_updated_with_one_asset_read(
        self, ur, tmp_path, monkeypatch
    ):
        section = (
            f"{ur.STABLE_BADGE_START}\n{ur.STABLE_BADGE_END}\n"
            f"{ur.STABLE_DL_START}\nold\n{ur.STABLE_DL_END}\n"
        )
        (tmp_path / "README.md").write_text(section, encoding="utf-8")
        (tmp_path / "README.fr.md").write_text(section, encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        calls = []

        def fake_fetch(version):
            calls.append(version)
            return _assets(version, "-win32-x64.exe")

        monkeypatch.setattr(ur, "fetch_release_assets", fake_fetch)
        assert ur.update_all_readmes("2.0.0", False)
        assert calls == ["2.0.0"]
        en = (tmp_path / "README.md").read_text(encoding="utf-8")
        fr = (tmp_path / "README.fr.md").read_text(encoding="utf-8")
        assert "| Platform | Download |" in en
        assert "| Plateforme | Téléchargement |" in fr
        for text in (en, fr):
            assert "stable-2.0.0-blue" in text
            assert "WorkPilot-AI-2.0.0-win32-x64.exe" in text

    def test_a_missing_french_readme_is_skipped(self, ur, tmp_path, monkeypatch):
        (tmp_path / "README.md").write_text(
            f"{ur.STABLE_DL_START}\nold\n{ur.STABLE_DL_END}\n", encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(ur, "fetch_release_assets", lambda _v: None)
        assert ur.update_all_readmes("2.0.0", False)
        assert not (tmp_path / "README.fr.md").exists()


class TestTheTwoReadmesStayTwins:
    """The French README must not drift from the English one."""

    EN = REPO_ROOT / "README.md"
    FR = REPO_ROOT / "README.fr.md"

    @staticmethod
    def _images(text: str) -> list[str]:
        return re.findall(r"\]\((\.github/assets/screenshots/[^)]+)\)", text)

    def test_each_links_to_the_other(self):
        assert "(README.fr.md)" in self.EN.read_text(encoding="utf-8")
        assert "(README.md)" in self.FR.read_text(encoding="utf-8")

    def test_same_screenshots_in_the_same_order(self):
        en = self._images(self.EN.read_text(encoding="utf-8"))
        fr = self._images(self.FR.read_text(encoding="utf-8"))
        assert en and en == fr
        for image in en:
            assert (REPO_ROOT / image).is_file(), image

    def test_same_diagrams(self):
        """Both READMEs draw the same Mermaid diagrams, not ASCII arrows."""
        en = self.EN.read_text(encoding="utf-8")
        fr = self.FR.read_text(encoding="utf-8")
        assert en.count("```mermaid") == fr.count("```mermaid") >= 2
        for text in (en, fr):
            assert "─▶" not in text

    def test_same_release_markers(self, ur):
        markers = [
            ur.STABLE_BADGE_START,
            ur.STABLE_BADGE_END,
            ur.STABLE_DL_START,
            ur.STABLE_DL_END,
            ur.BETA_BADGE_START,
            ur.BETA_BADGE_END,
            ur.BETA_DL_START,
            ur.BETA_DL_END,
        ]
        for path in (self.EN, self.FR):
            text = path.read_text(encoding="utf-8")
            for marker in markers:
                assert text.count(marker) == 1, (path.name, marker)
