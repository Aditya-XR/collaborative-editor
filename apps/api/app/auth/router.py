import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated

import structlog
from fastapi import APIRouter, BackgroundTasks, Cookie, Depends, Request, Response
from fastapi.responses import RedirectResponse

from app.auth import service
from app.auth.deps import CurrentUser, limit_api_per_user
from app.auth.emails import password_reset_email, verification_email
from app.auth.google import Attempt, GoogleClient, GoogleSignInError, new_attempt
from app.auth.models import TokenPurpose, User
from app.auth.schemas import (
    Accepted,
    AuthOptions,
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
    SessionOut,
    UserOut,
    VerifyEmailRequest,
)
from app.auth.service import IssuedSession
from app.core.config import Settings
from app.core.deps import AppSettings, DbSession
from app.core.errors import ApiError
from app.core.mail import Mailer, send_all
from app.core.ratelimit.deps import enforce, limit_by_ip
from app.core.ratelimit.policies import (
    GOOGLE_PER_IP,
    LOGIN_PER_EMAIL,
    LOGIN_PER_IP,
    PASSWORD_FORGOT_PER_EMAIL,
    PASSWORD_FORGOT_PER_IP,
    PASSWORD_RESET_PER_IP,
    REFRESH_PER_IP,
    REGISTER_PER_IP,
    VERIFY_RESEND_PER_USER,
)

log = structlog.get_logger()

router = APIRouter(prefix="/auth", tags=["auth"])
me_router = APIRouter(tags=["users"])

REFRESH_COOKIE = "refresh_token"
# The cookie is only ever sent to the auth endpoints, never to the rest of the API.
REFRESH_COOKIE_PATH = "/api/auth"

# Binds a Google sign-in to the browser that started it (login CSRF): only that browser can
# finish it. Lax, not Strict: it must come along when Google sends the browser back.
GOOGLE_STATE_COOKIE = "google_state"
GOOGLE_COOKIE_PATH = "/api/auth/google"
GOOGLE_ATTEMPT_SECONDS = 600

RefreshCookie = Annotated[str | None, Cookie(alias=REFRESH_COOKIE)]
GoogleStateCookie = Annotated[str | None, Cookie(alias=GOOGLE_STATE_COOKIE)]


def require_trusted_origin(request: Request, settings: AppSettings) -> None:
    """Defence in depth next to SameSite=Lax for the endpoints authenticated by cookie."""
    origin = request.headers.get("origin")
    if origin is not None and origin != settings.frontend_url:
        raise ApiError(403, "untrusted_origin", "Request origin not allowed")


def _mailer(request: Request) -> Mailer:
    mailer: Mailer = request.app.state.mailer
    return mailer


@router.get("/options")
async def options(request: Request) -> AuthOptions:
    return AuthOptions(google=request.app.state.google is not None)


@router.post(
    "/register",
    status_code=201,
    dependencies=[Depends(limit_by_ip(REGISTER_PER_IP))],
)
async def register(
    body: RegisterRequest,
    request: Request,
    response: Response,
    background: BackgroundTasks,
    session: DbSession,
    settings: AppSettings,
) -> SessionOut:
    user = await service.register_user(session, body)
    issued = await service.start_session(session, user, settings, _now())
    await _send_verification(request, background, session, user, settings)
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


# ----- password reset -----------------------------------------------------------------------


@router.post(
    "/password/forgot",
    status_code=202,
    dependencies=[Depends(limit_by_ip(PASSWORD_FORGOT_PER_IP))],
)
async def forgot_password(
    body: ForgotPasswordRequest,
    request: Request,
    response: Response,
    background: BackgroundTasks,
    session: DbSession,
    settings: AppSettings,
) -> Accepted:
    """Emails a reset link if an account uses the address. The answer is the same either way,
    so nobody can find out from it who has an account."""
    await enforce(request, response, PASSWORD_FORGOT_PER_EMAIL, service.normalize_email(body.email))
    found = await service.request_password_reset(session, body.email, settings, _now())
    if found is not None:
        user, token = found
        background.add_task(
            send_all, _mailer(request), [password_reset_email(user, token, settings)]
        )
    return Accepted(
        detail="If an account uses that address, a link to reset its password is on its way."
    )


@router.post(
    "/password/reset",
    status_code=204,
    dependencies=[Depends(limit_by_ip(PASSWORD_RESET_PER_IP))],
)
async def reset_password(body: ResetPasswordRequest, session: DbSession) -> None:
    """Sets a new password and signs out every session; the person then signs in with it."""
    await service.reset_password(session, body.token, body.password, _now())


# ----- email verification -------------------------------------------------------------------


@router.post("/email/verify")
async def verify_email(body: VerifyEmailRequest, session: DbSession) -> UserOut:
    """No sign-in needed: the link may well open in another browser than the account's."""
    return UserOut.model_validate(await service.verify_email(session, body.token, _now()))


