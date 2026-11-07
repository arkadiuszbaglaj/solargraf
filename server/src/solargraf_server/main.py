"""Fabryka aplikacji FastAPI.

Uruchomienie: ``uvicorn solargraf_server.main:app_from_env --factory``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from solargraf_server import __version__
from solargraf_server.config import Settings
from solargraf_server.db import create_engine, database_ready
from solargraf_server.health import ReadinessCheck
from solargraf_server.health import router as health_router


def create_app(settings: Settings, readiness_check: ReadinessCheck | None = None) -> FastAPI:
    """Tworzy aplikację. ``readiness_check`` pozwala podmienić sprawdzenie bazy w testach."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if readiness_check is not None:
            app.state.readiness_check = readiness_check
            yield
            return
        engine = create_engine(settings)

        async def check() -> bool:
            return await database_ready(engine, settings.db_timeout_s)

        app.state.readiness_check = check
        try:
            yield
        finally:
            await engine.dispose()

    # Dokumentacja OpenAPI jest niedostępna bez uwierzytelnienia (D25) — włączana tylko w dev.
    docs = settings.api_docs
    app = FastAPI(
        title="SolarGraf API (nazwa robocza)",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs" if docs else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if docs else None,
    )
    app.include_router(health_router)
    return app


def app_from_env() -> FastAPI:
    return create_app(Settings())  # type: ignore[call-arg]  # pola z env
