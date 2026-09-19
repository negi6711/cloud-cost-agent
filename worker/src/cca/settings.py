"""Worker configuration, read from the environment (and the repo-root .env for local development)."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
_PINNED_MODEL = re.compile(r"^jev-\d+\.\d+\.\d+$")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
    )

    app_env: Literal["development", "test", "staging", "production"] = Field("development", alias="APP_ENV")
    database_url: str = Field(alias="DATABASE_URL")
    worker_shared_secret: str = Field(alias="WORKER_SHARED_SECRET", min_length=32)

    storage_driver: Literal["local", "r2"] = Field("local", alias="STORAGE_DRIVER")
    local_storage_dir: Path | None = Field(None, alias="LOCAL_STORAGE_DIR")
    r2_account_id: str | None = Field(None, alias="R2_ACCOUNT_ID")
    r2_access_key_id: str | None = Field(None, alias="R2_ACCESS_KEY_ID")
    r2_secret_access_key: str | None = Field(None, alias="R2_SECRET_ACCESS_KEY")
    r2_bucket: str | None = Field(None, alias="R2_BUCKET")
    upload_max_bytes: int = Field(MAX_UPLOAD_BYTES, alias="UPLOAD_MAX_BYTES", gt=0, le=MAX_UPLOAD_BYTES)

    jev_enabled: bool = Field(False, alias="JEV_ENABLED")
    # mock = deterministic stand-in for local development and tests; refused when hosted
    jev_provider: Literal["mock", "typesafe"] = Field("mock", alias="JEV_PROVIDER")
    typesafe_api_key: SecretStr | None = Field(None, alias="TYPESAFE_API_KEY")
    jev_model: str = Field("jev-1.13.0", alias="JEV_MODEL")
    jev_base_url: str | None = Field(None, alias="JEV_BASE_URL")
    jev_timeout_ms: int = Field(30_000, alias="JEV_TIMEOUT_MS", ge=1_000, le=120_000)
    jev_max_retries: int = Field(2, alias="JEV_MAX_RETRIES", ge=0, le=5)
    jev_concurrency: int = Field(4, alias="JEV_CONCURRENCY", ge=1, le=8)
    jev_low_confidence_threshold: float = Field(0.5, alias="JEV_LOW_CONFIDENCE_THRESHOLD", ge=0, le=1)

    raw_file_retention_days: int = Field(30, alias="RAW_FILE_RETENTION_DAYS", ge=1, le=365)
    retention_interval_seconds: int = Field(3600, alias="RETENTION_INTERVAL_SECONDS", ge=60)

    worker_id: str = Field("worker-local", alias="WORKER_ID")
    poll_interval_seconds: float = Field(5.0, alias="WORKER_POLL_INTERVAL_SECONDS", gt=0)
    lease_seconds: int = Field(300, alias="WORKER_LEASE_SECONDS", ge=30)
    kick_max_skew_seconds: int = Field(300, alias="WORKER_KICK_MAX_SKEW_SECONDS", ge=10)

    @property
    def hosted(self) -> bool:
        return self.app_env in ("staging", "production")

    @model_validator(mode="after")
    def _check_jev(self) -> Settings:
        if self.hosted and self.jev_provider == "mock":
            raise ValueError("JEV_PROVIDER=mock is not allowed when hosted")
        if self.hosted and not _PINNED_MODEL.match(self.jev_model):
            raise ValueError("JEV_MODEL must be a pinned version such as jev-1.13.0 when hosted, not an alias")
        return self

    @model_validator(mode="after")
    def _check_storage(self) -> Settings:
        if self.storage_driver == "local":
            if self.local_storage_dir is None or not self.local_storage_dir.is_absolute():
                raise ValueError("LOCAL_STORAGE_DIR must be an absolute path for local storage")
            if self.app_env in ("staging", "production"):
                raise ValueError("local storage is not allowed when hosted")
        else:
            missing = [
                name
                for name, value in {
                    "R2_ACCOUNT_ID": self.r2_account_id,
                    "R2_ACCESS_KEY_ID": self.r2_access_key_id,
                    "R2_SECRET_ACCESS_KEY": self.r2_secret_access_key,
                    "R2_BUCKET": self.r2_bucket,
                }.items()
                if not value
            ]
            if missing:
                raise ValueError(f"required for r2 storage: {', '.join(missing)}")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # values come from the environment
