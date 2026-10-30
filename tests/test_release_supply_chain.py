"""A release says what it is built from and where it was built (plan of 29 October, S3).

The binaries are not code-signed, so the published checksums only prove that a
download matches the release page. The SBOM lists the npm and Python packages
the release is built from; the build provenance attestation ties each file to
the workflow run that built it (``gh attestation verify``).
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / ".github" / "workflows" / "release.yml"
SBOM = "release-assets/workpilot-sbom.cdx.json"


def _job() -> dict:
    workflow = yaml.safe_load(RELEASE.read_text(encoding="utf-8"))
    return workflow["jobs"]["create-release"]


def _index(steps: list[dict], predicate) -> int:
    return next(i for i, step in enumerate(steps) if predicate(step))


def _uses(name: str):
    return lambda step: str(step.get("uses", "")).startswith(name + "@")


def test_the_sbom_is_written_from_the_checkout_into_the_release_files():
    steps = _job()["steps"]
    sbom = _index(steps, _uses("anchore/sbom-action"))
    download = _index(steps, _uses("actions/download-artifact"))
    publish = _index(steps, _uses("softprops/action-gh-release"))
    options = steps[sbom]["with"]
    assert options["format"] == "cyclonedx-json"
    assert options["output-file"] == SBOM
    assert options["path"] == "."
    # Read before the binaries land beside the sources, published with them.
    assert sbom < download < publish
    assert steps[publish]["with"]["files"] == "release-assets/*"


def test_every_published_file_is_attested_before_it_is_published():
    job = _job()
    steps = job["steps"]
    attest = _index(steps, _uses("actions/attest-build-provenance"))
    checksums = _index(steps, lambda s: s.get("name") == "Generate checksums")
    publish = _index(steps, _uses("softprops/action-gh-release"))
    assert checksums < attest < publish
    assert steps[attest]["with"]["subject-path"] == "release-assets/*"
    # Attested exactly when the release is published, not on a dry run.
    assert steps[attest]["if"] == steps[publish]["if"]
    assert job["permissions"]["id-token"] == "write"
    assert job["permissions"]["attestations"] == "write"


def test_the_release_notes_say_how_to_verify():
    body = _job()["steps"][
        _index(_job()["steps"], _uses("softprops/action-gh-release"))
    ]["with"]["body"]
    assert Path(SBOM).name in body
    assert re.search(r"gh attestation verify \S+ --repo", body)


def test_no_other_job_may_mint_an_identity_token():
    workflow = yaml.safe_load(RELEASE.read_text(encoding="utf-8"))
    assert workflow["permissions"] == {"contents": "read"}
    holders = [
        name
        for name, job in workflow["jobs"].items()
        if (job.get("permissions") or {}).get("id-token") == "write"
    ]
    # build-windows signs through Azure with its own token; nothing else may.
    assert holders == ["build-windows", "create-release"]
