"""Mapa rejestrów symulatora budowana z profilu (D40)."""

from __future__ import annotations

from collections import Counter
from decimal import Decimal

from solargraf_profiles.codec import CodecError, encode
from solargraf_profiles.model import MODBUS_MAX_BLOCK, Addressing, Profile, RegisterTable

# Wielkości stringów PV dzielone równo między kanały (napięcie jest wspólne).
SPLIT_BY_STRINGS = frozenset({"pv_string_power", "pv_string_current"})


class ModbusException(Exception):
    """Błąd zwracany klientowi jako wyjątek Modbus (kod z specyfikacji protokołu)."""

    ILLEGAL_FUNCTION = 0x01
    ILLEGAL_DATA_ADDRESS = 0x02
    ILLEGAL_DATA_VALUE = 0x03
    SERVER_DEVICE_FAILURE = 0x04

    def __init__(self, code: int) -> None:
        super().__init__(f"wyjątek Modbus {code:#04x}")
        self.code = code


class RegisterMap:
    def __init__(self, profile: Profile) -> None:
        if profile.addressing is not Addressing.REGISTERS:
            raise ValueError(
                f"profil {profile.id}: adresowanie {profile.addressing} nieobsługiwane"
            )
        self.profile = profile
        self._points = [p for p in profile.points if p.reg is not None]
        self._strings = Counter(p.channel for p in self._points if p.metric in SPLIT_BY_STRINGS)

    def snapshot(self, metrics: dict[str, Decimal]) -> dict[tuple[RegisterTable, int], int]:
        """Wartości wszystkich rejestrów profilu dla bieżącego stanu modelu."""
        words: dict[tuple[RegisterTable, int], int] = {}
        for p in self._points:
            assert p.reg is not None  # noqa: S101 — przefiltrowane w __init__
            value = metrics[p.metric]
            if p.metric in SPLIT_BY_STRINGS and self._strings:
                value = value / len(self._strings)
            try:
                encoded = encode(p, value)
            except CodecError:
                # Model wyszedł poza zakres typu rejestru — urządzenie zgłasza awarię, nie zero.
                raise ModbusException(ModbusException.SERVER_DEVICE_FAILURE) from None
            for offset, word in enumerate(encoded):
                words[(p.reg.table, p.reg.address + offset)] = word
        return words

    def read(
        self, metrics: dict[str, Decimal], table: RegisterTable, address: int, count: int
    ) -> list[int]:
        limit = min(MODBUS_MAX_BLOCK, self.profile.polling.max_block_registers)
        if not 1 <= count <= limit:
            raise ModbusException(ModbusException.ILLEGAL_DATA_VALUE)
        words = self.snapshot(metrics)
        keys = [(table, a) for a in range(address, address + count)]
        # Rejestr spoza profilu to błąd adresu — nigdy zero.
        if any(k not in words for k in keys):
            raise ModbusException(ModbusException.ILLEGAL_DATA_ADDRESS)
        return [words[k] for k in keys]
