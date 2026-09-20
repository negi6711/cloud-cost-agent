"""Does Jev change any decision, or does it agree with our rules?

Runs a folder of billing CSVs through the real classifier and compares three answers per finding:
the deterministic default our rules produce on their own, Jev's suggestion, and the category the
policy gate finally publishes. Read-only: nothing is written to the database or to storage.

    uv run python scripts/jev_agreement.py <folder>

Costs a small number of TypeSafe calls (one per finding). The key is read from the repo .env.
"""

from __future__ import annotations

import sys
from collections import Counter
from datetime import date
from hashlib import sha256
from pathlib import Path

from cca.parsers import ParseError, parse_billing_export
from cca.providers.base import UnavailableProvider
from cca.providers.factory import CONSENT_GRANTED, provider_factory
from cca.settings import get_settings
from cca.snapshots.analyze import analyze
from cca.snapshots.explain import TemplateExplanationProvider

TODAY = date(2026, 7, 15)


def main(folder: str) -> None:
    settings = get_settings()
    factory = provider_factory(settings)
    probe = factory(CONSENT_GRANTED, 0)
    if isinstance(probe, UnavailableProvider):
        print(f"no classifier available: {probe.reason}. Set JEV_ENABLED=true and TYPESAFE_API_KEY in .env.")
        raise SystemExit(1)
    print(f"classifier: {settings.jev_provider} {settings.jev_model}\n")

    rows: list[tuple[str, str, str, str, str, float | None, bool, str]] = []
    for path in sorted(Path(folder).glob("*.csv")):
        if path.name == "manifest.csv":
            continue
        data = path.read_bytes()
        try:
            result = parse_billing_export(data, today=TODAY)
        except ParseError as exc:
            print(f"{path.name}: rejected ({exc})")
            continue
        provider = factory(CONSENT_GRANTED, 0)
        analysis = analyze(result, sha256(data).hexdigest(), provider, TemplateExplanationProvider(),
                           settings.jev_low_confidence_threshold, settings.jev_concurrency,
                           settings.jev_noul_margin_threshold)
        close = getattr(provider, "close", None)
        if callable(close):
            close()
        for f in analysis.findings:
            cls = f.outcome.classification
            rows.append((
                path.name[:2],
                f.candidate.label[:28],
                f.candidate.default_category.value,
                cls.category.value if cls else "-",
                f.decision.final_category.value,
                cls.category_answer.confidence if cls else None,
                f.decision.review_required,
                ",".join(f.decision.reasons),
            ))
        print(f"{path.name}: {len(analysis.findings)} findings")

    print(f"\n{'file':<5}{'finding':<30}{'rules':<18}{'jev':<18}{'final':<18}{'conf':<7}{'review'}")
    agree = Counter[str]()
    for name, label, rule, jev, final, conf, review, reasons in rows:
        flag = "same" if rule == jev else "DIFFERENT"
        agree[flag] += 1
        agree["overridden"] += 1 if jev not in ("-", final) else 0
        print(f"{name:<5}{label:<30}{rule:<18}{jev:<18}{final:<18}"
              f"{'' if conf is None else f'{conf:.2f}':<7}{'yes' if review else 'no'}")

    total = len(rows)
    print(f"\n{total} findings across the folder")
    print(f"  Jev agreed with our rules : {agree['same']} ({agree['same'] * 100 // max(total, 1)}%)")
    print(f"  Jev suggested something else: {agree['DIFFERENT']}")
    print(f"  gate overrode Jev         : {agree['overridden']}")
    print(f"  flagged for human review  : {sum(1 for r in rows if r[6])}")
    confidences = sorted(r[5] for r in rows if r[5] is not None)
    if confidences:
        mid = confidences[len(confidences) // 2]
        print(f"  confidence: min {confidences[0]:.2f}, median {mid:.2f}, max {confidences[-1]:.2f}")
    reason_counts = Counter(r for row in rows for r in row[7].split(",") if r)
    for reason, n in reason_counts.most_common():
        print(f"  reason {reason}: {n}")


if __name__ == "__main__":
    main(sys.argv[1])
