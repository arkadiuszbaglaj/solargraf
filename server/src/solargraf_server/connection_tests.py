"""Test komunikacji z urządzeniem przed dodaniem (D72).

Użytkownik (OWNER/ADMIN instalacji, CSRF):
- ``POST /api/sites/{site_id}/connection-tests`` — zlecenie: adres, port, Unit ID i profil.
- ``GET /api/sites/{site_id}/connection-tests/{test_id}`` — stan i wynik.

Agent (token agenta):
- ``GET /api/agent/connection-tests`` — odbiór oczekujących zleceń (stan RUNNING).
- ``POST /api/agent/connection-tests/{test_id}/result`` — wynik jednego odczytu profilu.

API nie łączy się z urządzeniem (D11). Agent pyta o zlecenia co kilka sekund; nieodebrane
zlecenie wygasa po ``PENDING_TTL``, niezakończone po ``RUNNING_TTL`` (stan EXPIRED tylko w
odpowiedzi). W instalacji trwa najwyżej jeden test naraz; wiersze starsze niż doba są usuwane.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Annotated, Literal, Self

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_profiles.catalog import METRICS
from solargraf_server import authz
from solargraf_server.agent_api import CurrentAgent
from solargraf_server.auth import service as auth_service
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth, require_csrf, utcnow
from solargraf_server.devices import (
    MODBUS_TCP_PORT,
    _authorize,
    _local_agent,
    _profile,
    validate_host,
)
from solargraf_server.models import ConnectionTest, RunResult, TestError, TestState
from solargraf_server.profiles import Catalog

router = APIRouter(prefix="/api/sites", tags=["devices"])
agent_router = APIRouter(prefix="/api/agent", tags=["agent"])

# Agent pyta co 5 s; po tym czasie zlecenie bez agenta uznajemy za nieodebrane.
PENDING_TTL = timedelta(seconds=60)
# Jeden odczyt profilu z ponowieniami mieści się w tym czasie (limit odczytu ≤ 60 s).
RUNNING_TTL = timedelta(seconds=120)
RETENTION = timedelta(days=1)
MAX_READINGS = 500
NOT_FOUND_TEST = "Nie znaleziono testu połączenia."


class TestIn(BaseModel):
    __test__ = False

    host: str = Field(max_length=253)
    port: int = Field(default=MODBUS_TCP_PORT, ge=1, le=65535)
    unit_id: int = Field(default=1, ge=0, le=255)
    profile_id: str = Field(max_length=100)
    profile_version: str = Field(max_length=32)

    _host = field_validator("host")(validate_host)


class TestReading(BaseModel):
    """Odczyt z testu; wartość w jednostce kanonicznej metryki (katalog D39)."""

    __test__ = False
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    metric: str = Field(max_length=64)
    channel: int | None = Field(default=None, ge=1, le=32)
    value: float | None = None
    quality: Literal["GOOD", "INVALID", "MISSING"]

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        metric = METRICS.get(self.metric)
        if metric is None:
            raise ValueError(f"nieznana metryka {self.metric!r}")
        if metric.channeled != (self.channel is not None):
            raise ValueError(f"niepoprawny kanał dla metryki {self.metric}")
        if (self.quality == "GOOD") != (self.value is not None):
            raise ValueError("wartość tylko dla odczytu GOOD")
        return self


TestStateOut = Literal["PENDING", "RUNNING", "DONE", "EXPIRED"]


class TestReadingOut(TestReading):
    """Odczyt z nazwą i jednostką kanoniczną z katalogu metryk — UI nie zna katalogu."""

    name: str
    unit: str

    @classmethod
    def of(cls, reading: TestReading) -> TestReadingOut:
        metric = METRICS[reading.metric]
        return cls(
            **reading.model_dump(),
            name=metric.display_name,
            unit=metric.canonical_unit.value,
        )


class TestOut(BaseModel):
    __test__ = False

    id: uuid.UUID
    state: TestStateOut
    created_at: datetime
    finished_at: datetime | None
    result: RunResult | None
    error_code: TestError | None
    origin: Literal["DEVICE", "SIMULATED"] | None
    readings: list[TestReadingOut]


def effective_state(test: ConnectionTest, now: datetime) -> TestStateOut:
    """Stan dla UI: zlecenie bez odpowiedzi agenta w czasie — EXPIRED (bez zapisu w bazie)."""
    if test.state == TestState.PENDING.value and now - test.created_at > PENDING_TTL:
        return "EXPIRED"
    if test.state == TestState.RUNNING.value:
        claimed = test.claimed_at or test.created_at
        if now - claimed > RUNNING_TTL:
            return "EXPIRED"
    return TestState(test.state).value  # type: ignore[return-value]  # PENDING/RUNNING/DONE


def _out(test: ConnectionTest, now: datetime) -> TestOut:
    return TestOut(
        id=test.id,
        state=effective_state(test, now),
        created_at=test.created_at,
        finished_at=test.finished_at,
        result=RunResult(test.result) if test.result else None,
        error_code=TestError(test.error_code) if test.error_code else None,
        origin=test.origin,  # type: ignore[arg-type]  # ograniczenie CHECK w bazie
        readings=[TestReadingOut.of(TestReading.model_validate(r)) for r in test.readings or []],
    )


async def _active(db: AsyncSession, site_id: uuid.UUID, now: datetime) -> bool:
    rows = (
        await db.scalars(
            select(ConnectionTest).where(
                ConnectionTest.site_id == site_id,
                ConnectionTest.state.in_([TestState.PENDING.value, TestState.RUNNING.value]),
            )
        )
    ).all()
    return any(effective_state(t, now) in ("PENDING", "RUNNING") for t in rows)


# --- użytkownik ---


@router.post(
    "/{site_id}/connection-tests", status_code=status.HTTP_202_ACCEPTED, response_model=TestOut
)
async def request_test(
    site_id: uuid.UUID,
    body: TestIn,
    db: DbSession,
    catalog: Catalog,
    auth: Annotated[AuthContext, Depends(require_csrf)],
) -> TestOut:
    access = await _authorize(db, auth, site_id, authz.SiteAction.MANAGE)
    profile = _profile(catalog, body.profile_id, body.profile_version)
    agent = await _local_agent(db)
    now = utcnow()
    await db.execute(delete(ConnectionTest).where(ConnectionTest.created_at < now - RETENTION))
    if await _active(db, access.site.id, now):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Test połączenia już trwa — poczekaj na jego wynik."
        )
    test = ConnectionTest(
        site_id=access.site.id,
        agent_id=agent.id,
        requested_by=auth.user.id,
        host=body.host,
        port=body.port,
        unit_id=body.unit_id,
        profile_id=profile.id,
        profile_version=profile.version,
        state=TestState.PENDING.value,
        created_at=now,
    )
    db.add(test)
    await db.flush()
    await auth_service.audit(
        db,
        "CONNECTION_TEST_REQUESTED",
        user_id=auth.user.id,
        organization_id=access.site.organization_id,
        target=f"connection_test:{test.id}",
    )
    await db.commit()
    return _out(test, now)


@router.get("/{site_id}/connection-tests/{test_id}", response_model=TestOut)
async def get_test(
    site_id: uuid.UUID,
    test_id: uuid.UUID,
    db: DbSession,
    auth: Annotated[AuthContext, Depends(current_auth)],
) -> TestOut:
    access = await _authorize(db, auth, site_id, authz.SiteAction.MANAGE)
    test = await db.scalar(
        select(ConnectionTest).where(
            ConnectionTest.id == test_id, ConnectionTest.site_id == access.site.id
        )
    )
    if test is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND_TEST)
    return _out(test, utcnow())


# --- agent ---


class TestJob(BaseModel):
    __test__ = False

    id: uuid.UUID
    host: str
    port: int
    unit_id: int
    profile_id: str
    profile_version: str


class TestResultIn(BaseModel):
    __test__ = False
    model_config = ConfigDict(extra="forbid")

    result: RunResult
    error_code: TestError | None = None
    origin: Literal["DEVICE", "SIMULATED"] | None = None
    readings: list[TestReading] = Field(default_factory=list, max_length=MAX_READINGS)

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.result is RunResult.OK and self.error_code is not None:
            raise ValueError("wynik OK bez kodu błędu")
        if self.result is not RunResult.OK and self.error_code is None:
            raise ValueError("wynik z błędem wymaga kodu błędu")
        return self


@agent_router.get("/connection-tests", response_model=list[TestJob])
async def claim_tests(agent: CurrentAgent, db: DbSession) -> list[TestJob]:
    """Zlecenia czekające na tego agenta; odebrane przechodzą w RUNNING (najwyżej raz)."""
    now = utcnow()
    rows = (
        await db.scalars(
            select(ConnectionTest)
            .where(
                ConnectionTest.agent_id == agent.id,
                ConnectionTest.state == TestState.PENDING.value,
                ConnectionTest.created_at >= now - PENDING_TTL,
            )
            .order_by(ConnectionTest.created_at)
            .with_for_update(skip_locked=True)
        )
    ).all()
    for test in rows:
        test.state = TestState.RUNNING.value
        test.claimed_at = now
    await db.commit()
    return [
        TestJob(
            id=t.id,
            host=t.host,
            port=t.port,
            unit_id=t.unit_id,
            profile_id=t.profile_id,
            profile_version=t.profile_version,
        )
        for t in rows
    ]


@agent_router.post("/connection-tests/{test_id}/result", status_code=status.HTTP_204_NO_CONTENT)
async def report_test(
    test_id: uuid.UUID, body: TestResultIn, agent: CurrentAgent, db: DbSession
) -> Response:
    test = await db.scalar(
        select(ConnectionTest)
        .where(ConnectionTest.id == test_id, ConnectionTest.agent_id == agent.id)
        .with_for_update()
    )
    if test is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND_TEST)
    if test.state != TestState.RUNNING.value:
        raise HTTPException(status.HTTP_409_CONFLICT, "Test nie czeka na wynik.")
    test.state = TestState.DONE.value
    test.finished_at = utcnow()
    test.result = body.result.value
    test.error_code = body.error_code.value if body.error_code else None
    test.origin = body.origin
    test.readings = [r.model_dump(mode="json") for r in body.readings]
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
