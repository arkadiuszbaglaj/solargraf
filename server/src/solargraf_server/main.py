"""Fabryka aplikacji FastAPI.

Uruchomienie: ``uvicorn solargraf_server.main:app_from_env --factory``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from solargraf_server import __version__
from solargraf_server.agent_api import router as agent_router
from solargraf_server.alarms_api import router as alarms_router
from solargraf_server.auth.router import router as auth_router
from solargraf_server.config import Settings
from solargraf_server.connection_tests import agent_router as tests_agent_router
from solargraf_server.connection_tests import router as tests_router
from solargraf_server.db import create_engine, create_sessionmaker, database_ready
from solargraf_server.devices import router as devices_router
from solargraf_server.energy_api import router as energy_router
from solargraf_server.export import router as export_router
from solargraf_server.health import ReadinessCheck
from solargraf_server.health import router as health_router
from solargraf_server.history import router as history_router
from solargraf_server.live import LiveBus
from solargraf_server.live import router as live_router
from solargraf_server.profiles import ProfileCatalog
from solargraf_server.profiles import router as profiles_router
from solargraf_server.reports import router as reports_router
from solargraf_server.sites import router as sites_router
from solargraf_server.system.api import router as system_router
from solargraf_server.updates import service as update_service
from solargraf_server.updates.api import router as updates_router
from solargraf_server.updates.install import InstallDirs
from solargraf_server.updates.release_key import RELEASE_PUBLIC_KEY


def create_app(settings: Settings, readiness_check: ReadinessCheck | None = None) -> FastAPI:
    """Tworzy aplikację. ``readiness_check`` pozwala podmienić sprawdzenie bazy w testach."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.profiles = ProfileCatalog.load(settings.profiles_dir)
        app.state.live_bus = LiveBus()
        if readiness_check is not None:
            app.state.readiness_check = readiness_check
            yield
            return
        engine = create_engine(settings)
        app.state.sessionmaker = create_sessionmaker(engine)

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
    app.include_router(auth_router)
    app.include_router(sites_router)
    app.include_router(devices_router)
    app.include_router(history_router)
    app.include_router(energy_router)
    app.include_router(export_router)
    app.include_router(live_router)
    app.include_router(alarms_router)
    app.include_router(profiles_router)
    app.include_router(agent_router)
    app.include_router(tests_router)
    app.include_router(tests_agent_router)
    app.include_router(reports_router)
    app.include_router(system_router)
    app.include_router(updates_router)
    # Podmieniane w testach (bez sieci i z kluczem testowym).
    app.state.update_fetch = update_service.fetch_https
    app.state.update_public_key = RELEASE_PUBLIC_KEY
    app.state.update_dirs = (
        InstallDirs(request=settings.update_request_dir, status=settings.update_status_dir)
        if settings.update_request_dir and settings.update_status_dir
        else None
    )
    return app


def app_from_env() -> FastAPI:
    return create_app(Settings())  # type: ignore[call-arg]  # pola z env
