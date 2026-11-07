"""Planowanie bloków odczytu z profilu (D41).

Łączymy tylko ciągłe rejestry tej samej tabeli — czytanie „przez dziury” na wielu urządzeniach
kończy się wyjątkiem dla całego bloku.
"""

from __future__ import annotations

from dataclasses import dataclass

from solargraf_profiles.model import Addressing, DataPoint, Profile, RegisterTable


@dataclass(frozen=True)
class Block:
    table: RegisterTable
    address: int
    count: int
    points: tuple[DataPoint, ...]

    def words_for(self, point: DataPoint, words: list[int]) -> list[int]:
        assert point.reg is not None  # noqa: S101 — w bloku są tylko punkty z rejestrem
        start = point.reg.address - self.address
        return words[start : start + point.reg.type.registers]


def plan_blocks(profile: Profile) -> list[Block]:
    if profile.addressing is not Addressing.REGISTERS:
        # Adresy SunSpec zna dopiero mapa urządzenia — odczyt planuje ``sunspec_map``.
        raise ValueError(f"profil {profile.id}: adresowanie {profile.addressing} nieobsługiwane")
    limit = profile.polling.max_block_registers
    points = sorted(
        (p for p in profile.points if p.reg is not None),
        key=lambda p: (p.reg.table, p.reg.address) if p.reg else ("", 0),
    )
    blocks: list[Block] = []
    current: list[DataPoint] = []
    for p in points:
        assert p.reg is not None  # noqa: S101
        if current:
            first, last = current[0].reg, current[-1].reg
            assert first is not None  # noqa: S101
            assert last is not None  # noqa: S101
            end = last.address + last.type.registers
            fits = p.reg.address + p.reg.type.registers - first.address <= limit
            if p.reg.table == first.table and p.reg.address == end and fits:
                current.append(p)
                continue
            blocks.append(_block(current))
        current = [p]
    if current:
        blocks.append(_block(current))
    return blocks


def _block(points: list[DataPoint]) -> Block:
    first, last = points[0].reg, points[-1].reg
    assert first is not None  # noqa: S101
    assert last is not None  # noqa: S101
    count = last.address + last.type.registers - first.address
    return Block(first.table, first.address, count, tuple(points))
