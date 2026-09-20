"""Print the report a visitor would read, for every export in a folder.

Same pipeline as the worker, real classifier, nothing written anywhere. Used to review wording and
finding quality across a test corpus without uploading each file by hand.

    uv run python scripts/render_reports.py <folder> [file-number-prefix ...]
"""

from __future__ import annotations

import os
import sys
from datetime import date
from decimal import Decimal
from hashlib import sha256
from pathlib import Path

from cca.parsers import ParseError, parse_billing_export
from cca.providers.base import UnavailableProvider
from cca.providers.factory import CONSENT_GRANTED, provider_factory
from cca.settings import get_settings
from cca.snapshots.analyze import analyze
from cca.snapshots.explain import TemplateExplanationProvider

# The corpus states the date it was "exported on"; a month-to-date period can only be detected
# relative to that. Override with CCA_TODAY=YYYY-MM-DD.
TODAY = date.fromisoformat(os.environ.get("CCA_TODAY", "2026-07-15"))


def money(amount: str | Decimal | None, currency: str | None) -> str:
    if amount is None:
        return "—"
    value = Decimal(str(amount))
    sign = "-" if value < 0 else ""
    return f"{sign}{'$' if currency == 'USD' else ''}{abs(value):,.2f}"


def main(folder: str, *only: str) -> None:
    settings = get_settings()
    factory = provider_factory(settings)
    if isinstance(factory(CONSENT_GRANTED, 0), UnavailableProvider):
        print("no classifier available; set JEV_ENABLED=true and TYPESAFE_API_KEY")
        raise SystemExit(1)

    for path in sorted(Path(folder).glob("*.csv")):
        if path.name == "manifest.csv" or (only and not path.name.startswith(tuple(only))):
            continue
        data = path.read_bytes()
        print("\n" + "=" * 100)
        print(f"FILE {path.name}")
        print("=" * 100)
        try:
            result = parse_billing_export(data, today=TODAY)
        except ParseError as exc:
            print(f"  REFUSED: {exc}")
            continue

        analysis = analyze(result, sha256(data).hexdigest(), factory(CONSENT_GRANTED, 0),
                           TemplateExplanationProvider(), settings.jev_low_confidence_threshold,
                           settings.jev_concurrency, settings.jev_noul_margin_threshold)
        s = analysis.summary
        cur = s["currency"]
        comp = s["comparison"]

        print("\nTEASER (shown before the email gate)")
        if comp:
            pct = f"{Decimal(comp['delta_pct']) * 100:.1f}%" if comp["delta_pct"] else "—"
            print(f"  Your spend changed by {money(comp['delta'], cur)} ({pct}) in {comp['current_month']}")
            print(f"  compared with {comp['baseline_month']}")
        else:
            print("  (no comparable pair: the teaser shows the total covered only)")
        print(f"  Spend covered: {money(s['total'], cur)}")
        largest = s["largest_changes"].get(s["dimension"], [])
        top = next((r for r in largest if Decimal(r["delta"]) > 0), None)
        print(f"  Largest driver: {top['label'] + ' +' + money(top['delta'], cur) if top else 'none'}")
        print(f"  Cost impact to investigate: {money(s['investigation_impact'], cur)}")
        print(f"  Data readiness: {s['readiness']['score']}/100")
        for issue in result.issues:
            print(f"  issue [{issue.severity}] {issue.code}: {issue.message}")
        for gap in s["data_gaps"]:
            print(f"  gap: {gap['message']}")

        print(f"\nREPORT: {len(analysis.findings)} finding(s)")
        for f in analysis.findings:
            card, d, cls = f.card, f.decision, f.outcome.classification
            print(f"\n  [{d.final_category.value}] #{f.rank} · {f.candidate.severity.value} severity")
            print(f"  {card.title}")
            print(f"    WHAT CHANGED: {card.what_changed}")
            for st in card.what_we_know:
                print(f"    - {st.text}")
            print(f"    MISSING: {', '.join(m.value for m in card.missing) or 'nothing'}")
            print(f"    NEXT: {card.next_action}")
            if cls:
                print(f"    CLASSIFICATION: Jev suggested {cls.category.value} "
                      f"({cls.category_answer.confidence:.0%} confidence); rules alone: "
                      f"{f.candidate.default_category.value}; published: {d.final_category.value}")
                print(f"    owner {cls.owner.value} · urgency {cls.urgency.label} · risk {cls.risk.label}")
            else:
                print("    CLASSIFICATION: none")
            print(f"    REVIEW: {'required' if d.review_required else 'no'} ({', '.join(d.reasons) or 'no reasons'})")


if __name__ == "__main__":
    main(*sys.argv[1:])
