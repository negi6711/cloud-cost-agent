"""TypeSafe Jev provider — the only module that imports the TypeSafe SDK (enforced by a test).

Contract (verified 2026-09-18, docs/adr/0001-jev-integration.md): POST /v1/systemone via
`TypeSafeClient.system_one(state, questions, model=...)`; answers are typed choice/score/noul;
the request ID is the `x-typesafe-request-id` header. The SDK retries 408/429/5xx (incl. 529) and
connection errors itself, with backoff and Retry-After; this provider maps what is left over.
"""

from __future__ import annotations

import time
from typing import Any

import httpx2
import structlog
from typesafe_sdk import (
    RetryPolicy,
    TypeSafeAPIConnectionError,
    TypeSafeAPIError,
    TypeSafeAPIResponseValidationError,
    TypeSafeAuthenticationError,
    TypeSafeClient,
    TypeSafeError,
    TypeSafePermissionDeniedError,
)

from cca.providers.base import CallRecord, ClassificationOutcome, UnavailableReason
from cca.providers.jev_answers import MalformedAnswersError, validate_answers
from cca.providers.jev_questions_v1 import VERSION, questions

log = structlog.get_logger("cca.providers.jev")

PROVIDER_NAME = "typesafe"
_NON_RETRYABLE_STATUS = {400, 401, 403, 404, 422}


class JevProvider:
    name = PROVIDER_NAME

    def __init__(
        self,
        api_key: str,
        model: str,
        *,
        base_url: str | None = None,
        timeout_s: float = 30.0,
        max_retries: int = 2,
        attempt: int = 1,
        transport: httpx2.BaseTransport | None = None,
    ) -> None:
        self.model = model
        self.attempt = attempt
        self._client = TypeSafeClient(
            api_key=api_key,
            model=model,
            base_url=base_url,
            timeout=timeout_s,
            retry=RetryPolicy(max_retries=max_retries, timeout=timeout_s),
            transport=transport,
        )
        self._questions = questions()

    def close(self) -> None:
        self._client.close()

    def _record(self, sha: str, status: str, started: float, **kw: Any) -> CallRecord:
        return CallRecord(
            provider=self.name,
            model_requested=self.model,
            model_reported=kw.get("model_reported"),
            request_id=kw.get("request_id"),
            question_set_version=VERSION,
            packet_sha256=sha,
            status=status,
            attempt=self.attempt,
            latency_ms=round((time.monotonic() - started) * 1000),
            input_tokens=kw.get("input_tokens"),
            answers=kw.get("answers"),
            error_class=kw.get("error_class"),
        )

    def classify(self, packet: dict[str, Any], packet_sha256: str) -> ClassificationOutcome:
        started = time.monotonic()
        try:
            response = self._client.system_one(packet, self._questions, model=self.model)
        except TypeSafeAPIResponseValidationError as exc:
            return self._failed(packet_sha256, started, exc, UnavailableReason.MALFORMED, retryable=False)
        except (TypeSafeAuthenticationError, TypeSafePermissionDeniedError) as exc:
            return self._failed(packet_sha256, started, exc, UnavailableReason.AUTH, retryable=False)
        except TypeSafeAPIError as exc:
            retryable = exc.status not in _NON_RETRYABLE_STATUS
            reason = UnavailableReason.EXHAUSTED if retryable else UnavailableReason.REJECTED
            return self._failed(packet_sha256, started, exc, reason, retryable=retryable)
        except TypeSafeAPIConnectionError as exc:  # includes timeouts
            return self._failed(packet_sha256, started, exc, UnavailableReason.EXHAUSTED, retryable=True)
        except TypeSafeError as exc:
            return self._failed(packet_sha256, started, exc, UnavailableReason.REJECTED, retryable=False)

        try:
            request_id: str | None = response.request_id
        except TypeSafeError:
            request_id = None
        answers = {key: answer.model_dump(mode="json") for key, answer in response.answers.items()}
        meta = {
            "model_reported": response.model,
            "request_id": request_id,
            "input_tokens": response.usage.input_tokens,
            "answers": answers,
        }
        try:
            classification = validate_answers(answers)
        except MalformedAnswersError as exc:
            log.warning("jev.malformed_answers", request_id=request_id, error=str(exc))
            record = self._record(packet_sha256, "malformed", started, error_class="MalformedAnswersError", **meta)
            return ClassificationOutcome(None, UnavailableReason.MALFORMED, False, [record])
        if response.model != self.model:
            # Pinned versions should answer as themselves; keep the answer but make the drift visible.
            log.warning("jev.model_mismatch", requested=self.model, reported=response.model, request_id=request_id)
        return ClassificationOutcome(classification, None, False, [self._record(packet_sha256, "succeeded", started, **meta)])

    def _failed(
        self, sha: str, started: float, exc: Exception, reason: UnavailableReason, *, retryable: bool
    ) -> ClassificationOutcome:
        request_id = getattr(exc, "request_id", None) if isinstance(exc, TypeSafeAPIError) else None
        status = getattr(exc, "status", None)
        log.warning("jev.call_failed", error_class=type(exc).__name__, status=status, request_id=request_id,
                    retryable=retryable)
        record = self._record(sha, "failed", started, request_id=request_id, error_class=type(exc).__name__)
        return ClassificationOutcome(None, reason, retryable, [record])
