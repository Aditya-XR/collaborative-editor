"""remove deployment test accounts

The production smoke tests and post-deploy probes of 2026-10-01 and 2026-10-02 each registered
an account to exercise the live service end to end. This deletes exactly those accounts, by
email, together with everything they own (their documents, branches, edits and sessions cascade).
Elsewhere none of these addresses exist, so this does nothing.

Revision ID: 8cbbb2f048f7
Revises: b48a71d073f4
Create Date: 2026-10-02 20:41:07.513946
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8cbbb2f048f7"
down_revision: str | None = "b48a71d073f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TEST_ACCOUNTS = (
    "smoke-alice-47d4b5ba@example.com",
    "smoke-bob-605e929c@example.com",
    "probe-heartbeat-1634a3f7@example.com",
    "probe-phase3-fc90e04d@example.com",
    "probe-phase7-5d1c2e@example.com",
)


def upgrade() -> None:
    op.get_bind().execute(
        sa.text("DELETE FROM users WHERE email IN :emails").bindparams(
            sa.bindparam("emails", expanding=True)
        ),
        {"emails": list(TEST_ACCOUNTS)},
    )


def downgrade() -> None:
    pass  # deleted data cannot come back, and nothing depends on it
