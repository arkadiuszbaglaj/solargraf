"""Pobranie i zapis wyniku sprawdzenia aktualizacji (D15, D63).

Żądanie nie zawiera danych instalacji, licencji ani numeru wersji (stały User-Agent); wersje
porównujemy lokalnie. Błąd sieci albo zły manifest nie jest alarmem — zapisujemy kod błędu
i spróbujemy ponownie za dobę. Po sukcesie kolejne sprawdzenie za 7 dni (+ losowe przesunięcie,
żeby wiele serwerów nie pytało jednocześnie).
"""

from __future__ import annotations

import asyncio
import secrets
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from http.client import HTTPMessage
from typing import IO

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server.models.updates import UPDATE_ROW_ID, UpdateStatus
from solargraf_server.updates import manifest as mf

USER_AGENT = "solargraf-update-check"
AFTER_SUCCESS = timedelta(days=7)
AFTER_FAILURE = timedelta(days=1)
JITTER = timedelta(hours=6)
FIRST_CHECK_WITHIN = timedelta(hours=1)


class FetchError(Exception):
    def __init__(self, code: mf.CheckError) -> None:
        super().__init__(code.value)
        self.code = code


Fetch = Callable[[str, float, int], Awaitable[bytes]]
Jitter = Callable[[timedelta], timedelta]


def random_jitter(limit: timedelta) -> timedelta:
    return timedelta(seconds=secrets.randbelow(int(limit.total_seconds()) + 1))


class _HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    """GitHub przekierowuje ``releases/latest/download`` — tylko na adresy HTTPS."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> urllib.request.Request | None:
        if not newurl.startswith("https://"):
            raise urllib.error.URLError("przekierowanie poza HTTPS")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch_sync(url: str, timeout_s: float, limit: int) -> bytes:
    if not url.startswith("https://"):
        raise FetchError(mf.CheckError.NETWORK)
    opener = urllib.request.build_opener(_HttpsOnlyRedirect)
    # Schemat sprawdzony wyżej (tylko https), przekierowania — w _HttpsOnlyRedirect.
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310
    try:
        with opener.open(request, timeout=timeout_s) as response:
            body: bytes = response.read(limit + 1)
    except (OSError, ValueError):  # URLError, HTTPError, timeout i TLS dziedziczą po OSError
        raise FetchError(mf.CheckError.NETWORK) from None
    if len(body) > limit:
        raise FetchError(mf.CheckError.TOO_LARGE)
    return body


async def fetch_https(url: str, timeout_s: float, limit: int) -> bytes:
    """Pobranie w wątku (biblioteka standardowa); całość ograniczona czasem ``timeout_s``."""
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_fetch_sync, url, timeout_s, limit), timeout_s * 2
        )
    except TimeoutError:
        raise FetchError(mf.CheckError.NETWORK) from None


async def status_row(db: AsyncSession, automatic_default: bool) -> UpdateStatus:
    """Wiersz stanu; tworzony przy pierwszym użyciu z ustawieniem z instalatora."""
    await db.execute(
        insert(UpdateStatus)
        .values(id=UPDATE_ROW_ID, automatic=automatic_default)
        .on_conflict_do_nothing(index_elements=["id"])
    )
    row = await db.get(UpdateStatus, UPDATE_ROW_ID, populate_existing=True)
    if row is None:  # wstawiony wyżej w tej samej transakcji
        raise RuntimeError("brak wiersza update_status")
    return row


async def check_now(
    db: AsyncSession,
    row: UpdateStatus,
    *,
    url: str,
    timeout_s: float,
    public_key: str | None,
    now: datetime,
    fetch: Fetch = fetch_https,
    jitter: Jitter = random_jitter,
) -> None:
    row.last_checked_at = now
    if public_key is None:
        row.last_error = mf.CheckError.NOT_CONFIGURED.value
        row.next_check_at = None
        await db.commit()
        return
    try:
        body = await fetch(url, timeout_s, mf.MAX_MANIFEST_BYTES)
        signature = await fetch(url + ".sig", timeout_s, mf.MAX_SIGNATURE_BYTES)
        verified = mf.verify(body, signature, mf.load_public_key(public_key))
    except (FetchError, mf.ManifestRejected) as exc:
        row.last_error = exc.code.value
        row.next_check_at = now + AFTER_FAILURE + jitter(JITTER)
    else:
        row.last_error = None
        row.last_success_at = now
        row.manifest = verified.model_dump(mode="json")
        row.next_check_at = now + AFTER_SUCCESS + jitter(JITTER)
    await db.commit()


async def run_scheduled(
    db: AsyncSession,
    *,
    automatic_default: bool,
    url: str,
    timeout_s: float,
    public_key: str | None,
    now: datetime,
    fetch: Fetch = fetch_https,
    jitter: Jitter = random_jitter,
) -> bool:
    """Zadanie workera: sprawdza, gdy nadszedł termin. Zwraca True, jeśli sprawdzono."""
    row = await status_row(db, automatic_default)
    if not row.automatic or public_key is None:
        await db.commit()
        return False
    if row.next_check_at is None:
        row.next_check_at = now + jitter(FIRST_CHECK_WITHIN)
        await db.commit()
        return False
    if now < row.next_check_at:
        await db.commit()
        return False
    await check_now(
        db,
        row,
        url=url,
        timeout_s=timeout_s,
        public_key=public_key,
        now=now,
        fetch=fetch,
        jitter=jitter,
    )
    return True


def current_manifest(row: UpdateStatus) -> mf.Manifest | None:
    """Zapisany manifest (zweryfikowany przy pobraniu); uszkodzony zapis — jak brak."""
    if row.manifest is None:
        return None
    try:
        return mf.Manifest.model_validate(row.manifest)
    except ValueError:
        return None
