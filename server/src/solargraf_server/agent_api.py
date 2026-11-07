"""Endpointy agenta ``/api/agent/*`` (D42).

Uwierzytelnienie wyłącznie tokenem agenta (``Authorization: Bearer``); sesja użytkownika nie
daje tu dostępu, a token agenta nie działa na endpointach użytkownika. Proxy zwraca dla tych
ścieżek 404 — lokalny agent łączy się z API w sieci Compose.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta
from typing import Annotated, Literal, Self

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert

from solargraf_profiles.catalog import METRICS, DeviceKind, Transport
from solargraf_server.aggregation import H1, floor_utc
from solargraf_server.auth.deps import DbSession, utcnow
from solargraf_server.auth.tokens import token_hash
from solargraf_server.models import (
    NO_CHANNEL,
    Agent,
    AgentBatch,
    AggregateDirty,
    Connection,
    Device,
    Measurement,
    PollErrorCode,
    PollingRun,
    RunResult,
)

router = APIRouter(prefix="/api/agent", tags=["agent"])

MAX_BATCH_BYTES = 1_000_000
MAX_CLOCK_SKEW = timedelta(minutes=5)
MAX_TOKEN_LENGTH = 128
UNAUTHORIZED = "Nieprawidłowe poświadczenie agenta."


# --- uwierzytelnienie ---


async def current_agent(
    db: DbSession, authorization: Annotated[str | None, Header()] = None
) -> Agent:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token or len(token) > MAX_TOKEN_LENGTH:
        raise _unauthorized()
    agent = await db.scalar(select(Agent).where(Agent.token_hash == token_hash(token)))
    if agent is None or not agent.enabled:
        raise _unauthorized()
    return agent


def _unauthorized() -> HTTPException:
    return HTTPException(
        status.HTTP_401_UNAUTHORIZED, UNAUTHORIZED, headers={"WWW-Authenticate": "Bearer"}
    )


CurrentAgent = Annotated[Agent, Depends(current_agent)]


# --- heartbeat ---


class HeartbeatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str | None = Field(default=None, max_length=64)


@router.post("/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def heartbeat(body: HeartbeatIn, agent: CurrentAgent, db: DbSession) -> Response:
    agent.last_heartbeat_at = utcnow()
    agent.version = body.version
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- konfiguracja ---


class DeviceConfig(BaseModel):
    id: uuid.UUID
    name: str
    kind: DeviceKind
    enabled: bool
    profile_id: str | None
    profile_version: str | None


class ConnectionConfig(BaseModel):
    id: uuid.UUID
    transport: Transport
    host: str | None
    port: int | None
    unit_id: int | None
    poll_interval_seconds: int | None
    timeout_seconds: int | None
    devices: list[DeviceConfig]


class AgentConfig(BaseModel):
    agent_id: uuid.UUID
    connections: list[ConnectionConfig]


@router.get("/config", response_model=AgentConfig)
async def config(
    agent: CurrentAgent,
    db: DbSession,
    response: Response,
    if_none_match: Annotated[str | None, Header()] = None,
) -> AgentConfig | Response:
    connections = (
        await db.scalars(
            select(Connection).where(Connection.agent_id == agent.id).order_by(Connection.id)
        )
    ).all()
    devices = (
        await db.scalars(
            select(Device)
            .where(Device.connection_id.in_([c.id for c in connections]))
            .order_by(Device.id)
        )
    ).all()
    out = AgentConfig(
        agent_id=agent.id,
        connections=[
            ConnectionConfig(
                id=c.id,
                transport=Transport(c.transport),
                host=c.host,
                port=c.port,
                unit_id=c.unit_id,
                poll_interval_seconds=c.poll_interval_seconds,
                timeout_seconds=c.timeout_seconds,
                devices=[
                    DeviceConfig(
                        id=d.id,
                        name=d.name,
                        kind=DeviceKind(d.kind),
                        enabled=d.enabled,
                        profile_id=d.profile_id,
                        profile_version=d.profile_version,
                    )
                    for d in devices
                    if d.connection_id == c.id
                ],
            )
            for c in connections
        ],
    )
    canonical = json.dumps(out.model_dump(mode="json"), sort_keys=True).encode()
    etag = f'"{hashlib.sha256(canonical).hexdigest()}"'
    if if_none_match == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return out


# --- partie odczytów ---


class ReadingIn(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    metric: str = Field(max_length=64)
    channel: int | None = Field(default=None, ge=1, le=32)
    value: float | None = None
    quality: Literal["GOOD", "INVALID", "MISSING"]
    origin: Literal["DEVICE", "SIMULATED"]
    received_at: AwareDatetime
    observed_at: AwareDatetime | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        metric = METRICS.get(self.metric)
        if metric is None:
            raise ValueError(f"nieznana metryka {self.metric!r}")
        if metric.channeled != (self.channel is not None):
            raise ValueError(f"niepoprawny kanał dla metryki {self.metric}")
        if self.quality == "GOOD" and self.value is None:
            raise ValueError("odczyt GOOD wymaga wartości")
        if self.quality == "MISSING" and self.value is not None:
            raise ValueError("odczyt MISSING nie może mieć wartości")
        return self


class RunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: uuid.UUID
    started_at: AwareDatetime
    finished_at: AwareDatetime
    result: RunResult
    error_code: PollErrorCode | None = None
    error_detail: str | None = Field(default=None, max_length=200)
    readings: list[ReadingIn] = Field(max_length=500)

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.finished_at < self.started_at:
            raise ValueError("finished_at wcześniejsze niż started_at")
        return self


class BatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    batch_id: uuid.UUID
    runs: list[RunIn] = Field(min_length=1, max_length=200)

    def latest_time(self) -> datetime:
        times = [r.finished_at for r in self.runs]
        times += [x.received_at for r in self.runs for x in r.readings]
        return max(times)


class BatchOut(BaseModel):
    duplicate: bool
    runs: int
    readings: int


def _reject(detail: object) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


@router.post("/batches", response_model=BatchOut)
async def ingest(request: Request, agent: CurrentAgent, db: DbSession) -> BatchOut:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > MAX_BATCH_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Partia jest za duża.")
    raw = await request.body()
    if len(raw) > MAX_BATCH_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Partia jest za duża.")
    try:
        batch = BatchIn.model_validate_json(raw)
    except ValidationError as exc:
        raise _reject(
            exc.errors(include_url=False, include_input=False, include_context=False)
        ) from None

    now = utcnow()
    if batch.latest_time() > now + MAX_CLOCK_SKEW:
        raise _reject("Czas odczytu jest w przyszłości — sprawdź zegar agenta (NTP).")

    # Tylko urządzenia połączeń tego agenta; obce i nieistniejące wyglądają tak samo.
    device_ids = {r.device_id for r in batch.runs}
    rows = await db.execute(
        select(Device.id, Device.site_id)
        .join(
            Connection,
            (Connection.id == Device.connection_id) & (Connection.site_id == Device.site_id),
        )
        .where(Device.id.in_(device_ids), Connection.agent_id == agent.id)
    )
    sites: dict[uuid.UUID, uuid.UUID] = dict(rows.all())
    if set(sites) != device_ids:
        raise _reject("Partia zawiera urządzenie nieprzypisane do tego agenta.")

    accepted = await db.scalar(
        insert(AgentBatch)
        .values(agent_id=agent.id, batch_id=batch.batch_id)
        .on_conflict_do_nothing()
        .returning(AgentBatch.batch_id)
    )
    if accepted is None:
        await db.rollback()
        return BatchOut(duplicate=True, runs=0, readings=0)

    readings = 0
    dirty: set[tuple[uuid.UUID, datetime]] = set()
    for run in batch.runs:
        site_id = sites[run.device_id]
        db.add(
            PollingRun(
                site_id=site_id,
                device_id=run.device_id,
                agent_id=agent.id,
                batch_id=batch.batch_id,
                started_at=run.started_at,
                finished_at=run.finished_at,
                result=run.result.value,
                error_code=run.error_code.value if run.error_code else None,
                error_detail=run.error_detail,
                ok_points=sum(r.quality == "GOOD" for r in run.readings),
                failed_points=sum(r.quality != "GOOD" for r in run.readings),
            )
        )
        if run.readings:
            values = [
                {
                    "site_id": site_id,
                    "device_id": run.device_id,
                    "metric": r.metric,
                    "channel": r.channel if r.channel is not None else NO_CHANNEL,
                    "received_at": r.received_at,
                    "observed_at": r.observed_at,
                    "value": r.value,
                    "quality": r.quality,
                    "origin": r.origin,
                    "batch_id": batch.batch_id,
                }
                for r in run.readings
            ]
            await db.execute(insert(Measurement).values(values).on_conflict_do_nothing())
            readings += len(values)
            dirty.update((run.device_id, floor_utc(r.received_at, H1)) for r in run.readings)
        success = run.finished_at if run.result is not RunResult.FAILED else None
        await db.execute(
            update(Device)
            .where(Device.id == run.device_id)
            .values(
                # GREATEST pomija NULL — starsza partia (z bufora) nie cofa czasu.
                last_attempt_at=func.greatest(Device.last_attempt_at, run.finished_at),
                last_success_at=func.greatest(Device.last_success_at, success),
            )
        )
    if dirty:
        # Godziny do przeliczenia agregatów (D46). Posortowane — stała kolejność blokad.
        # clock_timestamp(): worker usuwa oznaczenie tylko, gdy nie zmieniło się od odczytu.
        mark = insert(AggregateDirty).values(
            [
                {"device_id": d, "hour_start": h, "marked_at": func.clock_timestamp()}
                for d, h in sorted(dirty)
            ]
        )
        await db.execute(
            mark.on_conflict_do_update(
                index_elements=[AggregateDirty.device_id, AggregateDirty.hour_start],
                set_={"marked_at": func.clock_timestamp()},
            )
        )
    await db.commit()
    return BatchOut(duplicate=False, runs=len(batch.runs), readings=readings)
