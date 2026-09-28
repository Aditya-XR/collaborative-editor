import uuid
from typing import Annotated

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints

# NIST SP 800-63B: length over composition rules. The upper bound stops multi-megabyte
# "passwords" from tying up the Argon2 worker threads.
Password = Annotated[str, Field(min_length=8, max_length=128)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class RegisterRequest(BaseModel):
    email: EmailStr
    name: Name
    password: Password


class LoginRequest(BaseModel):
    email: EmailStr
    password: Annotated[str, Field(min_length=1, max_length=128)]


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    name: str


class SessionOut(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105  (OAuth token type, not a secret)
    expires_in: int
    user: UserOut
