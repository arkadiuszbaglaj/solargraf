"""Raport energii instalacji (D74): miesięczny albo roczny, tylko OWNER/ADMIN.

- ``GET /api/sites/{id}/reports/energy?year=&month=`` — energia instalacji (D51) za miesiąc
  (przedziały dobowe) albo rok bez ``month`` (przedziały miesięczne) w strefie instalacji, wraz
  ze wskaźnikami D27.
- ``GET /api/sites/{id}/reports/energy.csv?year=&month=`` — to samo w CSV pod polskiego Excela
  (jak D57: ``;``, przecinek dziesiętny, UTF-8 z BOM, brak danych to puste pole, nigdy 0);
  eksport w audycie (``DATA_EXPORTED``, bez danych).

Okres, który jeszcze się nie zaczął, jest odrzucany; bieżący okres jest liczony do jego końca
(przyszłe przedziały bez danych mają ``null``).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server import authz
from solargraf_server.auth import service as auth_service
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth, utcnow
from solargraf_server.energy_api import KpiOut, SiteEnergyOut, site_energy_for
from solargraf_server.export import encode_rows, number, slug, utc_text
from solargraf_server.profiles import Catalog
from solargraf_server.sites import NOT_FOUND

router = APIRouter(prefix="/api/sites", tags=["reports"])

FORBIDDEN = "Raporty są dostępne dla właściciela i administratora instalacji."
MIN_YEAR, MAX_YEAR = 2000, 2100

# Kolejność i nazwy kolumn raportu (klucze serii D51).
COLUMNS: tuple[tuple[str, str], ...] = (
    ("pv", "Produkcja PV"),
    ("load", "Zużycie domu"),
    ("grid_import", "Pobór z sieci"),
    ("grid_export", "Oddanie do sieci"),
    ("battery_charge", "Ładowanie magazynu"),
    ("battery_discharge", "Rozładowanie magazynu"),
)

Period = Literal["month", "year"]


class ReportOut(SiteEnergyOut):
    period: Period
    year: int
    month: int | None
    start: datetime
    end: datetime


def report_range(year: int, month: int | None, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """Początek i koniec (wyłączny) miesiąca albo roku w strefie instalacji, w UTC."""
    if month is None:
        start, end = datetime(year, 1, 1, tzinfo=tz), datetime(year + 1, 1, 1, tzinfo=tz)
    else:
        start = datetime(year, month, 1, tzinfo=tz)
        end = datetime(year + (month == 12), month % 12 + 1, 1, tzinfo=tz)
    return start.astimezone(UTC), end.astimezone(UTC)


async def _report(
    db: AsyncSession,
    catalog: Catalog,
    auth: AuthContext,
    site_id: uuid.UUID,
    year: int,
    month: int | None,
) -> tuple[ReportOut, authz.SiteAccess]:
    try:
        access = await authz.authorize_site(db, auth.user.id, site_id, authz.SiteAction.MANAGE)
    except authz.NotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
    except authz.ForbiddenError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, FORBIDDEN) from None
    tz = ZoneInfo(access.site.timezone)
    start, end = report_range(year, month, tz)
    if start > utcnow():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Wybrany okres jeszcze się nie zaczął."
        )
    energy = await site_energy_for(db, catalog, site_id, access.site.timezone, start, end)
    report = ReportOut(
        **energy.model_dump(),
        period="year" if month is None else "month",
        year=year,
        month=month,
        start=start,
        end=end,
    )
    return report, access


Year = Annotated[int, Query(ge=MIN_YEAR, le=MAX_YEAR)]
Month = Annotated[int | None, Query(ge=1, le=12)]


@router.get("/{site_id}/reports/energy", response_model=ReportOut)
async def energy_report(
    site_id: uuid.UUID,
    db: DbSession,
    catalog: Catalog,
    auth: Annotated[AuthContext, Depends(current_auth)],
    year: Year,
    month: Month = None,
) -> ReportOut:
    report, _ = await _report(db, catalog, auth, site_id, year, month)
    return report


def kwh(wh: float | None) -> str:
    """kWh z dokładnością do 1 Wh; brak wartości to puste pole."""
    return number(None if wh is None else round(wh / 1000, 3))


def _kpi_text(kpi: KpiOut) -> str:
    if kpi.value is None or kpi.status in ("UNAVAILABLE", "INCONSISTENT"):
        return ""
    return number(round(kpi.value * 100, 1))


def report_rows(report: ReportOut) -> Iterator[list[str]]:
    """Wiersze CSV: przedziały, suma, wskaźniki i pochodzenie danych."""
    tz = ZoneInfo(report.timezone)
    series = {s.key: s for s in report.series}
    keys = [key for key, _ in COLUMNS if key in series]
    labels = dict(COLUMNS)
    yield ["okres", *(f"{labels[k]} [kWh]" for k in keys)]
    first = next(iter(series.values()), None)
    fmt = "%Y-%m" if report.period == "year" else "%Y-%m-%d"
    for i, bucket in enumerate(first.buckets if first else []):
        local = bucket.t.astimezone(tz).strftime(fmt)
        yield [local, *(kwh(series[k].buckets[i].wh) for k in keys)]
    yield ["Razem", *(kwh(series[k].total_wh) for k in keys)]
    yield []
    yield ["Autokonsumpcja [%]", _kpi_text(report.kpis.self_consumption)]
    yield ["Samowystarczalność [%]", _kpi_text(report.kpis.self_sufficiency)]
    missing = [labels[u.key] for u in report.unavailable if u.key in labels]
    if missing:
        yield ["Niedostępne serie", ", ".join(missing)]
    yield ["Pochodzenie danych", ", ".join(report.origins) or "brak danych"]
    yield ["Strefa czasowa", report.timezone]


def report_filename(site: str, report: ReportOut) -> str:
    period = f"{report.year}" if report.month is None else f"{report.year}-{report.month:02d}"
    parts = ["raport", slug(site), period]
    if "SIMULATED" in report.origins:
        parts.append("SIMULATED")
    return "_".join(parts) + ".csv"


@router.get(
    "/{site_id}/reports/energy.csv",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}}},
)
async def energy_report_csv(
    site_id: uuid.UUID,
    db: DbSession,
    catalog: Catalog,
    auth: Annotated[AuthContext, Depends(current_auth)],
    year: Year,
    month: Month = None,
) -> Response:
    report, access = await _report(db, catalog, auth, site_id, year, month)
    await auth_service.audit(
        db,
        "DATA_EXPORTED",
        user_id=auth.user.id,
        organization_id=access.site.organization_id,
        target=f"report:{site_id};{report.period};{utc_text(report.start)}/{utc_text(report.end)}",
    )
    await db.commit()
    body = "﻿".encode() + encode_rows(report_rows(report))
    return Response(
        body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{report_filename(access.site.name, report)}"'
            ),
            "Cache-Control": "no-store",
        },
    )
