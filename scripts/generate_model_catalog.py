"""Generate the frontend fallbacks from the authoritative backend data.

- model-catalog.generated.json: the model registry (models_registry.py).
- model-pricing.generated.json: the input and output prices of the pricing
  catalog (cost_intelligence/catalog.py), for the renderer's cost previews.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/backend"))
from cost_intelligence.catalog import renderer_price_data
from models_registry import provider_catalog

CONSTANTS = ROOT / "apps/frontend/src/shared/constants"
OUTPUTS = {
    CONSTANTS / "model-catalog.generated.json": provider_catalog,
    CONSTANTS / "model-pricing.generated.json": renderer_price_data,
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for output, build in OUTPUTS.items():
        data = build()
        if args.check:
            if (
                not output.exists()
                or json.loads(output.read_text(encoding="utf-8")) != data
            ):
                raise SystemExit(
                    f"{output.name} is stale. Run python scripts/generate_model_catalog.py"
                )
        else:
            expected = json.dumps(data, ensure_ascii=False, indent="\t") + "\n"
            output.write_text(expected, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
