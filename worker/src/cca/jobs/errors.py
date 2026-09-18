"""Failure classes that decide whether a job is retried."""


class RetryableJobError(Exception):
    """Transient failure (network, storage, provider unavailable): retry with backoff."""


class PermanentJobError(Exception):
    """Retrying cannot help (bad input, integrity failure): stop and surface the failure."""
