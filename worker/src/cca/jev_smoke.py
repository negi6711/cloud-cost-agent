"""One real Jev call on SYNTHETIC data, to verify the live contract end to end.

    uv run python -m cca.jev_smoke

Sends the evidence packets of fixtures/valid_cost_explorer.csv (invented numbers, no customer data)
to TypeSafe Jev with the pinned model and question set, then prints what came back. Touches no
database. Requires TYPESAFE_API_KEY in the environment (.env); the key is never printed.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import date

from cca.parsers import parse_billing_export
from cca.providers.jev import JevProvider
from cca.settings import REPO_ROOT, get_settings
from cca.snapshots.analyze import analyze
from cca.snapshots.explain import TemplateExplanationProvider

FIXTURE = REPO_ROOT / "fixtures" / "valid_cost_explorer.csv"


def main() -> int:
    settings = get_settings()
    key = settings.typesafe_api_key.get_secret_value() if settings.typesafe_api_key else ""
    if not key:
        print("TYPESAFE_API_KEY is not set in .env", file=sys.stderr)
        return 2

    data = FIXTURE.read_bytes()
    result = parse_billing_export(data, today=date(2026, 9, 18))
    provider = JevProvider(key, settings.jev_model, base_url=settings.jev_base_url,
                           timeout_s=settings.jev_timeout_ms / 1000, max_retries=settings.jev_max_retries)
    try:
        analysis = analyze(result, hashlib.sha256(data).hexdigest(), provider, TemplateExplanationProvider(),
                           settings.jev_low_confidence_threshold, concurrency=2)
    finally:
        provider.close()

    report = []
    for f in analysis.findings:
        call = f.outcome.calls[0] if f.outcome.calls else None
        c = f.outcome.classification
        report.append({
            "finding": f.candidate.label,
            "status": call.status if call else None,
            "model_requested": call.model_requested if call else None,
            "model_reported": call.model_reported if call else None,
            "request_id": call.request_id if call else None,
            "latency_ms": call.latency_ms if call else None,
            "input_tokens": call.input_tokens if call else None,
            "error_class": call.error_class if call else None,
            "jev_category": c.category.value if c else None,
            "category_confidence": c.category_answer.confidence if c else None,
            "owner": c.owner.value if c else None,
            "change_material": c.change_material if c else None,
            "final_category": f.decision.final_category.value,
            "policy": f.decision.policy_status,
            "reasons": list(f.decision.reasons),
        })
    print(json.dumps(report, indent=2))
    return 0 if all(r["status"] == "succeeded" for r in report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
