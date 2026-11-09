"""Model profilu urządzenia (D39) i reguły spójności.

Profil opisuje, jak odczytać metryki kanoniczne z rejestrów urządzenia. Każdy punkt danych
wskazuje źródło dowodu; brak dowodu to status ``UNVERIFIED``, nigdy zgadywany rejestr.

Adresowanie: ``registers`` — stałe adresy rejestrów; ``sunspec`` (D59) — model i nazwa punktu
SunSpec, adres ustala agent z mapy urządzenia, a typ, skalę i jednostkę definicja modelu.
"""

from __future__ import annotations

import enum
from datetime import date
from decimal import Decimal
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

from solargraf_profiles import sunspec
from solargraf_profiles.catalog import (
    METRICS,
    REGISTER_TRANSPORTS,
    UNITS,
    DeviceKind,
    Transport,
    Unit,
)

SCHEMA_VERSION = 1
# Ograniczenie protokołu Modbus dla odczytu rejestrów (funkcje 0x03/0x04).
MODBUS_MAX_BLOCK = 125

PROFILE_ID = r"^[a-z0-9]+(?:[.-][a-z0-9]+)+$"
SOURCE_ID = r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$"
SEMVER = r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"
SIMULATED_PREFIX = "simulated."

Text = Annotated[StrictStr, Field(min_length=1, max_length=200)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SupportLevel(enum.StrEnum):
    VERIFIED = "VERIFIED"  # przetestowany na rzeczywistym modelu i firmware
    COMMUNITY = "COMMUNITY"  # z dokumentacji, przetestowany na symulatorze
    EXPERIMENTAL = "EXPERIMENTAL"  # niepełny albo bez potwierdzonej dokumentacji


class PointStatus(enum.StrEnum):
    VERIFIED = "VERIFIED"
    PARTIALLY_VERIFIED = "PARTIALLY_VERIFIED"
    UNVERIFIED = "UNVERIFIED"
    UNSUPPORTED = "UNSUPPORTED"  # urządzenie tego parametru nie udostępnia


class ProfileOrigin(enum.StrEnum):
    DEVICE = "DEVICE"
    SIMULATED = "SIMULATED"


class RegisterTable(enum.StrEnum):
    HOLDING = "holding"
    INPUT = "input"


class DataType(enum.StrEnum):
    U16 = "u16"
    S16 = "s16"
    U32 = "u32"
    S32 = "s32"
    F32 = "f32"

    @property
    def registers(self) -> int:
        return 1 if self in (DataType.U16, DataType.S16) else 2


class WordOrder(enum.StrEnum):
    # Kolejność 16-bitowych słów wartości 32-bitowej. Bajty w słowie: big-endian (standard Modbus).
    HIGH_FIRST = "high_first"
    LOW_FIRST = "low_first"


class Addressing(enum.StrEnum):
    REGISTERS = "registers"
    SUNSPEC = "sunspec"


class Sign(enum.StrEnum):
    NORMAL = "normal"
    INVERT = "invert"  # urządzenie używa odwrotnej konwencji niż katalog metryk


class Source(_Strict):
    id: Annotated[StrictStr, Field(pattern=SOURCE_ID, max_length=64)]
    title: Text
    # Wersja/wydanie dokumentu — bez niej nie wiadomo, czego dotyczy dowód.
    version: Text
    reference: Text | None = None


class HardwareTest(_Strict):
    model: Text
    firmware: Text
    tested_on: date
    note: Text | None = None


class Polling(_Strict):
    interval_seconds: Annotated[StrictInt, Field(ge=1, le=3600)]
    timeout_seconds: Annotated[StrictInt, Field(ge=1, le=60)]
    retries: Annotated[StrictInt, Field(ge=0, le=5)]
    max_block_registers: Annotated[StrictInt, Field(ge=1, le=MODBUS_MAX_BLOCK)]
    # Szybki odczyt tylko do podglądu na żywo (D78); do bazy trafia co ``interval_seconds``.
    # Brak = podgląd w rytmie zapisu.
    live_interval_seconds: Annotated[float, Field(ge=1, le=3600, allow_inf_nan=False)] | None = None

    @model_validator(mode="after")
    def _timeout_below_interval(self) -> Self:
        if self.timeout_seconds >= self.interval_seconds:
            raise ValueError("timeout_seconds musi być mniejszy niż interval_seconds")
        if self.live_interval_seconds is not None and (
            self.live_interval_seconds > self.interval_seconds
        ):
            raise ValueError("live_interval_seconds nie może być dłuższy niż interval_seconds")
        return self


class Register(_Strict):
    table: RegisterTable
    address: Annotated[StrictInt, Field(ge=0, le=65535)]
    type: DataType
    word_order: WordOrder | None = None

    @model_validator(mode="after")
    def _word_order(self) -> Self:
        if self.type.registers == 2 and self.word_order is None:
            raise ValueError(f"typ {self.type} wymaga word_order")
        if self.type.registers == 1 and self.word_order is not None:
            raise ValueError(f"typ {self.type} nie ma word_order")
        if self.address + self.type.registers - 1 > 65535:
            raise ValueError("rejestr wychodzi poza zakres adresów")
        return self

    @property
    def span(self) -> range:
        return range(self.address, self.address + self.type.registers)


class SunSpecRef(_Strict):
    """Punkt modelu SunSpec. ``group`` — grupa powtarzana; numer powtórzenia = ``channel`` - 1."""

    model: StrictInt
    point: Annotated[StrictStr, Field(min_length=1, max_length=32)]
    group: Annotated[StrictStr, Field(min_length=1, max_length=32)] | None = None

    def resolve(self) -> sunspec.SunSpecPoint:
        """Definicja punktu z dołączonych modeli; błąd, gdy model, grupa albo punkt są nieznane."""
        return sunspec.load_model(self.model).point(self.point, self.group)


class DataPoint(_Strict):
    metric: StrictStr
    channel: Annotated[StrictInt, Field(ge=1, le=32)] | None = None
    status: PointStatus
    source: StrictStr
    # Miejsce w dokumencie (tabela, strona, nazwa rejestru) — ułatwia weryfikację.
    source_ref: Text | None = None
    # W YAML klucz ``register``; w Pythonie ``reg`` (``register`` zasłania metodę BaseModel).
    reg: Register | None = Field(default=None, alias="register")
    sunspec: SunSpecRef | None = None
    scale: Annotated[Decimal, Field(gt=0)] = Decimal(1)
    unit: Unit | None = None
    sign: Sign = Sign.NORMAL

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        metric = METRICS.get(self.metric)
        if metric is None:
            raise ValueError(f"nieznana metryka {self.metric!r}")
        if metric.channeled and self.channel is None:
            raise ValueError(f"metryka {self.metric} wymaga channel")
        if not metric.channeled and self.channel is not None:
            raise ValueError(f"metryka {self.metric} nie ma kanałów")
        if self.status is PointStatus.UNSUPPORTED:
            if self.reg is not None or self.sunspec is not None or self.unit is not None:
                raise ValueError("punkt UNSUPPORTED nie ma rejestru ani jednostki")
            return self
        if (self.reg is None) == (self.sunspec is None) or self.unit is None:
            raise ValueError("punkt danych wymaga unit i dokładnie jednego z: register, sunspec")
        if self.sunspec is not None:
            self._check_sunspec(self.sunspec, metric.channeled)
        if UNITS[self.unit].quantity is not metric.quantity:
            raise ValueError(
                f"jednostka {self.unit} nie pasuje do metryki {self.metric} "
                f"(oczekiwano {metric.canonical_unit} lub pochodnej)"
            )
        if self.sign is Sign.INVERT and not metric.signed:
            raise ValueError(f"metryka {self.metric} nie ma znaku — sign: invert niedozwolone")
        return self

    def _check_sunspec(self, ref: SunSpecRef, channeled: bool) -> None:
        try:
            point = ref.resolve()
        except sunspec.SunSpecError as exc:
            raise ValueError(str(exc)) from None
        if point.type not in sunspec.VALUE_TYPES:
            raise ValueError(f"punkt SunSpec {ref.point} ma typ {point.type} bez wartości metryki")
        if sunspec.UNIT_NAMES.get(point.units or "") != (self.unit.value if self.unit else None):
            raise ValueError(
                f"jednostka {self.unit} nie zgadza się z definicją punktu SunSpec {ref.point} "
                f"({point.units})"
            )
        # Skala SunSpec jest dynamiczna (rejestr ``*_SF``) — stała skala profilu byłaby drugą skalą.
        if self.scale != 1:
            raise ValueError("punkt SunSpec nie ma stałej skali (scale)")
        if ref.group is not None and not channeled:
            raise ValueError(f"punkt grupy {ref.group} wymaga metryki z kanałami")

    @property
    def key(self) -> tuple[str, int | None]:
        return (self.metric, self.channel)


class Profile(_Strict):
    schema_version: StrictInt
    id: Annotated[StrictStr, Field(pattern=PROFILE_ID, max_length=100)]
    version: Annotated[StrictStr, Field(pattern=SEMVER, max_length=32)]
    name: Text
    manufacturer: Text
    device_kind: DeviceKind
    origin: ProfileOrigin
    support_level: SupportLevel
    # Tylko modele i firmware potwierdzone dokumentacją lub testem.
    models: list[Text] = Field(default_factory=list)
    firmware: list[Text] = Field(default_factory=list)
    transports: Annotated[list[Transport], Field(min_length=1)]
    addressing: Addressing = Addressing.REGISTERS
    sources: Annotated[list[Source], Field(min_length=1)]
    hardware_tests: list[HardwareTest] = Field(default_factory=list)
    polling: Polling
    points: Annotated[list[DataPoint], Field(min_length=1)]

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        errors = [
            *self._check_identity(),
            *self._check_transports(),
            *self._check_sources(),
            *self._check_points(),
            *self._check_support_level(),
        ]
        if errors:
            raise ValueError("; ".join(errors))
        return self

    def _check_identity(self) -> list[str]:
        if self.schema_version != SCHEMA_VERSION:
            return [f"nieobsługiwana schema_version {self.schema_version}"]
        simulated_id = self.id.startswith(SIMULATED_PREFIX)
        if (self.origin is ProfileOrigin.SIMULATED) != simulated_id:
            return [f"profil SIMULATED musi mieć id z prefiksem {SIMULATED_PREFIX!r} i odwrotnie"]
        if self.origin is ProfileOrigin.SIMULATED and self.support_level is not (
            SupportLevel.EXPERIMENTAL
        ):
            return ["profil SIMULATED może mieć tylko poziom EXPERIMENTAL"]
        if self.origin is ProfileOrigin.DEVICE and not self.models:
            return ["profil urządzenia wymaga listy potwierdzonych modeli"]
        return []

    def _check_transports(self) -> list[str]:
        unsupported = [t.value for t in self.transports if t not in REGISTER_TRANSPORTS]
        if unsupported:
            return [f"format profilu obsługuje tylko transporty rejestrowe, nie {unsupported}"]
        if len(set(self.transports)) != len(self.transports):
            return ["powtórzony transport"]
        return []

    def _check_sources(self) -> list[str]:
        ids = [s.id for s in self.sources]
        errors = []
        if len(set(ids)) != len(ids):
            errors.append("powtórzony identyfikator źródła")
        unknown = sorted({p.source for p in self.points} - set(ids))
        if unknown:
            errors.append(f"punkty wskazują nieznane źródła {unknown}")
        unused = sorted(set(ids) - {p.source for p in self.points})
        if unused:
            errors.append(f"nieużywane źródła {unused}")
        return errors

    def _check_points(self) -> list[str]:
        errors: list[str] = []
        seen: set[tuple[str, int | None]] = set()
        occupied: dict[tuple[RegisterTable, int], str] = {}
        for p in self.points:
            label = p.metric if p.channel is None else f"{p.metric}[{p.channel}]"
            if p.key in seen:
                errors.append(f"powtórzony punkt {label}")
            seen.add(p.key)
            if p.status is not PointStatus.UNSUPPORTED:
                uses_sunspec = p.sunspec is not None
                if uses_sunspec != (self.addressing is Addressing.SUNSPEC):
                    errors.append(f"{label}: sposób adresowania niezgodny z addressing profilu")
            if p.reg is None:
                continue
            for addr in p.reg.span:
                slot = (p.reg.table, addr)
                if slot in occupied:
                    errors.append(
                        f"{label} nakłada się na {occupied[slot]} (rejestr {p.reg.table} {addr})"
                    )
                    break
                occupied[slot] = label
        refs = [
            (p.sunspec.model, p.sunspec.group, p.sunspec.point, p.channel)
            for p in self.points
            if p.sunspec
        ]
        if len(set(refs)) != len(refs):
            errors.append("dwa punkty wskazują ten sam punkt SunSpec")
        if all(p.status is PointStatus.UNSUPPORTED for p in self.points):
            errors.append("profil nie ma żadnego odczytywalnego punktu")
        return errors

    @property
    def sunspec_models(self) -> list[int]:
        """Modele SunSpec wymagane przez profil (rosnąco)."""
        return sorted({p.sunspec.model for p in self.points if p.sunspec is not None})

    def _check_support_level(self) -> list[str]:
        if self.support_level is not SupportLevel.VERIFIED:
            return []
        errors = []
        if not self.hardware_tests:
            errors.append("poziom VERIFIED wymaga zapisu testu sprzętowego (hardware_tests)")
        unverified = [p.metric for p in self.points if p.status is PointStatus.UNVERIFIED]
        if unverified:
            errors.append(f"poziom VERIFIED nie dopuszcza punktów UNVERIFIED: {unverified}")
        return errors
