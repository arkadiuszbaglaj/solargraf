"""Endpointy health (D25): bez uwierzytelnienia; status i — w liveness — czas serwera (D53)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Request, Response, status
from pydantic import BaseModel

ReadinessCheck = Callable[[], Awaitable[bool]]

router = APIRouter(prefix="/api/health", tags=["health"])


class HealthStatus(BaseModel):
    status: Literal["ok", "unavailable"]


class LivenessStatus(HealthStatus):
    # Czas zegara serwera (UTC) — UI porównuje go ze swoim, żeby wykryć rozjechany zegar (D53).
    server_time: datetime


@router.get("", response_model=LivenessStatus)
async def liveness() -> LivenessStatus:
    return LivenessStatus(status="ok", server_time=datetime.now(UTC))


@router.get(
    "/ready",
    response_model=HealthStatus,
    responses={status.HTTP_503_SERVICE_UNAVAILABLE: {"model": HealthStatus}},
)
async def readiness(request: Request, response: Response) -> HealthStatus:
    check: ReadinessCheck = request.app.state.readiness_check
    if await check():
        return HealthStatus(status="ok")
    response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return HealthStatus(status="unavailable")
