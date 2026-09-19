"""Replay a run's stored evidence packets without the customer's raw file. Read-only.

    uv run python -m cca.replay --tenant <uuid> --run <uuid>          # re-validate stored answers
    uv run python -m cca.replay --tenant <uuid> --run <uuid> --live   # ask the configured provider again

Use it to check a new Jev version or question-set change against real past packets (calibration),
or to confirm that stored answers still pass validation. `--live` is refused when the run's
consent was not granted: replay never sends data the prospect did not agree to send.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from cca.db import Connection, connect, tenant_transaction
from cca.providers.base import DecisionModelProvider, UnavailableProvider
from cca.providers.factory import CONSENT_GRANTED, provider_factory
from cca.providers.jev_answers import MalformedAnswersError, validate_answers
from cca.settings import get_settings


@dataclass(frozen=True)
class ReplayRow:
    evidence_id: str
    stored_category: str | None
    stored_confidence: float | None
    replay_category: str | None
    replay_confidence: float | None
    note: str

    @property
    def changed(self) -> bool:
        return self.stored_category != self.replay_category


def load(conn: Connection, tenant_id: UUID, run_id: UUID) -> tuple[str | None, list[dict[str, Any]]]:
    with tenant_transaction(conn, tenant_id):
        run = conn.execute("SELECT consent_basis FROM snapshot_run WHERE id = %s", (run_id,)).fetchone()
        if run is None:
            raise SystemExit("run not found for this tenant")
        rows = conn.execute(
            "SELECT p.evidence_id, p.sha256, p.packet, "
            "  (SELECT answers FROM model_call m WHERE m.snapshot_run_id = p.snapshot_run_id "
            "     AND m.packet_sha256 = p.sha256 AND m.status = 'succeeded' ORDER BY created_at DESC LIMIT 1) AS answers "
            "FROM evidence_packet p WHERE p.snapshot_run_id = %s ORDER BY p.evidence_id",
            (run_id,),
        ).fetchall()
    return run["consent_basis"], [dict(r) for r in rows]


def replay(rows: list[dict[str, Any]], provider: DecisionModelProvider | None) -> list[ReplayRow]:
    out: list[ReplayRow] = []
    for row in rows:
        stored_cat = stored_conf = None
        note = "no stored answer"
        if row["answers"]:
            try:
                c = validate_answers(row["answers"])
                stored_cat, stored_conf, note = c.category.value, c.category_answer.confidence, "stored answer valid"
            except MalformedAnswersError as exc:
                note = f"stored answer invalid: {exc}"
        replay_cat, replay_conf = stored_cat, stored_conf
        if provider is not None:
            outcome = provider.classify(row["packet"], row["sha256"])
            if outcome.classification is None:
                replay_cat = replay_conf = None
                note = f"replay unavailable: {outcome.unavailable_reason}"
            else:
                replay_cat = outcome.classification.category.value
                replay_conf = outcome.classification.category_answer.confidence
        out.append(ReplayRow(row["evidence_id"], stored_cat, stored_conf, replay_cat, replay_conf, note))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tenant", type=UUID, required=True)
    parser.add_argument("--run", type=UUID, required=True)
    parser.add_argument("--live", action="store_true", help="ask the configured provider again")
    args = parser.parse_args(argv)

    settings = get_settings()
    with connect(settings.database_url) as conn:
        consent, rows = load(conn, args.tenant, args.run)

    provider: DecisionModelProvider | None = None
    if args.live:
        if consent != CONSENT_GRANTED:
            print("refused: this run's consent was not granted, so its packets may not be sent", file=sys.stderr)
            return 2
        provider = provider_factory(settings)(consent, 0)
        if isinstance(provider, UnavailableProvider):
            print(f"refused: provider unavailable ({provider.reason})", file=sys.stderr)
            return 2

    results = replay(rows, provider)
    print(json.dumps([r.__dict__ | {"changed": r.changed} for r in results], indent=2))
    return 1 if any(r.changed for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