@router.post("/email/resend", status_code=202, dependencies=[Depends(limit_api_per_user)])
async def resend_verification(
    user: CurrentUser,
    request: Request,
    response: Response,
    background: BackgroundTasks,
    session: DbSession,
    settings: AppSettings,
) -> Accepted:
    if user.email_verified:
        raise ApiError(409, "already_verified", "This address is already verified")
    await enforce(request, response, VERIFY_RESEND_PER_USER, str(user.id))
    await _send_verification(request, background, session, user, settings)
    return Accepted(detail=f"A new link is on its way to {user.email}.")


async def _send_verification(
    request: Request,
    background: BackgroundTasks,
    session: DbSession,
    user: User,
    settings: Settings,
) -> None:
    ttl = timedelta(hours=settings.email_verification_ttl_hours)
    token = await service.issue_token(session, user, TokenPurpose.VERIFY_EMAIL, ttl, _now())
    background.add_task(send_all, _mailer(request), [verification_email(user, token, settings)])


# ----- Google ---------------------------------------------------------------------------------


def _google(request: Request) -> GoogleClient:
    google: GoogleClient | None = request.app.state.google
    if google is None:
        raise ApiError(404, "google_disabled", "Google sign-in is not set up here")
    return google


def _safe_next(next_path: str) -> str:
    """Only a path on this site: never `//evil.example` or `https://…` (an open redirect)."""
    if not next_path.startswith("/") or next_path.startswith(("//", "/\\")) or len(next_path) > 512:
        return "/"
    return next_path


@router.get("/google/start", dependencies=[Depends(limit_by_ip(GOOGLE_PER_IP))])
async def google_start(
    request: Request, settings: AppSettings, next: str = "/"
) -> RedirectResponse:
    google = _google(request)
    state, attempt = new_attempt(_safe_next(next))
    await request.app.state.redis.set(f"google:{state}", attempt.dumps(), ex=GOOGLE_ATTEMPT_SECONDS)
    redirect = RedirectResponse(google.authorization_url(state, attempt), status_code=302)
    redirect.set_cookie(
        GOOGLE_STATE_COOKIE,
        state,
        max_age=GOOGLE_ATTEMPT_SECONDS,
        path=GOOGLE_COOKIE_PATH,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )
    return redirect


@router.get("/google/callback")
async def google_callback(
    request: Request,
    session: DbSession,
    settings: AppSettings,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    state_cookie: GoogleStateCookie = None,
) -> RedirectResponse:
    """Where Google sends the browser back. Every outcome is a redirect to the web app: home
    (or the page the person was going to) signed in, or the sign-in page with ?error=…"""
    try:
        if error is not None:
            # access_denied: they pressed Cancel on Google's screen.
            raise GoogleSignInError(
                "google_cancelled" if error == "access_denied" else "google_failed", error
            )
        if (
            not code
            or not state
            or not state_cookie
            or not secrets.compare_digest(state, state_cookie)
        ):
            raise GoogleSignInError("google_failed", "state does not match this browser")
        # GETDEL: each attempt is good for one callback, so a captured callback URL is useless.
        remembered = await request.app.state.redis.getdel(f"google:{state}")
        if remembered is None:
            raise GoogleSignInError("google_failed", "sign-in attempt expired or already used")
        attempt = Attempt.loads(remembered)
        identity = await _google(request).identify(code, attempt)
        user = await service.sign_in_with_google(session, identity, _now())
    except (GoogleSignInError, ApiError) as exc:
        reason = exc.code if isinstance(exc, GoogleSignInError) else "google_failed"
        log.info("google sign-in failed", reason=reason, detail=str(exc))
        return _google_redirect(settings, f"/login?error={reason}")

    issued = await service.start_session(session, user, settings, _now())
    redirect = _google_redirect(settings, attempt.next_path)
    _set_refresh_cookie(redirect, issued.refresh_token, settings)
    return redirect


def _google_redirect(settings: Settings, path: str) -> RedirectResponse:
    redirect = RedirectResponse(f"{settings.frontend_url}{path}", status_code=302)
    redirect.delete_cookie(
        GOOGLE_STATE_COOKIE,
        path=GOOGLE_COOKIE_PATH,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )
    redirect.headers["Cache-Control"] = "no-store"
    return redirect


# ----- the signed-in user -------------------------------------------------------------------


@me_router.get("/me", dependencies=[Depends(limit_api_per_user)])
async def me(user: CurrentUser) -> UserOut:
    return UserOut.model_validate(user)


def _respond(issued: IssuedSession, response: Response, settings: Settings) -> SessionOut:
    _set_refresh_cookie(response, issued.refresh_token, settings)
    response.headers["Cache-Control"] = "no-store"
    return SessionOut(
        access_token=issued.access_token,
        expires_in=settings.access_token_ttl_seconds,
        user=UserOut.model_validate(issued.user),
    )


def _set_refresh_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=settings.refresh_token_ttl_days * 24 * 3600,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
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
