"""Run the worker service: `uv run python -m cca` (PORT defaults to 8001)."""

from __future__ import annotations

import os

import uvicorn

from cca.logging_setup import configure_logging
from cca.service import create_app
from cca.settings import get_settings


def main() -> None:
    configure_logging(os.environ.get("LOG_LEVEL", "INFO"))
    app = create_app(get_settings())
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8001")), log_config=None)  # noqa: S104 - container binds all interfaces


if __name__ == "__main__":
    main()
