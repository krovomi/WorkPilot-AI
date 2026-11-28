"""The AI account side of a fake build (`e2e/ai-accounts-settings.e2e.ts`).

What the app gave the build process is written down, so the test can tell
which account each run used: the account the app names for OpenAI
(`WORKPILOT_AI_ACCOUNTS`, read by the real `foundation.ai_account`), a digest
of the key it put in `OPENAI_API_KEY` (never the key itself), and the code
mode and microVM switches every agent process receives. One line per run in
`e2e-account-runs.jsonl` of the spec folder.

An account the test names in `e2e-saturated-accounts` (one id per line) is
out of quota: the run stops at once with the words OpenAI's SDK prints on a
429, as a real coder session would. Any other run spends a fixed amount,
recorded by the real `core.usage_tracker`, which names the account beside the
spend: that is what Settings → AI accounts adds up for the month. A run the
app gave no account (the other specs) is only written down.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from core.usage_tracker import record_session_usage
from foundation.ai_account import account_for

RUNS_FILE = "e2e-account-runs.jsonl"
SATURATED_FILE = "e2e-saturated-accounts"
#: What one fake coder session costs, in US dollars.
SESSION_COST_USD = 0.9
#: What OpenAI's Python SDK raises on a spent rate limit, as the agent prints it.
RATE_LIMIT_ERROR = (
    "Error code: 429 - {'error': {'message': 'Rate limit reached for gpt-e2e "
    "on requests per min (RPM): Limit 3, Used 3, Requested 1.', "
    "'type': 'requests', 'code': 'rate_limit_exceeded'}}"
)


def _key_digest(key: str | None) -> str | None:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16] if key else None


def _safety(raw: str | None) -> dict:
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _saturated(spec_dir: Path) -> set[str]:
    try:
        text = (spec_dir / SATURATED_FILE).read_text(encoding="utf-8")
    except OSError:
        return set()
    return {line.strip() for line in text.splitlines() if line.strip()}


def start_session(spec_dir: Path, project_dir: Path) -> int | None:
    """Write the run down; an exit code when its account is out of quota, else None."""
    account = account_for("openai")
    sandbox = _safety(os.environ.get("WORKPILOT_AGENT_SAFETY")).get("sandbox")
    microvm = sandbox.get("microvm") if isinstance(sandbox, dict) else None
    run = {
        "account": account,
        "key": _key_digest(os.environ.get("OPENAI_API_KEY")),
        "codeMode": os.environ.get("WORKPILOT_CODE_MODE"),
        "microvm": isinstance(microvm, dict) and microvm.get("enabled") is True,
    }
    with (spec_dir / RUNS_FILE).open("a", encoding="utf-8") as runs:
        runs.write(json.dumps(run) + "\n")
    if account is None:
        # A build the app gave no account (the other specs): nothing to bill.
        return None
    if account in _saturated(spec_dir):
        print(RATE_LIMIT_ERROR, flush=True)
        return 1
    record_session_usage(
        spec_dir,
        project_dir,
        phase="coding",
        agent_type="coder",
        model="gpt-e2e",
        provider="openai",
        input_tokens=12_000,
        output_tokens=3_000,
        cost_usd=SESSION_COST_USD,
    )
    return None
