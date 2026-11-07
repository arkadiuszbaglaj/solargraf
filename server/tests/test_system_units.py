"""Monitor serwera (D60) bez bazy: odczyt /proc i /sys, histereza progów, sprawdzanie składników."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from solargraf_server.system import host
from solargraf_server.system.monitor import http_ok, tcp_ok
from solargraf_server.system.stability import (
    CPU_HIGH,
    ComponentState,
    Condition,
    Evaluation,
    Level,
    Severity,
    component_code,
    level_of,
)

T0 = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)
GIB = 1024**3


def write(root: Path, relative: str, content: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="ascii")


# Wartości testowe w formacie jądra Linux — nie pochodzą z rzeczywistego hosta.
STAT_1 = (
    "cpu  100 0 100 700 100 0 0 0 0 0\n"
    "cpu0 50 0 50 350 50 0 0 0 0 0\n"
    "cpu1 50 0 50 350 50 0 0 0 0 0\n"
)
STAT_2 = (
    "cpu  250 0 150 800 100 0 0 0 0 0\n"
    "cpu0 125 0 75 400 50 0 0 0 0 0\n"
    "cpu1 125 0 75 400 50 0 0 0 0 0\n"
)
MEMINFO = (
    "MemTotal:        8000000 kB\nMemFree:          500000 kB\n"
    "MemAvailable:    2000000 kB\nSwapTotal:       1000000 kB\nSwapFree:         750000 kB\n"
)


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    proc, sys = tmp_path / "proc", tmp_path / "sys"
    write(proc, "stat", STAT_1)
    write(proc, "meminfo", MEMINFO)
    write(proc, "loadavg", "0.52 0.40 0.31 2/345 6789\n")
    write(proc, "uptime", "12345.67 20000.00\n")
    write(sys, "class/thermal/thermal_zone0/type", "acpitz\n")
    write(sys, "class/thermal/thermal_zone0/temp", "30000\n")
    write(sys, "class/thermal/thermal_zone1/type", "x86_pkg_temp\n")
    write(sys, "class/thermal/thermal_zone1/temp", "51500\n")
    return proc, sys


def test_sample_reads_host_values(roots: tuple[Path, Path], tmp_path: Path) -> None:
    proc, sys = roots
    sampler = host.HostSampler(proc, sys, tmp_path)
    first = sampler.sample()
    assert first[host.CPU_PERCENT] is None  # pierwszy odczyt nie ma różnicy
    assert first[host.CPU_COUNT] == 2
    assert first[host.MEM_TOTAL] == 8_000_000 * 1024
    # Zajęta = całkowita - dostępna (bez pamięci podręcznej).
    assert first[host.MEM_USED] == 6_000_000 * 1024
    assert first[host.SWAP_USED] == 250_000 * 1024
    assert (first[host.LOAD_1M], first[host.LOAD_15M]) == (0.52, 0.31)
    assert first[host.UPTIME] == 12345.67
    assert first[host.CPU_TEMP] == 51.5  # strefa procesora, nie pierwsza z brzegu
    assert first[host.UNDERVOLTAGE] is None  # nie RPi — niedostępne, nie 0

    write(proc, "stat", STAT_2)
    # Łącznie 1000 → 1300 (+300), zajęte (bez idle i iowait) 200 → 400 (+200): 66,67%.
    assert sampler.sample()[host.CPU_PERCENT] == 66.67


def test_missing_files_are_unavailable_not_zero(tmp_path: Path) -> None:
    values = host.HostSampler(tmp_path / "proc", tmp_path / "sys", tmp_path / "brak").sample()
    for metric in host.HOST_METRICS:
        assert values[metric] is None, metric


def test_raspberry_pi_undervoltage_from_hwmon(tmp_path: Path) -> None:
    write(tmp_path, "class/hwmon/hwmon0/name", "cpu_thermal\n")
    write(tmp_path, "class/hwmon/hwmon1/name", "rpi_volt\n")
    write(tmp_path, "class/hwmon/hwmon1/in0_lcrit_alarm", "1\n")
    assert host.undervoltage(tmp_path) == 1
    write(tmp_path, "class/hwmon/hwmon1/in0_lcrit_alarm", "0\n")
    assert host.undervoltage(tmp_path) == 0
    write(tmp_path, "class/hwmon/hwmon1/in0_lcrit_alarm", "x\n")
    assert host.undervoltage(tmp_path) is None


def test_cpu_percent_without_progress_is_none() -> None:
    same = host.CpuTimes(busy=10, total=100)
    assert host.cpu_percent(same, same) is None
    assert host.cpu_percent(None, same) is None


# --- histereza ---------------------------------------------------------------------------


def values(**overrides: float | None) -> dict[str, float | None]:
    base: dict[str, float | None] = {
        host.CPU_PERCENT: 10,
        host.MEM_USED: 1 * GIB,
        host.MEM_TOTAL: 8 * GIB,
        host.DISK_USED: 10 * GIB,
        host.DISK_TOTAL: 100 * GIB,
        host.CPU_TEMP: 40,
        host.UNDERVOLTAGE: None,
    }
    return base | overrides


UP = dict.fromkeys(("api", "worker", "agent", "proxy", "db"), ComponentState.UP)


def steps(evaluation: Evaluation, sample: dict[str, float | None], count: int, start: int) -> None:
    for minute in range(start, start + count):
        evaluation.step(sample, UP, T0 + timedelta(minutes=minute))


def codes(evaluation: Evaluation) -> list[str]:
    return [r.code for r in evaluation.reasons()]


def test_cpu_warning_only_after_15_minutes_and_clears_after_2_samples() -> None:
    ev = Evaluation()
    steps(ev, values(**{host.CPU_PERCENT: 90}), 14, 0)
    assert codes(ev) == []
    ev.step(values(**{host.CPU_PERCENT: 90}), UP, T0 + timedelta(minutes=14))
    assert codes(ev) == [CPU_HIGH.code]
    assert ev.reasons()[0].since == T0 + timedelta(minutes=14)
    # 82% — poniżej progu wejścia, ale nad progiem wyłączenia (80%): warunek trwa.
    steps(ev, values(**{host.CPU_PERCENT: 82}), 5, 15)
    assert codes(ev) == [CPU_HIGH.code]
    ev.step(values(**{host.CPU_PERCENT: 70}), UP, T0 + timedelta(minutes=20))
    assert codes(ev) == [CPU_HIGH.code]
    ev.step(values(**{host.CPU_PERCENT: 70}), UP, T0 + timedelta(minutes=21))
    assert codes(ev) == []


def test_one_spike_resets_the_streak() -> None:
    ev = Evaluation()
    steps(ev, values(**{host.CPU_PERCENT: 90}), 10, 0)
    ev.step(values(**{host.CPU_PERCENT: 50}), UP, T0 + timedelta(minutes=10))
    steps(ev, values(**{host.CPU_PERCENT: 90}), 10, 11)
    assert codes(ev) == []


def test_missing_measurement_does_not_change_state() -> None:
    ev = Evaluation()
    ev.step(values(**{host.CPU_TEMP: 80}), UP, T0)
    assert codes(ev) == ["TEMPERATURE_HIGH"]
    steps(ev, values(**{host.CPU_TEMP: None}), 5, 1)
    assert codes(ev) == ["TEMPERATURE_HIGH"]


def test_disk_warning_and_critical_levels() -> None:
    ev = Evaluation()
    ev.step(values(**{host.DISK_USED: 90 * GIB}), UP, T0)
    assert codes(ev) == ["DISK_HIGH"]
    assert level_of(ev.reasons()) is Level.WARNING
    ev.step(values(**{host.DISK_USED: 96 * GIB}), UP, T0 + timedelta(minutes=1))
    assert codes(ev) == ["DISK_FULL", "DISK_HIGH"]  # krytyczne najpierw
    assert level_of(ev.reasons()) is Level.CRITICAL


def test_memory_and_undervoltage() -> None:
    ev = Evaluation()
    sample = values(**{host.MEM_USED: 7.5 * GIB, host.UNDERVOLTAGE: 1})
    ev.step(sample, UP, T0)
    assert codes(ev) == ["UNDERVOLTAGE", "MEMORY_HIGH"]
    assert ev.reasons()[0].severity is Severity.CRITICAL


def test_component_down_after_two_checks_unknown_is_ignored() -> None:
    ev = Evaluation()
    down = UP | {"proxy": ComponentState.DOWN, "agent": ComponentState.UNKNOWN}
    ev.step(values(), down, T0)
    assert codes(ev) == []
    ev.step(values(), down, T0 + timedelta(minutes=1))
    assert codes(ev) == [component_code("proxy")]
    assert "Serwer WWW" in ev.reasons()[0].message
    ev.step(values(), UP, T0 + timedelta(minutes=2))
    ev.step(values(), UP, T0 + timedelta(minutes=3))
    assert codes(ev) == []
    assert level_of(ev.reasons()) is Level.STABLE


def test_state_survives_json_roundtrip() -> None:
    ev = Evaluation()
    steps(ev, values(**{host.CPU_PERCENT: 95}), 7, 0)
    restored = Evaluation.from_json(ev.to_json())
    steps(restored, values(**{host.CPU_PERCENT: 95}), 8, 7)
    assert codes(restored) == [CPU_HIGH.code]
    assert Condition.from_json(Condition(True, T0).to_json()) == Condition(True, T0)


# --- sprawdzanie składników --------------------------------------------------------------


async def _serve(response: bytes) -> tuple[asyncio.Server, int]:
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readuntil(b"\r\n\r\n")
        writer.write(response)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, int(server.sockets[0].getsockname()[1])


def test_http_and_tcp_checks() -> None:
    async def go() -> None:
        ok, ok_port = await _serve(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        bad, bad_port = await _serve(b"HTTP/1.1 503 Service Unavailable\r\n\r\n")
        try:
            assert await http_ok(f"http://127.0.0.1:{ok_port}/api/health/ready", 2)
            assert not await http_ok(f"http://127.0.0.1:{bad_port}/", 2)
            assert await tcp_ok(f"127.0.0.1:{ok_port}", 2)
        finally:
            ok.close()
            bad.close()
            await ok.wait_closed()
            await bad.wait_closed()
        # Zamknięty port: niedostępny, bez wyjątku.
        assert not await http_ok(f"http://127.0.0.1:{ok_port}/", 1)
        assert not await tcp_ok(f"127.0.0.1:{ok_port}", 1)
        with pytest.raises(ValueError, match="http"):
            await http_ok("https://api/", 1)

    asyncio.run(go())
