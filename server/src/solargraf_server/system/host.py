"""Odczyt metryk hosta z ``/proc`` i ``/sys`` (D16, D60) — bez zależności i bez uprawnień.

W kontenerze Dockera ``/proc/stat``, ``/proc/meminfo``, ``/proc/loadavg`` i ``/proc/uptime``
pokazują wartości hosta, a ``/sys`` jest dostępny tylko do odczytu. Metryka, której host nie
udostępnia (np. temperatura w maszynie wirtualnej), to ``None`` — nigdy 0. W kontenerze LXC
pamięć może odpowiadać limitowi kontenera, nie całemu hostowi.

Zajętość dysku: system plików ścieżki ``disk_path`` (w kontenerze ``/`` — katalog danych Dockera,
na którym leżą też wolumeny bazy).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# Metryki próbki (jednostki kanoniczne: %, bajty, °C, s; flagi 0/1).
CPU_PERCENT = "cpu_percent"
CPU_COUNT = "cpu_count"
LOAD_1M = "load_1m"
LOAD_5M = "load_5m"
LOAD_15M = "load_15m"
MEM_USED = "mem_used_bytes"
MEM_TOTAL = "mem_total_bytes"
SWAP_USED = "swap_used_bytes"
SWAP_TOTAL = "swap_total_bytes"
DISK_USED = "disk_used_bytes"
DISK_TOTAL = "disk_total_bytes"
DB_SIZE = "db_size_bytes"
CPU_TEMP = "cpu_temp_c"
UPTIME = "uptime_s"
UNDERVOLTAGE = "undervoltage_now"

HOST_METRICS = (
    CPU_PERCENT,
    CPU_COUNT,
    LOAD_1M,
    LOAD_5M,
    LOAD_15M,
    MEM_USED,
    MEM_TOTAL,
    SWAP_USED,
    SWAP_TOTAL,
    DISK_USED,
    DISK_TOTAL,
    CPU_TEMP,
    UPTIME,
    UNDERVOLTAGE,
)
METRICS = (*HOST_METRICS, DB_SIZE)

# Strefy termiczne procesora w kolejności preferencji (nazwy typów jądra Linux).
CPU_ZONE_TYPES = ("cpu-thermal", "cpu_thermal", "x86_pkg_temp", "soc_thermal", "coretemp")
# Raspberry Pi: sterownik jądra ``raspberrypi-hwmon`` (urządzenie hwmon ``rpi_volt``) zgłasza
# niedobór napięcia w ``in0_lcrit_alarm``. Do potwierdzenia na RPi 4/5 (O11); brak = niedostępne.
RPI_HWMON_NAME = "rpi_volt"
RPI_UNDERVOLTAGE_FILE = "in0_lcrit_alarm"


@dataclass(frozen=True)
class CpuTimes:
    busy: int
    total: int


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="ascii", errors="replace")
    except OSError:
        return None


def cpu_times(stat: str) -> tuple[CpuTimes | None, int | None]:
    """Łączne czasy CPU z ``/proc/stat`` i liczba rdzeni (linie ``cpuN``)."""
    times: CpuTimes | None = None
    cores = 0
    for line in stat.splitlines():
        if line.startswith("cpu "):
            fields = [int(v) for v in line.split()[1:]]
            # user nice system idle iowait irq softirq steal (guest liczony już w user)
            idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
            total = sum(fields[:8])
            times = CpuTimes(busy=total - idle, total=total)
        elif line.startswith("cpu") and line[3:4].isdigit():
            cores += 1
    return times, cores or None


def cpu_percent(previous: CpuTimes | None, current: CpuTimes | None) -> float | None:
    """Zużycie CPU między dwoma odczytami; None przy pierwszym odczycie albo braku przyrostu."""
    if previous is None or current is None:
        return None
    total = current.total - previous.total
    if total <= 0:
        return None
    busy = max(0, current.busy - previous.busy)
    return round(100 * busy / total, 2)


def meminfo(text: str) -> dict[str, float | None]:
    values: dict[str, int] = {}
    for line in text.splitlines():
        name, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            values[name] = int(parts[0]) * 1024  # kB → bajty
    total, available = values.get("MemTotal"), values.get("MemAvailable")
    swap_total, swap_free = values.get("SwapTotal"), values.get("SwapFree")
    return {
        MEM_TOTAL: total,
        # Zajęta = całkowita - dostępna: bez pamięci podręcznej, którą system odda na żądanie.
        MEM_USED: None if total is None or available is None else total - available,
        SWAP_TOTAL: swap_total,
        SWAP_USED: None if swap_total is None or swap_free is None else swap_total - swap_free,
    }


def loadavg(text: str) -> dict[str, float | None]:
    parts = text.split()
    if len(parts) < 3:
        return {LOAD_1M: None, LOAD_5M: None, LOAD_15M: None}
    return {LOAD_1M: float(parts[0]), LOAD_5M: float(parts[1]), LOAD_15M: float(parts[2])}


def cpu_temperature(sys_root: Path) -> float | None:
    """Temperatura procesora [°C] z preferowanej strefy termicznej; None — brak czujnika."""
    zones: dict[str, float] = {}
    for zone in sorted((sys_root / "class" / "thermal").glob("thermal_zone*")):
        kind, raw = _read(zone / "type"), _read(zone / "temp")
        if kind is None or raw is None:
            continue
        try:
            zones.setdefault(kind.strip(), int(raw.strip()) / 1000)  # m°C → °C
        except ValueError:
            continue
    for kind in CPU_ZONE_TYPES:
        if kind in zones:
            return round(zones[kind], 1)
    return None


def undervoltage(sys_root: Path) -> int | None:
    """1 — niedobór napięcia zasilania RPi teraz, 0 — brak; None — host tego nie udostępnia."""
    for device in sorted((sys_root / "class" / "hwmon").glob("hwmon*")):
        name = _read(device / "name")
        if name is None or name.strip() != RPI_HWMON_NAME:
            continue
        raw = _read(device / RPI_UNDERVOLTAGE_FILE)
        if raw is None or raw.strip() not in ("0", "1"):
            return None
        return int(raw.strip())
    return None


def disk_usage(path: Path) -> dict[str, float | None]:
    statvfs = getattr(os, "statvfs", None)  # tylko systemy uniksowe
    if statvfs is None:
        return {DISK_USED: None, DISK_TOTAL: None}
    try:
        st = statvfs(path)
    except OSError:
        return {DISK_USED: None, DISK_TOTAL: None}
    used = (st.f_blocks - st.f_bfree) * st.f_frsize
    # Jak ``df``: pojemność dostępna dla aplikacji = zajęte + wolne dla zwykłego użytkownika.
    return {DISK_USED: used, DISK_TOTAL: used + st.f_bavail * st.f_frsize}


class HostSampler:
    """Kolejne próbki metryk hosta; zużycie CPU liczone z różnicy dwóch odczytów."""

    def __init__(
        self,
        proc_root: Path = Path("/proc"),
        sys_root: Path = Path("/sys"),
        disk_path: Path = Path("/"),
    ) -> None:
        self.proc_root = proc_root
        self.sys_root = sys_root
        self.disk_path = disk_path
        self._previous: CpuTimes | None = None

    def sample(self) -> dict[str, float | None]:
        values: dict[str, float | None] = dict.fromkeys(HOST_METRICS)
        stat = _read(self.proc_root / "stat")
        if stat is not None:
            current, cores = cpu_times(stat)
            values[CPU_PERCENT] = cpu_percent(self._previous, current)
            values[CPU_COUNT] = cores
            self._previous = current
        if (text := _read(self.proc_root / "meminfo")) is not None:
            values.update(meminfo(text))
        if (text := _read(self.proc_root / "loadavg")) is not None:
            values.update(loadavg(text))
        if (text := _read(self.proc_root / "uptime")) is not None and text.split():
            values[UPTIME] = float(text.split()[0])
        values[CPU_TEMP] = cpu_temperature(self.sys_root)
        values[UNDERVOLTAGE] = undervoltage(self.sys_root)
        values.update(disk_usage(self.disk_path))
        return values
