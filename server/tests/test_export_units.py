"""Format pliku CSV eksportu (D57) — bez bazy."""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from solargraf_server.export import (
    ExportResolution,
    encode_rows,
    filename,
    local_text,
    number,
    safe_text,
    slug,
    utc_text,
)

WARSAW = ZoneInfo("Europe/Warsaw")


def test_number_uses_decimal_comma_and_empty_for_missing() -> None:
    assert number(1234.5) == "1234,5"
    assert number(0.0) == "0,0"  # zmierzone zero zostaje zerem
    assert number(-640.0) == "-640,0"
    assert number(None) == ""  # brak danych nigdy jako 0


def test_safe_text_neutralises_formula_prefixes() -> None:
    for text in ("=1+1", "+48", "-2", "@SUM(A1)", "\tx", "\rx"):
        assert safe_text(text) == f"'{text}"
    for text in ("pv_power", "°C", "SIMULATED", "", "a=b"):
        assert safe_text(text) == text


def test_encode_rows_semicolon_crlf_and_quoting() -> None:
    data = encode_rows([["a", "1,5", ""], ["x;y", '"q"', "=cmd"]]).decode("utf-8")
    # Przecinek dziesiętny nie wymaga cudzysłowu przy separatorze „;”.
    assert data == 'a;1,5;\r\n"x;y";"""q""";\'=cmd\r\n'


def test_times_utc_and_local_across_dst_change() -> None:
    # 25.10.2026: 02:30 czasu letniego i 02:30 zimowego — UTC rozróżnia je jednoznacznie.
    summer = datetime(2026, 10, 25, 0, 30, tzinfo=UTC)
    winter = datetime(2026, 10, 25, 1, 30, tzinfo=UTC)
    assert utc_text(summer) == "2026-10-25T00:30:00Z"
    assert local_text(summer, WARSAW) == "2026-10-25 02:30:00"
    assert local_text(winter, WARSAW) == "2026-10-25 02:30:00"
    assert utc_text(winter) == "2026-10-25T01:30:00Z"


def test_slug_is_ascii() -> None:
    assert slug("Dom Łódź — Falownik #1") == "dom-lodz-falownik-1"
    assert slug("ŻÓŁW") == "zolw"
    assert slug("***") == "x"
    assert len(slug("a" * 100)) == 40


def test_filename_with_inclusive_last_day_and_simulated_mark() -> None:
    start = datetime(2026, 10, 31, 23, 0, tzinfo=UTC)  # 1.11 00:00 w Warszawie
    end = datetime(2026, 11, 7, 23, 0, tzinfo=UTC)  # 8.11 00:00 — koniec wyłączny
    name = filename("Dom", "Falownik", start, end, ExportResolution.H1, WARSAW, simulated=True)
    assert name == "historia_dom_falownik_20261101_20261107_1h_SIMULATED.csv"
    plain = filename("Dom", "Falownik", start, end, ExportResolution.D1, WARSAW, simulated=False)
    assert plain.endswith("_1d.csv")
