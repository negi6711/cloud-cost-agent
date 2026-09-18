"""Structured JSON logs with redaction. Billing rows, file contents and model payloads never go here."""

from __future__ import annotations

import logging
import re
import sys
from collections.abc import MutableMapping
from typing import Any

import structlog

_EMAIL_RE = re.compile(r"([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
_SECRET_KEY_RE = re.compile(r"(secret|password|token|api[_-]?key|authorization|cookie|signature)", re.I)
_MAX_STRING = 500


def _redact_value(key: str, value: Any, depth: int = 0) -> Any:
    if _SECRET_KEY_RE.search(key):
        return "[redacted]"
    if depth > 6:
        return "[truncated]"
    if isinstance(value, str):
        masked = _EMAIL_RE.sub(r"\1***@\2", value)
        return masked if len(masked) <= _MAX_STRING else masked[:_MAX_STRING] + "…"
    if isinstance(value, dict):
        return {k: _redact_value(str(k), v, depth + 1) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_redact_value(key, v, depth + 1) for v in list(value)[:50]]
    return value


def redact(_logger: Any, _method: str, event_dict: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    for key in list(event_dict):
        if key != "event":
            event_dict[key] = _redact_value(key, event_dict[key])
    return event_dict


def configure_logging(level: str = "INFO") -> None:
    logging.basicConfig(stream=sys.stdout, level=level, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", key="ts"),
            structlog.processors.format_exc_info,
            redact,
            structlog.processors.JSONRenderer(sort_keys=True),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level)),
        logger_factory=structlog.PrintLoggerFactory(sys.stdout),
        cache_logger_on_first_use=True,
    )
    structlog.contextvars.bind_contextvars(service="worker")
