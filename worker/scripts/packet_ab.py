"""Does a richer evidence packet make the classifier sound? (ADR 0004)

Runs a corpus twice through the real classifier: once with packet v1, once with v2. Same findings,
same questions, same thresholds — the packet is the only thing that changes.

    CCA_TODAY=2026-08-18 JEV_ENABLED=true JEV_PROVIDER=typesafe \\
        uv run python scripts/packet_ab.py ../fixtures/icp

The bars were fixed before the first run (ADR 0004):

    median category confidence  >= 0.60   (v1 baseline on the old corpus: 0.43)
    distinct categories used    >= 3 of 4 (v1 baseline: 2)
    evidence_sufficient / needs_human_review stop being constant
    owner confidence on service findings >= 0.60

Costs one call per finding per variant. Writes nothing.
"""

from __future__ import annotations

import os
import statistics
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import date
from hashlib import sha256
from pathlib import Path

from cca.parsers import ParseError, parse_billing_export
from cca.providers.base import UnavailableProvider
from cca.providers.factory import CONSENT_GRANTED, provider_factory
from cca.settings import get_settings
from cca.snapshots.analyze import analyze
from cca.snapshots.explain import TemplateExplanationProvider
from cca.snapshots.packet import PACKET_V1, PACKET_V2

TODAY = date.fromisoformat(os.environ.get("CCA_TODAY", "2026-08-18"))


@dataclass
class Answer:
    file: str
    label: str
    dimension: str
    rules: str
    category: str
    confidence: float
    owner: str
    owner_confidence: float
    evidence_sufficient: float
    needs_review: float
    change_material: float


def run_variant(folder: Path, version: str) -> list[Answer]:
    settings = get_settings()
    factory = provider_factory(settings)
    out: list[Answer] = []
    for path in sorted(folder.glob("*.csv")):
        if path.name == "manifest.csv":
            continue
        data = path.read_bytes()
        try:
            result = parse_billing_export(data, today=TODAY)
        except ParseError:
            continue
        provider = factory(CONSENT_GRANTED, 0)
        analysis = analyze(result, sha256(data).hexdigest(), provider, TemplateExplanationProvider(),
                           settings.jev_low_confidence_threshold, settings.jev_concurrency,
                           settings.jev_noul_margin_threshold, packet_version=version)
        close = getattr(provider, "close", None)
        if callable(close):
            close()
        for f in analysis.findings:
            c = f.outcome.classification
            if c is None:
                continue
            out.append(Answer(
                file=path.name[:2], label=f.candidate.label[:26], dimension=f.candidate.dimension,
                rules=f.candidate.default_category.value, category=c.category.value,
                confidence=c.category_answer.confidence, owner=c.owner.value,
                owner_confidence=c.owner_answer.confidence, evidence_sufficient=c.evidence_sufficient,
                needs_review=c.needs_human_review, change_material=c.change_material,
            ))
    return out


@dataclass
class Summary:
    variant: str
    findings: int
    median_confidence: float
    confidence_range: str
    categories_used: int
    category_counts: dict[str, int]
    median_owner_confidence: float
    evidence_sufficient_distinct: int
    needs_review_over_half: int
    agreed_with_rules: int


def summarise(name: str, answers: list[Answer]) -> Summary:
    confidences = sorted(a.confidence for a in answers)
    owner_conf = [a.owner_confidence for a in answers if a.dimension == "service"]
    categories = Counter(a.category for a in answers)
    return Summary(
        variant=name,
        findings=len(answers),
        median_confidence=round(statistics.median(confidences), 3) if confidences else 0.0,
        confidence_range=f"{confidences[0]:.2f}-{confidences[-1]:.2f}" if confidences else "-",
        categories_used=len(categories),
        category_counts=dict(categories),
        median_owner_confidence=round(statistics.median(owner_conf), 3) if owner_conf else 0.0,
        evidence_sufficient_distinct=len({round(a.evidence_sufficient, 2) for a in answers}),
        needs_review_over_half=sum(1 for a in answers if a.needs_review >= 0.5),
        agreed_with_rules=sum(1 for a in answers if a.category == a.rules),
    )


def main(folder: str) -> None:
    settings = get_settings()
    if isinstance(provider_factory(settings)(CONSENT_GRANTED, 0), UnavailableProvider):
        print("no classifier available; set JEV_ENABLED=true and TYPESAFE_API_KEY")
        raise SystemExit(1)
    print(f"classifier {settings.jev_provider} {settings.jev_model}, corpus {folder}, today {TODAY}\n")

    results = {v: run_variant(Path(folder), v) for v in (PACKET_V1, PACKET_V2)}
    v1, v2 = results[PACKET_V1], results[PACKET_V2]

    print(f"{'file':<5}{'finding':<28}{'rules':<17}{'v1':<17}{'conf':<6}{'v2':<17}{'conf':<6}{'moved'}")
    by_key = {(a.file, a.label): a for a in v2}
    for a in v1:
        b = by_key.get((a.file, a.label))
        if b is None:
            continue
        moved = "" if a.category == b.category else "CHANGED"
        print(f"{a.file:<5}{a.label:<28}{a.rules:<17}{a.category:<17}{a.confidence:<6.2f}"
              f"{b.category:<17}{b.confidence:<6.2f}{moved}")

    print()
    for row in (summarise("v1 (thin packet)", v1), summarise("v2 (enriched)", v2)):
        print(f"  {row.variant:<20} findings {row.findings:<4} "
              f"median confidence {row.median_confidence:<6} range {row.confidence_range:<12} "
              f"categories {row.categories_used} {row.category_counts}")
        print(f"  {'':<20} median owner confidence {row.median_owner_confidence:<6} "
              f"evidence_sufficient distinct values {row.evidence_sufficient_distinct:<4} "
              f"needs_review>=0.5 on {row.needs_review_over_half}/{row.findings}  "
              f"agreed with rules {row.agreed_with_rules}/{row.findings}")

    s2 = summarise("v2", v2)
    bars = {
        "median category confidence >= 0.60": s2.median_confidence >= 0.60,
        "at least 3 of 4 categories used": s2.categories_used >= 3,
        "evidence_sufficient is not constant": s2.evidence_sufficient_distinct > 1,
        "needs_human_review is not constant": 0 < s2.needs_review_over_half < len(v2),
        "median owner confidence (service findings) >= 0.60": s2.median_owner_confidence >= 0.60,
    }
    print("\npre-committed bars (ADR 0004):")
    for bar, passed in bars.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {bar}")
    print(f"\n{sum(bars.values())} of {len(bars)} cleared")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "../fixtures/icp")
