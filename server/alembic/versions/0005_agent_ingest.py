"""Token agenta, partie, cykle odczytu i pomiary partycjonowane (P3.4, D42).

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-07

``agents.token_hash`` jest NOT NULL bez wartości domyślnej: do tej wersji nie było sposobu
utworzenia agenta, więc tabela jest pusta. Jeśli ktoś dodał agenta ręcznie, migracja się
zatrzyma zamiast wymyślać poświadczenie.
"""

from collections.abc import Sequence
from datetime import date

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FIRST_PARTITION = date(2026, 11, 1)
PARTITION_MONTHS = 24

QUALITIES = "('GOOD', 'ESTIMATED', 'STALE', 'INVALID', 'MISSING')"
ORIGINS = "('DEVICE', 'DERIVED', 'SIMULATED', 'DEMO')"
RESULTS = "('OK', 'PARTIAL', 'FAILED')"
ERRORS = (
    "('TIMEOUT', 'CONNECTION_REFUSED', 'CONNECTION_LOST', 'MODBUS_EXCEPTION', 'INVALID_RESPONSE')"
)


def _months() -> list[tuple[date, date]]:
    out = []
    start = FIRST_PARTITION
    for _ in range(PARTITION_MONTHS):
        nxt = date(start.year + start.month // 12, start.month % 12 + 1, 1)
        out.append((start, nxt))
        start = nxt
    return out


def upgrade() -> None:
    op.add_column("agents", sa.Column("token_hash", sa.String(64), nullable=False))
    op.create_unique_constraint("uq_agents_token_hash", "agents", ["token_hash"])

    op.create_table(
        "agent_batches",
        sa.Column("agent_id", sa.Uuid(), nullable=False),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["agent_id"], ["agents.id"], name="fk_agent_batches_agent_id_agents", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("agent_id", "batch_id", name="pk_agent_batches"),
    )

    op.create_table(
        "polling_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("site_id", sa.Uuid(), nullable=False),
        sa.Column("device_id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Uuid(), nullable=True),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("result", sa.String(16), nullable=False),
        sa.Column("error_code", sa.String(32), nullable=True),
        sa.Column("error_detail", sa.String(200), nullable=True),
        sa.Column("ok_points", sa.Integer(), nullable=False),
        sa.Column("failed_points", sa.Integer(), nullable=False),
        sa.CheckConstraint(f"result IN {RESULTS}", name="ck_polling_runs_result"),
        sa.CheckConstraint(
            f"error_code IS NULL OR error_code IN {ERRORS}", name="ck_polling_runs_error"
        ),
        sa.CheckConstraint("ok_points >= 0 AND failed_points >= 0", name="ck_polling_runs_points"),
        sa.ForeignKeyConstraint(
            ["site_id"], ["sites.id"], name="fk_polling_runs_site_id_sites", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["device_id"],
            ["devices.id"],
            name="fk_polling_runs_device_id_devices",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["agent_id"], ["agents.id"], name="fk_polling_runs_agent_id_agents", ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_polling_runs"),
    )
    op.create_index(
        "ix_polling_runs_device_id_started_at", "polling_runs", ["device_id", "started_at"]
    )

    op.create_table(
        "measurements",
        sa.Column("site_id", sa.Uuid(), nullable=False),
        sa.Column("device_id", sa.Uuid(), nullable=False),
        sa.Column("metric", sa.String(64), nullable=False),
        sa.Column("channel", sa.SmallInteger(), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("value", sa.Double(), nullable=True),
        sa.Column("quality", sa.String(16), nullable=False),
        sa.Column("origin", sa.String(16), nullable=False),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.CheckConstraint(f"quality IN {QUALITIES}", name="ck_measurements_quality"),
        sa.CheckConstraint(f"origin IN {ORIGINS}", name="ck_measurements_origin"),
        sa.CheckConstraint("channel >= 0", name="ck_measurements_channel"),
        sa.CheckConstraint(
            "(quality = 'MISSING' AND value IS NULL) OR (quality = 'GOOD' AND value IS NOT NULL) "
            "OR quality NOT IN ('MISSING', 'GOOD')",
            name="ck_measurements_value_quality",
        ),
        sa.ForeignKeyConstraint(
            ["site_id"], ["sites.id"], name="fk_measurements_site_id_sites", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["device_id"],
            ["devices.id"],
            name="fk_measurements_device_id_devices",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "device_id", "metric", "channel", "received_at", name="pk_measurements"
        ),
        postgresql_partition_by="RANGE (received_at)",
    )
    op.create_index(
        "ix_measurements_site_id_received_at", "measurements", ["site_id", "received_at"]
    )
    for start, end in _months():
        op.execute(
            f"CREATE TABLE measurements_y{start.year}m{start.month:02d} PARTITION OF measurements "
            f"FOR VALUES FROM ('{start.isoformat()}') TO ('{end.isoformat()}')"
        )
    # Wszystko poza zakresem (np. błędny zegar albo brak nowych partycji przed P4).
    op.execute("CREATE TABLE measurements_default PARTITION OF measurements DEFAULT")


def downgrade() -> None:
    op.drop_table("measurements")  # usuwa też partycje
    op.drop_index("ix_polling_runs_device_id_started_at", table_name="polling_runs")
    op.drop_table("polling_runs")
    op.drop_table("agent_batches")
    op.drop_constraint("uq_agents_token_hash", "agents", type_="unique")
    op.drop_column("agents", "token_hash")
