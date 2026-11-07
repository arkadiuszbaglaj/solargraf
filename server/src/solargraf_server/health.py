"""Endpointy health (D25): bez uwierzytelnienia, odpowiedź zawiera wyłącznie status."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal

from fastapi import APIRouter, Request, Response, status
from pydantic import BaseModel

ReadinessCheck = Callable[[], Awaitable[bool]]

router = APIRouter(prefix="/api/health", tags=["health"])


class HealthStatus(BaseModel):
    status: Literal["ok", "unavailable"]


@router.get("", response_model=HealthStatus)
async def liveness() -> HealthStatus:
    return HealthStatus(status="ok")


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
