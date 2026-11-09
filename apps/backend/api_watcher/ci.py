"""A CI job that refuses a breaking contract change, for the project's own CI (#389).

Generated, as a GitHub Actions workflow, for the contracts the project has,
with the reference tool of each format, so the gate runs without WorkPilot
(the same commands run in any CI that has git and Docker): `oasdiff` (OpenAPI),
`buf breaking` (protobuf), `graphql-inspector diff` (GraphQL). Each tool is
pinned to a version and, for the images, a digest (supply chain). WorkPilot
only shows the text; the person copies it into their CI.

``x-breaking-acknowledged`` is WorkPilot's annotation: these tools do not read
it. A break meant on purpose is waived with each tool's own mechanism
(oasdiff ``--err-ignore``, buf ``breaking.ignore``, graphql-inspector
``--rule``), which the comment of each step names.
"""

from __future__ import annotations

import json
import re
from pathlib import PurePosixPath

OASDIFF_IMAGE = "tufin/oasdiff:v1.34.1@sha256:67a23cfea7d251e2ae34ee703ac8733c5d96bc2e7b90fd0f4d475ec99367b85f"
BUF_IMAGE = "bufbuild/buf:1.75.0@sha256:adf82c7170be6629ec81dc907921ac1699407cd11c4f7fd7521b13c74152f849"
GRAPHQL_INSPECTOR = "@graphql-inspector/cli@7.0.2"
CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"

_OPENAPI_SUFFIXES = (".yaml", ".yml", ".json")
_GRAPHQL_SUFFIXES = (".graphql", ".graphqls", ".gql")


#: A path written into a shell command and a YAML file: a file name with a
#: quote, a ``$`` or a backtick is left out rather than escaped.
_SAFE_PATH = re.compile(r"^[\w][\w./ -]{0,199}$")
_SAFE_REF = re.compile(r"^[\w][\w./-]{0,99}$")


def _quote(path: str) -> str:
    return "'" + path.replace("'", "'\\''") + "'"


def commands(contracts: list[str], target: str) -> list[tuple[str, str]]:
    """(step name, shell command) for each contract, ``$BASE`` the target ref."""
    steps: list[tuple[str, str]] = []
    contracts = [p for p in contracts if _SAFE_PATH.match(p) and ".." not in p]
    proto_dirs = sorted(
        {str(PurePosixPath(p).parent) for p in contracts if p.endswith(".proto")}
    )
    for path in contracts:
        q = _quote(path)
        if path.endswith(_OPENAPI_SUFFIXES):
            steps.append(
                (
                    f"OpenAPI {path}",
                    f'if git show "$BASE:{path}" > /tmp/base-openapi 2>/dev/null; then\n'
                    f'  docker run --rm -v "$PWD:/w" -v /tmp:/t -w /w {OASDIFF_IMAGE} '
                    f"breaking /t/base-openapi {q} --fail-on ERR\n"
                    "fi",
                )
            )
        elif path.endswith(_GRAPHQL_SUFFIXES):
            steps.append(
                (
                    f"GraphQL {path}",
                    f'if git cat-file -e "$BASE:{path}" 2>/dev/null; then\n'
                    f"  npx --yes {GRAPHQL_INSPECTOR} diff "
                    f'"git:$BASE:{path}" {q}\n'
                    "fi",
                )
            )
    for directory in proto_dirs:
        q = _quote(directory)
        steps.append(
            (
                f"protobuf {directory}",
                f'docker run --rm -v "$PWD:/w" -w /w {BUF_IMAGE} breaking {q} '
                f'--against ".git#ref=$BASE,subdir={directory}"',
            )
        )
    return steps


def github_actions(contracts: list[str], target: str = "develop") -> str:
    target = target if _SAFE_REF.match(target or "") else "develop"
    lines = [
        "# .github/workflows/api-contract.yml — refuses a breaking API change.",
        "# A break meant on purpose: oasdiff --err-ignore, buf breaking.ignore,",
        "# graphql-inspector --rule (see each tool's documentation).",
        "name: API contract",
        "on:",
        "  pull_request:",
        f"    branches: [{target}]",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  breaking-changes:",
        "    runs-on: ubuntu-latest",
        "    env:",
        f"      BASE: origin/{target}",
        "    steps:",
        f"      - uses: {CHECKOUT}",
        "        with:",
        "          fetch-depth: 0",
        "          persist-credentials: false",
    ]
    for name, command in commands(contracts, target):
        lines.append(f"      - name: {json.dumps(name)}")
        lines.append("        run: |")
        lines += [f"          {line}" for line in command.split("\n")]
    return "\n".join(lines) + "\n"
