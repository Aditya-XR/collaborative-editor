import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

import structlog
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.google import GoogleIdentity, GoogleSignInError
from app.auth.models import AccountToken, OAuthAccount, RefreshToken, TokenPurpose, User
from app.auth.schemas import RegisterRequest
from app.core.config import Settings
from app.core.errors import ApiError
from app.core.ids import uuid7
from app.core.security import (
    create_access_token,
    hash_password,
    hash_refresh_token,
    hash_token,
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


# ----- emailed links (ADR 0018) -------------------------------------------------------------


async def issue_token(
    session: AsyncSession, user: User, purpose: TokenPurpose, ttl: timedelta, now: datetime
) -> str:
    """A fresh single-use secret for a link in an email. Issuing one retires any older unused
    token for the same purpose, so only the latest email's link works."""
    await session.execute(
        update(AccountToken)
        .where(
            AccountToken.user_id == user.id,
            AccountToken.purpose == purpose,
            AccountToken.used_at.is_(None),
        )
        .values(used_at=now)
    )
    raw = secrets.token_urlsafe(32)
    session.add(
        AccountToken(
            user_id=user.id, purpose=purpose, token_hash=hash_token(raw), expires_at=now + ttl
        )
    )
    await session.commit()
    return raw


async def _find_token(
    session: AsyncSession, raw: str, purpose: TokenPurpose
) -> tuple[AccountToken, User] | None:
    token = await session.scalar(
        select(AccountToken)
        .where(AccountToken.token_hash == hash_token(raw), AccountToken.purpose == purpose)
        .with_for_update()  # two clicks at once: the second waits, then sees it used
    )
    if token is None:
        return None
    user = await session.get(User, token.user_id)
    return (token, user) if user is not None else None


def _invalid_link() -> ApiError:
    return ApiError(400, "invalid_token", "This link is not valid, or it was already used.")


def _expired_link() -> ApiError:
    return ApiError(400, "token_expired", "This link has expired. Ask for a new one.")


async def request_password_reset(
    session: AsyncSession, email: str, settings: Settings, now: datetime
) -> tuple[User, str] | None:
    """A reset token for the account using this address, or None if there is none. The caller
    answers the same either way, so the endpoint does not reveal who has an account."""
    user = await session.scalar(select(User).where(User.email == normalize_email(email)))
    if user is None:
        return None
    ttl = timedelta(minutes=settings.password_reset_ttl_minutes)
    return user, await issue_token(session, user, TokenPurpose.PASSWORD_RESET, ttl, now)


async def reset_password(session: AsyncSession, raw: str, password: str, now: datetime) -> User:
    found = await _find_token(session, raw, TokenPurpose.PASSWORD_RESET)
    if found is None or found[0].used_at is not None:
        raise _invalid_link()
    token, user = found
    if token.expires_at <= now:
        raise _expired_link()
    token.used_at = now
    user.password_hash = await hash_password(password)
    # The link reached them, so the address is theirs.
    user.email_verified_at = user.email_verified_at or now
    # Whoever knew the old password is signed out everywhere.
    await _revoke_all(session, user.id, now)
    await session.commit()
    return user


async def verify_email(session: AsyncSession, raw: str, now: datetime) -> User:
    found = await _find_token(session, raw, TokenPurpose.VERIFY_EMAIL)
    if found is None:
        raise _invalid_link()
    token, user = found
    if user.email_verified:
        return user  # the link clicked twice, or the address verified another way meanwhile
    if token.used_at is not None:
        raise _invalid_link()  # replaced by a newer email's link
    if token.expires_at <= now:
        raise _expired_link()
    token.used_at = now
    user.email_verified_at = now
    await session.commit()
    return user


# ----- Google ---------------------------------------------------------------------------------

GOOGLE = "google"


async def sign_in_with_google(
    session: AsyncSession, identity: GoogleIdentity, now: datetime
) -> User:
    """The user a Google identity signs in as: the one it is linked to, else the account with
    its (Google-verified) address, which gets linked, else a new account."""
    try:
        return await _google_user(session, identity, now)
    except IntegrityError:
        # The same person's first sign-in, twice at once: the other request created the account.
        await session.rollback()
        return await _google_user(session, identity, now)


async def _google_user(session: AsyncSession, identity: GoogleIdentity, now: datetime) -> User:
    linked = await session.scalar(
        select(User)
        .join(OAuthAccount, OAuthAccount.user_id == User.id)
        .where(OAuthAccount.provider == GOOGLE, OAuthAccount.subject == identity.subject)
    )
    if linked is not None:
        return linked
    if not identity.email_verified:
        # Matching or creating accounts by an address nobody proved would let anyone claim it.
        raise GoogleSignInError("google_email_unverified", "Google has not verified this address")

    email = normalize_email(identity.email)
    user = await session.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(
            email=email,
            name=identity.name,
            password_hash=None,
            email_verified_at=now,
            avatar_url=identity.picture,
        )
        session.add(user)
        await session.flush()
    else:
        if not user.email_verified:
            # Someone registered this address with a password and never proved it was theirs;
            # Google just proved it is this person's. That password may have been chosen by
            # someone else, waiting for the real owner to move in (account pre-hijacking): it
            # goes, and so do the sessions it opened.
            user.password_hash = None
            await _revoke_all(session, user.id, now)
            user.email_verified_at = now
            log.warning("unverified password removed when linking google", user_id=str(user.id))
        user.avatar_url = user.avatar_url or identity.picture
    session.add(
        OAuthAccount(user_id=user.id, provider=GOOGLE, subject=identity.subject, email=email)
    )
    await session.commit()
    return user


async def _revoke_all(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> None:
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )


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
