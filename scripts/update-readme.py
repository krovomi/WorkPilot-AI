#!/usr/bin/env python3
"""
Update README.md version badges and download links.

Usage:
    python scripts/update-readme.py <version> [--prerelease]

Examples:
    python scripts/update-readme.py 2.8.0              # Stable release
    python scripts/update-readme.py 2.8.0-beta.1 --prerelease  # Beta release
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

# Semver pattern: X.Y.Z or X.Y.Z-prerelease.N
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+(-[a-zA-Z]+\.\d+)?$")

# Semver regex for matching existing versions in README content
# Prerelease MUST contain a dot (beta.10, alpha.1, rc.1) to avoid matching platform suffixes (win32, darwin)
SEMVER_RE = r"\d+\.\d+\.\d+(?:-[a-zA-Z]+\.[a-zA-Z0-9.]+)?"
# Shields.io escaped pattern (hyphens as --)
SEMVER_BADGE_RE = r"\d+\.\d+\.\d+(?:--[a-zA-Z]+\.[a-zA-Z0-9.]+)?"

# README section markers
BETA_BADGE_START = "<!-- BETA_VERSION_BADGE -->"
BETA_BADGE_END = "<!-- BETA_VERSION_BADGE_END -->"
BETA_DL_START = "<!-- BETA_DOWNLOADS -->"
BETA_DL_END = "<!-- BETA_DOWNLOADS_END -->"
STABLE_BADGE_START = "<!-- STABLE_VERSION_BADGE -->"
STABLE_BADGE_END = "<!-- STABLE_VERSION_BADGE_END -->"
STABLE_DL_START = "<!-- STABLE_DOWNLOADS -->"
STABLE_DL_END = "<!-- STABLE_DOWNLOADS_END -->"
REPO_URL = "https://github.com/krovomi/WorkPilot-AI"
REPO_SLUG = os.environ.get("GITHUB_REPOSITORY", "krovomi/WorkPilot-AI")

# The platforms a release is expected to carry, and how to recognise each one
# among the release assets. Order is the order of the table.
#
# A row is written only when its asset is really attached to the release. The
# table used to be a fixed six-line template with the version substituted into
# it, which meant the README advertised every platform whether or not it had
# been built: v1.2.0 shipped without a macOS Intel build — the job packaged
# arm64 by mistake — and the README linked to a `darwin-x64.dmg` that returned
# a 404 for a whole release cycle.
PLATFORM_ASSETS = [
    ("Windows", "-win32-x64.exe"),
    ("macOS (Apple Silicon)", "-darwin-arm64.dmg"),
    ("macOS (Intel)", "-darwin-x64.dmg"),
    ("Linux", "-linux-x86_64.AppImage"),
    ("Linux (Debian)", "-linux-amd64.deb"),
    ("Linux (Flatpak)", "-linux-x86_64.flatpak"),
]

_TABLE_HEADER = "| Platform | Download |\n|----------|----------|\n"


def fetch_release_assets(version: str) -> list[str] | None:
    """Names of the assets attached to `v{version}`, or None if unknown.

    None means "could not ask" — no network, no token, release not published
    yet — and the caller falls back to listing every platform. It never means
    "the release has no assets": that case returns an empty list, and the
    caller writes a table with no rows rather than six dead links.
    """
    url = f"https://api.github.com/repos/{REPO_SLUG}/releases/tags/v{version}"
    request = urllib.request.Request(
        url, headers={"Accept": "application/vnd.github+json"}
    )
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        print(f"Could not read the assets of v{version}: {exc}")
        return None
    return [asset.get("name", "") for asset in payload.get("assets", [])]


def build_download_table(version: str, assets: list[str] | None) -> str:
    """The download table, listing only what the release actually carries."""
    if assets is None:
        print("Listing every platform: the release assets could not be read.")
        wanted = [(label, suffix) for label, suffix in PLATFORM_ASSETS]
    else:
        present = set(assets)
        wanted = [
            (label, suffix)
            for label, suffix in PLATFORM_ASSETS
            if f"WorkPilot-AI-{version}{suffix}" in present
        ]
        missing = [
            label
            for label, suffix in PLATFORM_ASSETS
            if f"WorkPilot-AI-{version}{suffix}" not in present
        ]
        if missing:
            # A warning, not a failure: a release that is short one platform is
            # still worth publishing, and a README that stays silent about the
            # gap is worse than one that simply does not offer the download.
            print(
                f"::warning::v{version} has no build for: {', '.join(missing)}. "
                "Those rows are left out of the README."
            )

    if not wanted:
        return (
            "_No binaries are attached to this release yet. "
            f"See [the release page]({REPO_URL}/releases/tag/v{version})._\n"
        )

    rows = "".join(
        f"| **{label}** | [WorkPilot-AI-{version}{suffix}]"
        f"({REPO_URL}/releases/download/v{version}/WorkPilot-AI-{version}{suffix}) |\n"
        for label, suffix in wanted
    )
    return _TABLE_HEADER + rows


def validate_version(version: str) -> bool:
    """Validate version string matches semver format."""
    return bool(SEMVER_PATTERN.match(version))


def update_section(
    text: str, start_marker: str, end_marker: str, replacements: list
) -> str:
    """Update content between markers with given replacements."""
    pattern = f"({re.escape(start_marker)})(.*?)({re.escape(end_marker)})"

    def replace_section(match):
        section = match.group(2)
        for old_pattern, new_value in replacements:
            section = re.sub(old_pattern, new_value, section)
        return match.group(1) + section + match.group(3)

    return re.sub(pattern, replace_section, text, flags=re.DOTALL)


def replace_section_content(
    text: str, start_marker: str, end_marker: str, new_content: str
) -> str:
    """Replace entire content between markers."""
    pattern = f"({re.escape(start_marker)})(.*?)({re.escape(end_marker)})"
    return re.sub(
        pattern,
        rf"\g<1>\n{new_content}\g<3>",
        text,
        flags=re.DOTALL,
    )


def section_has_links(text: str, start_marker: str, end_marker: str) -> bool:
    """Check if a section already contains download links."""
    pattern = f"{re.escape(start_marker)}(.*?){re.escape(end_marker)}"
    match = re.search(pattern, text, flags=re.DOTALL)
    if not match:
        return False
    return "WorkPilot-AI-" in match.group(1)


def _update_or_generate_downloads(content, start, end, version, semver):
    """Rewrite the download table from the assets the release actually has.

    Deliberately a regeneration and not a version substitution. Substituting
    carried every row forward untouched, so one release built without a
    platform left a dead link in the README for every release after it.
    """
    table = build_download_table(version, fetch_release_assets(version))
    return replace_section_content(content, start, end, table)


def _update_beta(content, version, version_badge, semver, semver_badge):
    """Update beta sections of README."""
    print(f"Updating BETA section to {version} (badge: {version_badge})")

    badge_line = f"[![Beta](https://img.shields.io/badge/beta-{version_badge}-orange?style=flat-square)]({REPO_URL}/releases/tag/v{version})\n"
    if section_has_links(content, BETA_BADGE_START, BETA_BADGE_END):
        content = re.sub(
            rf"beta-{semver_badge}-orange", f"beta-{version_badge}-orange", content
        )
        content = update_section(
            content,
            BETA_BADGE_START,
            BETA_BADGE_END,
            [(rf"tag/v{semver}\)", f"tag/v{version})")],
        )
    else:
        content = replace_section_content(
            content, BETA_BADGE_START, BETA_BADGE_END, badge_line
        )

    content = _update_or_generate_downloads(
        content, BETA_DL_START, BETA_DL_END, version, semver
    )
    return content


def _update_stable(content, version, version_badge, semver, semver_badge):
    """Update stable sections of README."""
    print(f"Updating STABLE section to {version} (badge: {version_badge})")

    # Stable version badge
    stable_badge = f"[![Stable](https://img.shields.io/badge/stable-{version_badge}-blue?style=flat-square)]({REPO_URL}/releases/tag/v{version})\n"
    if section_has_links(content, STABLE_BADGE_START, STABLE_BADGE_END):
        content = update_section(
            content,
            STABLE_BADGE_START,
            STABLE_BADGE_END,
            [
                (rf"stable-{semver_badge}-blue", f"stable-{version_badge}-blue"),
                (rf"tag/v{semver}\)", f"tag/v{version})"),
            ],
        )
    else:
        content = replace_section_content(
            content, STABLE_BADGE_START, STABLE_BADGE_END, stable_badge
        )

    # Download links
    content = _update_or_generate_downloads(
        content, STABLE_DL_START, STABLE_DL_END, version, semver
    )

    # Remove "no stable release yet" notice
    content = re.sub(r"> No stable release yet\.[^\n]*\n\n?", "", content)

    return content


def update_readme(version: str, is_prerelease: bool) -> bool:
    """
    Update README.md with new version.

    Returns:
        True if changes were made, False otherwise
    """
    version_badge = version.replace("-", "--")

    with open("README.md") as f:
        original_content = f.read()

    if is_prerelease:
        content = _update_beta(
            original_content, version, version_badge, SEMVER_RE, SEMVER_BADGE_RE
        )
    else:
        content = _update_stable(
            original_content, version, version_badge, SEMVER_RE, SEMVER_BADGE_RE
        )

    if content == original_content:
        print("No changes needed")
        return False

    with open("README.md", "w") as f:
        f.write(content)

    print(f"README.md updated for {version} (prerelease={is_prerelease})")
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Update README.md version badges and download links"
    )
    parser.add_argument("version", help="Version string (e.g., 2.8.0 or 2.8.0-beta.1)")
    parser.add_argument(
        "--prerelease", action="store_true", help="Mark as prerelease version"
    )
    args = parser.parse_args()

    if not validate_version(args.version):
        print(f"ERROR: Invalid version format: {args.version}", file=sys.stderr)
        print(
            "Expected format: X.Y.Z or X.Y.Z-prerelease.N (e.g., 2.8.0 or 2.8.0-beta.1)",
            file=sys.stderr,
        )
        sys.exit(1)

    is_prerelease = args.prerelease or ("-" in args.version)

    try:
        update_readme(args.version, is_prerelease)
    except FileNotFoundError:
        print("ERROR: README.md not found", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
