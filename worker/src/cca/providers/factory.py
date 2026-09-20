"""Chooses the decision-model provider for one run. Order of checks is deliberate:

1. consent: without the prospect's opt-in, nothing leaves our infrastructure;
2. JEV_ENABLED;
3. configuration (a real key for the TypeSafe provider).

There is no fallback to another model: any failure yields an explicit unavailable state.
"""

from __future__ import annotations

from collections.abc import Callable

from cca.providers.base import DecisionModelProvider, UnavailableProvider, UnavailableReason
from cca.providers.jev import JevProvider
from cca.providers.mock import MockJevProvider
from cca.settings import Settings

CONSENT_GRANTED = "typesafe:granted"
# Set while the snapshot is still the free teaser: no model call may happen yet.
CONSENT_PENDING = "pending"

# (consent_basis, job attempt) -> provider
ProviderFactory = Callable[[str | None, int], DecisionModelProvider]


def provider_factory(settings: Settings) -> ProviderFactory:
    def factory(consent_basis: str | None, attempt: int) -> DecisionModelProvider:
        if consent_basis == CONSENT_PENDING:
            return UnavailableProvider(UnavailableReason.AWAITING_UNLOCK)
        if consent_basis != CONSENT_GRANTED:
            return UnavailableProvider(UnavailableReason.NO_CONSENT)
        if not settings.jev_enabled:
            return UnavailableProvider(UnavailableReason.DISABLED)
        if settings.jev_provider == "mock":
            return MockJevProvider(attempt=attempt)
        if settings.typesafe_api_key is None or not settings.typesafe_api_key.get_secret_value():
            return UnavailableProvider(UnavailableReason.NOT_CONFIGURED)
        return JevProvider(
            settings.typesafe_api_key.get_secret_value(),
            settings.jev_model,
            base_url=settings.jev_base_url,
            timeout_s=settings.jev_timeout_ms / 1000,
            max_retries=settings.jev_max_retries,
            attempt=attempt,
        )

    return factory
