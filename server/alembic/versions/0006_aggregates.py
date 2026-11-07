"""Agregaty 5 min / 1 h / 1 d i kolejka godzin do przeliczenia (P4.1, D46).

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-07

Migracja tylko dodaje tabele — istniejące pomiary pozostają bez zmian. Agregaty dla danych
sprzed migracji nie powstają automatycznie (godziny nie są oznaczone do przeliczenia).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "aggregates",
        sa.Column("site_id", sa.Uuid(), nullable=False),
        sa.Column("device_id", sa.Uuid(), nullable=False),
        sa.Column("metric", sa.String(64), nullable=False),
        sa.Column("channel", sa.SmallInteger(), nullable=False),
        sa.Column("resolution", sa.String(4), nullable=False),
        sa.Column("bucket_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("avg", sa.Double(), nullable=True),
        sa.Column("min", sa.Double(), nullable=True),
        sa.Column("max", sa.Double(), nullable=True),
        sa.Column("last", sa.Double(), nullable=True),
        sa.Column("samples", sa.Integer(), nullable=False),
        sa.Column("good_samples", sa.Integer(), nullable=False),
        sa.Column("coverage", sa.Double(), nullable=False),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("resolution IN ('5m', '1h', '1d')", name="ck_aggregates_resolution"),
        sa.CheckConstraint(
            "good_samples >= 0 AND samples >= good_samples", name="ck_aggregates_samples"
        ),
        sa.CheckConstraint("coverage >= 0 AND coverage <= 1", name="ck_aggregates_coverage"),
        sa.CheckConstraint(
            "(good_samples = 0) = (avg IS NULL)", name="ck_aggregates_values_need_good"
        ),
        sa.ForeignKeyConstraint(
            ["site_id"], ["sites.id"], name="fk_aggregates_site_id_sites", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["device_id"],
            ["devices.id"],
            name="fk_aggregates_device_id_devices",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "device_id", "metric", "channel", "resolution", "bucket_start", name="pk_aggregates"
        ),
    )
    op.create_table(
        "aggregate_dirty",
        sa.Column("device_id", sa.Uuid(), nullable=False),
        sa.Column("hour_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "marked_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["device_id"],
            ["devices.id"],
            name="fk_aggregate_dirty_device_id_devices",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("device_id", "hour_start", name="pk_aggregate_dirty"),
    )


def downgrade() -> None:
    op.drop_table("aggregate_dirty")
    op.drop_table("aggregates")
