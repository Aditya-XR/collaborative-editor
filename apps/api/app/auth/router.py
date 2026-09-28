from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Request, Response

from app.auth import service
from app.auth.deps import CurrentUser, limit_api_per_user
from app.auth.schemas import LoginRequest, RegisterRequest, SessionOut, UserOut
from app.auth.service import IssuedSession
from app.core.config import Settings
from app.core.deps import AppSettings, DbSession
from app.core.errors import ApiError
from app.core.ratelimit.deps import enforce, limit_by_ip
from app.core.ratelimit.policies import (
    LOGIN_PER_EMAIL,
    LOGIN_PER_IP,
    REFRESH_PER_IP,
    REGISTER_PER_IP,
)

router = APIRouter(prefix="/auth", tags=["auth"])
me_router = APIRouter(tags=["users"])

REFRESH_COOKIE = "refresh_token"
# The cookie is only ever sent to the auth endpoints, never to the rest of the API.
REFRESH_COOKIE_PATH = "/api/auth"

RefreshCookie = Annotated[str | None, Cookie(alias=REFRESH_COOKIE)]


def require_trusted_origin(request: Request, settings: AppSettings) -> None:
    """Defence in depth next to SameSite=Lax for the endpoints authenticated by cookie."""
    origin = request.headers.get("origin")
    if origin is not None and origin != settings.frontend_url:
        raise ApiError(403, "untrusted_origin", "Request origin not allowed")


@router.post(
    "/register",
    status_code=201,
    dependencies=[Depends(limit_by_ip(REGISTER_PER_IP))],
)
async def register(
    body: RegisterRequest, response: Response, session: DbSession, settings: AppSettings
) -> SessionOut:
    user = await service.register_user(session, body)
    issued = await service.start_session(session, user, settings, _now())
    return _respond(issued, response, settings)


@router.post("/login", dependencies=[Depends(limit_by_ip(LOGIN_PER_IP))])
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    session: DbSession,
    settings: AppSettings,
) -> SessionOut:
    # Per-email limit stops one account being guessed from many IPs.
    await enforce(request, response, LOGIN_PER_EMAIL, service.normalize_email(body.email))
    user = await service.authenticate(session, body.email, body.password)
    issued = await service.start_session(session, user, settings, _now())
    return _respond(issued, response, settings)


@router.post(
    "/refresh",
    dependencies=[Depends(require_trusted_origin), Depends(limit_by_ip(REFRESH_PER_IP))],
)
async def refresh(
    response: Response,
    session: DbSession,
    settings: AppSettings,
    refresh_token: RefreshCookie = None,
) -> SessionOut:
    if refresh_token is None:
        raise ApiError(401, "no_session", "Not signed in")
    issued = await service.rotate_session(session, refresh_token, settings, _now())
    return _respond(issued, response, settings)


@router.post("/logout", status_code=204, dependencies=[Depends(require_trusted_origin)])
async def logout(
    response: Response,
    session: DbSession,
    settings: AppSettings,
    refresh_token: RefreshCookie = None,
) -> None:
    if refresh_token is not None:
        await service.end_session(session, refresh_token, _now())
    _clear_refresh_cookie(response, settings)


@router.post("/logout-all", status_code=204)
async def logout_all(
    user: CurrentUser, response: Response, session: DbSession, settings: AppSettings
) -> None:
    await service.end_all_sessions(session, user.id, _now())
    _clear_refresh_cookie(response, settings)


@me_router.get("/me", dependencies=[Depends(limit_api_per_user)])
async def me(user: CurrentUser) -> UserOut:
    return UserOut.model_validate(user)


def _respond(issued: IssuedSession, response: Response, settings: Settings) -> SessionOut:
    response.set_cookie(
        REFRESH_COOKIE,
        issued.refresh_token,
        max_age=settings.refresh_token_ttl_days * 24 * 3600,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )
    response.headers["Cache-Control"] = "no-store"
    return SessionOut(
        access_token=issued.access_token,
        expires_in=settings.access_token_ttl_seconds,
        user=UserOut.model_validate(issued.user),
    )


def _clear_refresh_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        REFRESH_COOKIE,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )


def _now() -> datetime:
    return datetime.now(UTC)
