"""The account emails. Plain text, and links carry their token after `#`, which browsers never
send to a server: it stays out of access logs and Referer headers (ADR 0018)."""

from app.auth.models import User
from app.core.config import Settings
from app.core.mail import Email


def verification_email(user: User, token: str, settings: Settings) -> Email:
    link = f"{settings.frontend_url}/verify-email#token={token}"
    return Email(
        to=user.email,
        subject="Confirm your email for CollabEdit",
        text=(
            f"Hi {user.name},\n\n"
            "Confirm that this address is yours, so CollabEdit can send you comment\n"
            "notifications and password resets:\n\n"
            f"{link}\n\n"
            f"The link works for {settings.email_verification_ttl_hours} hours. If you did not\n"
            "create a CollabEdit account, ignore this email.\n"
        ),
    )


def password_reset_email(user: User, token: str, settings: Settings) -> Email:
    link = f"{settings.frontend_url}/reset-password#token={token}"
    return Email(
        to=user.email,
        subject="Reset your CollabEdit password",
        text=(
            f"Hi {user.name},\n\n"
            "Someone, hopefully you, asked to reset the password for your CollabEdit\n"
            "account. Choose a new one here:\n\n"
            f"{link}\n\n"
            f"The link works once, for {settings.password_reset_ttl_minutes} minutes. Setting a\n"
            "new password signs you out everywhere else. If you did not ask for this, ignore\n"
            "this email: your password stays as it is.\n"
        ),
    )
