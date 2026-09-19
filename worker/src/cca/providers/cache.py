"""Our own idempotency for model calls (Jev offers no idempotency keys).

A successful answer stored for (packet SHA-256, question-set version, model) is reused instead of
calling again: on job retries, reprocessing, or replays. The lookup runs under the tenant's RLS
context, so answers never cross tenants.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from cca.db import Connection
from cca.providers.base import CallRecord, ClassificationOutcome, DecisionModelProvider
from cca.providers.jev_answers import MalformedAnswersError, validate_answers
from cca.providers.jev_questions_v1 import VERSION


def load_cached_answers(conn: Connection, provider: str, model: str) -> dict[str, dict[str, Any]]:
    """packet_sha256 -> answers for this tenant's successful calls. Call inside tenant_transaction."""
    rows = conn.execute(
        "SELECT DISTINCT ON (packet_sha256) packet_sha256, answers FROM model_call "
        "WHERE provider = %s AND model_requested = %s AND question_set_version = %s AND status = 'succeeded' "
        "ORDER BY packet_sha256, created_at DESC",
        (provider, model, VERSION),
    ).fetchall()
    return {r["packet_sha256"]: r["answers"] for r in rows if r["answers"]}


@dataclass
class CachingProvider:
    inner: DecisionModelProvider
    cache: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def name(self) -> str:
        return self.inner.name

    @property
    def model(self) -> str:
        return self.inner.model

    def classify(self, packet: dict[str, Any], packet_sha256: str) -> ClassificationOutcome:
        cached = self.cache.get(packet_sha256)
        if cached is not None:
            try:
                classification = validate_answers(cached)
            except MalformedAnswersError:
                pass  # never trust a bad cache entry; ask again
            else:
                record = CallRecord(
                    provider=self.name, model_requested=self.model, model_reported=None, request_id=None,
                    question_set_version=VERSION, packet_sha256=packet_sha256, status="cached", attempt=0,
                    latency_ms=0, input_tokens=None, answers=None, error_class=None,
                )
                return ClassificationOutcome(classification, None, False, [record])
        outcome = self.inner.classify(packet, packet_sha256)
        if outcome.classification is not None:
            succeeded = next((c for c in outcome.calls if c.status == "succeeded"), None)
            if succeeded and succeeded.answers:
                self.cache[packet_sha256] = succeeded.answers
        return outcome
