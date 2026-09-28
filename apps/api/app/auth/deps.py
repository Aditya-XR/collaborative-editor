from typing import Annotated

from fastapi import Depends, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.models import User
from app.core.deps import AppSettings, DbSession
from app.core.errors import ApiError
from app.core.ratelimit.deps import enforce
from app.core.ratelimit.policies import API_PER_USER
from app.core.security import InvalidTokenError, TokenExpiredError, decode_access_token

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: DbSession,
    settings: AppSettings,
) -> User:
    if credentials is None:
        raise ApiError(401, "not_authenticated", "Sign in required", {"WWW-Authenticate": "Bearer"})
    try:
        user_id = decode_access_token(credentials.credentials, secret=settings.jwt_secret)
    except TokenExpiredError as exc:
        # The client refreshes on this code and retries once.
        raise ApiError(
            401, "token_expired", "Access token expired", {"WWW-Authenticate": "Bearer"}
        ) from exc
    except InvalidTokenError as exc:
        raise ApiError(
            401, "invalid_token", "Invalid access token", {"WWW-Authenticate": "Bearer"}
        ) from exc

    user = await session.get(User, user_id)
    if user is None:
        raise ApiError(401, "invalid_token", "Invalid access token", {"WWW-Authenticate": "Bearer"})
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def limit_api_per_user(request: Request, response: Response, user: CurrentUser) -> None:
    await enforce(request, response, API_PER_USER, str(user.id))
