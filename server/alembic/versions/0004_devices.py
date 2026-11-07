"""Agenci, połączenia i urządzenia (P2.3, D38).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TRANSPORTS = "('MODBUS_TCP', 'MODBUS_RTU', 'SOLARMAN_V5', 'HTTP', 'MQTT')"
KINDS = "('INVERTER', 'BATTERY', 'BMS', 'METER', 'MPPT', 'SENSOR', 'GATEWAY')"


def _created_at() -> sa.Column[object]:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )


def upgrade() -> None:
    op.create_table(
        "agents",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("version", sa.String(64), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("last_heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        _created_at(),
        sa.CheckConstraint("mode IN ('LOCAL', 'REMOTE')", name="ck_agents_mode"),
        sa.PrimaryKeyConstraint("id", name="pk_agents"),
    )
    op.create_table(
        "connections",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("site_id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("transport", sa.String(32), nullable=False),
        sa.Column("host", sa.String(253), nullable=True),
        sa.Column("port", sa.Integer(), nullable=True),
        sa.Column("unit_id", sa.Integer(), nullable=True),
        sa.Column("poll_interval_seconds", sa.Integer(), nullable=True),
        sa.Column("timeout_seconds", sa.Integer(), nullable=True),
        _created_at(),
        sa.CheckConstraint(f"transport IN {TRANSPORTS}", name="ck_connections_transport"),
        sa.CheckConstraint(
            "port IS NULL OR (port BETWEEN 1 AND 65535)", name="ck_connections_port"
        ),
        sa.CheckConstraint(
            "unit_id IS NULL OR (unit_id BETWEEN 0 AND 255)", name="ck_connections_unit_id"
        ),
        sa.CheckConstraint(
            "poll_interval_seconds IS NULL OR poll_interval_seconds > 0",
            name="ck_connections_poll_interval",
        ),
        sa.CheckConstraint(
            "timeout_seconds IS NULL OR timeout_seconds > 0", name="ck_connections_timeout"
        ),
        sa.UniqueConstraint("id", "site_id", name="uq_connections_id_site_id"),
        sa.ForeignKeyConstraint(
            ["site_id"], ["sites.id"], name="fk_connections_site_id_sites", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["agent_id"], ["agents.id"], name="fk_connections_agent_id_agents", ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_connections"),
    )
    op.create_index("ix_connections_site_id", "connections", ["site_id"])
    op.create_index("ix_connections_agent_id", "connections", ["agent_id"])
    op.create_table(
        "devices",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("site_id", sa.Uuid(), nullable=False),
        sa.Column("connection_id", sa.Uuid(), nullable=False),
        sa.Column("parent_device_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("manufacturer", sa.String(100), nullable=True),
        sa.Column("model", sa.String(100), nullable=True),
        sa.Column("firmware_version", sa.String(100), nullable=True),
        sa.Column("serial_number", sa.String(100), nullable=True),
        sa.Column("profile_id", sa.String(100), nullable=True),
        sa.Column("profile_version", sa.String(32), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("freshness_threshold_seconds", sa.Integer(), nullable=False),
        _created_at(),
        sa.CheckConstraint(f"kind IN {KINDS}", name="ck_devices_kind"),
        sa.CheckConstraint(
            "freshness_threshold_seconds > 0", name="ck_devices_freshness_threshold"
        ),
        sa.ForeignKeyConstraint(
            ["connection_id", "site_id"],
            ["connections.id", "connections.site_id"],
            name="fk_devices_connection_site_connections",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["site_id"], ["sites.id"], name="fk_devices_site_id_sites", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["parent_device_id"],
            ["devices.id"],
            name="fk_devices_parent_device_id_devices",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_devices"),
    )
    op.create_index("ix_devices_site_id", "devices", ["site_id"])
    op.create_index("ix_devices_connection_id", "devices", ["connection_id"])
    op.create_index("ix_devices_parent_device_id", "devices", ["parent_device_id"])


def downgrade() -> None:
    op.drop_index("ix_devices_parent_device_id", table_name="devices")
    op.drop_index("ix_devices_connection_id", table_name="devices")
    op.drop_index("ix_devices_site_id", table_name="devices")
    op.drop_table("devices")
    op.drop_index("ix_connections_agent_id", table_name="connections")
    op.drop_index("ix_connections_site_id", table_name="connections")
    op.drop_table("connections")
    op.drop_table("agents")
