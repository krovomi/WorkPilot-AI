"""Generate the frontend fallback from the authoritative backend model registry."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/backend"))
from models_registry import provider_catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    output = ROOT / "apps/frontend/src/shared/constants/model-catalog.generated.json"
    expected = json.dumps(provider_catalog(), ensure_ascii=False, indent="\t") + "\n"
    if args.check:
        if (
            not output.exists()
            or json.loads(output.read_text(encoding="utf-8")) != provider_catalog()
        ):
            raise SystemExit(
                "Model catalogue is stale. Run python scripts/generate_model_catalog.py"
            )
    else:
        output.write_text(expected, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
