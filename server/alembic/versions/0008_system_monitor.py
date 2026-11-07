"""Monitor serwera (P7.1a, D60): próbki metryk hosta, stan składników, ocena stabilności.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-07

Migracja tylko dodaje tabele — istniejące dane pozostają bez zmian.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

METRICS = (
    "'cpu_percent', 'cpu_count', 'load_1m', 'load_5m', 'load_15m', 'mem_used_bytes', "
    "'mem_total_bytes', 'swap_used_bytes', 'swap_total_bytes', 'disk_used_bytes', "
    "'disk_total_bytes', 'cpu_temp_c', 'uptime_s', 'undervoltage_now', 'db_size_bytes'"
)


def upgrade() -> None:
    op.create_table(
        "system_metric_samples",
        sa.Column("sampled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("metric", sa.String(32), nullable=False),
        sa.Column("value", sa.Float(), nullable=True),
        sa.CheckConstraint(f"metric IN ({METRICS})", name="ck_system_metric_samples_metric"),
        sa.PrimaryKeyConstraint("sampled_at", "metric", name="pk_system_metric_samples"),
    )
    op.create_index(
        "ix_system_metric_samples_metric_sampled_at",
        "system_metric_samples",
        ["metric", "sampled_at"],
    )
    op.create_table(
        "system_components",
        sa.Column("component", sa.String(16), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_ok_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "component IN ('api', 'worker', 'agent', 'proxy', 'db')",
            name="ck_system_components_component",
        ),
        sa.CheckConstraint("state IN ('UP', 'DOWN', 'UNKNOWN')", name="ck_system_components_state"),
        sa.PrimaryKeyConstraint("component", name="pk_system_components"),
    )
    op.create_table(
        "system_status",
        sa.Column("id", sa.SmallInteger(), nullable=False),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("level", sa.String(16), nullable=False),
        sa.Column("reasons", postgresql.JSONB(), nullable=False),
        sa.Column("conditions", postgresql.JSONB(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_system_status_single_row"),
        sa.CheckConstraint(
            "level IN ('STABLE', 'WARNING', 'CRITICAL', 'UNKNOWN')", name="ck_system_status_level"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_system_status"),
    )


def downgrade() -> None:
    op.drop_table("system_status")
    op.drop_table("system_components")
    op.drop_table("system_metric_samples")
