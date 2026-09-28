import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

import structlog
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import RefreshToken, User
from app.auth.schemas import RegisterRequest
from app.core.config import Settings
from app.core.errors import ApiError
from app.core.ids import uuid7
from app.core.security import (
    create_access_token,
    hash_password,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)

log = structlog.get_logger()


@dataclass(frozen=True)
class IssuedSession:
    access_token: str
    refresh_token: str
    user: User


def normalize_email(email: str) -> str:
    return email.strip().lower()


async def register_user(session: AsyncSession, data: RegisterRequest) -> User:
    user = User(
        email=normalize_email(data.email),
        name=data.name,
        password_hash=await hash_password(data.password),
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise ApiError(409, "email_taken", "An account with this email already exists") from exc
    return user


async def authenticate(session: AsyncSession, email: str, password: str) -> User:
    user = await session.scalar(select(User).where(User.email == normalize_email(email)))
    matches, new_hash = await verify_password(user.password_hash if user else None, password)
    if user is None or not matches:
        raise ApiError(401, "invalid_credentials", "Invalid email or password")
    if new_hash is not None:
        user.password_hash = new_hash
    return user


async def start_session(
    session: AsyncSession, user: User, settings: Settings, now: datetime
) -> IssuedSession:
    refresh = new_refresh_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            family_id=uuid7(),
            token_hash=hash_refresh_token(refresh),
            expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
        )
    )
    await session.commit()
    return IssuedSession(_access_token(user, settings, now), refresh, user)


async def rotate_session(
    session: AsyncSession, presented: str, settings: Settings, now: datetime
) -> IssuedSession:
    # FOR UPDATE serialises concurrent refreshes of the same token: the second one waits,
    # then sees the row already rotated and takes the grace-window path below.
    token = await session.scalar(
        select(RefreshToken)
        .where(RefreshToken.token_hash == hash_refresh_token(presented))
        .with_for_update()
    )
    if token is None:
        raise ApiError(401, "invalid_refresh_token", "Session not found, please sign in")

    if token.revoked_at is not None:
        if token.replaced_by_id is None:
            # Revoked by logout, not rotation: an ordinary stale cookie.
            raise ApiError(401, "invalid_refresh_token", "Session ended, please sign in")
        if now - token.revoked_at <= timedelta(seconds=settings.refresh_reuse_grace_seconds):
            # Another tab rotated this token a moment ago; the browser already holds the new one.
            raise ApiError(401, "refresh_race", "Session was just refreshed, retry once")
        await _revoke_family(session, token.family_id, now)
        await session.commit()
        log.warning(
            "refresh token reuse detected, session family revoked",
            user_id=str(token.user_id),
            family_id=str(token.family_id),
        )
        raise ApiError(401, "refresh_token_reused", "Session ended for security, please sign in")

    if token.expires_at <= now:
        raise ApiError(401, "refresh_token_expired", "Session expired, please sign in")

    user = await session.get(User, token.user_id)
    if user is None:
        raise ApiError(401, "invalid_refresh_token", "Session not found, please sign in")

    refresh = new_refresh_token()
    successor = RefreshToken(
        id=uuid7(),
        user_id=user.id,
        family_id=token.family_id,
        token_hash=hash_refresh_token(refresh),
        expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
    )
    session.add(successor)
    await session.flush()
    token.revoked_at = now
    token.replaced_by_id = successor.id
    await session.commit()
    return IssuedSession(_access_token(user, settings, now), refresh, user)


async def end_session(session: AsyncSession, presented: str, now: datetime) -> None:
    token = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(presented))
    )
    if token is not None:
        await _revoke_family(session, token.family_id, now)
        await session.commit()


async def end_all_sessions(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> None:
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    await session.commit()


async def _revoke_family(session: AsyncSession, family_id: uuid.UUID, now: datetime) -> None:
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )


def _access_token(user: User, settings: Settings, now: datetime) -> str:
    return create_access_token(
        user.id,
        secret=settings.jwt_secret,
        ttl=timedelta(seconds=settings.access_token_ttl_seconds),
        now=now,
    )
