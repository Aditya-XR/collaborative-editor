import asyncio
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

import structlog

from app.core.config import Settings

log = structlog.get_logger()


@dataclass(frozen=True)
class Email:
    to: str
    subject: str
    # Plain text only: nothing a user typed can turn into markup in someone's inbox.
    text: str


class Mailer(Protocol):
    async def send(self, email: Email) -> None: ...


class LogMailer:
    """Used when no SMTP server is configured (development, or before email is set up): the
    app works the same, and the log says what would have been sent."""

    async def send(self, email: Email) -> None:
        log.info("email not sent: SMTP is not configured", to=email.to, subject=email.subject)


class SmtpMailer:
    """Sends through an SMTP relay (Gmail's, on the free plan): implicit TLS on port 465,
    STARTTLS otherwise. smtplib blocks, so each send runs in a worker thread."""

    def __init__(
        self, host: str, port: int, username: str, password: str, sender: str, timeout: float = 10
    ) -> None:
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._sender = sender
        self._timeout = timeout

    async def send(self, email: Email) -> None:
        await asyncio.to_thread(self._send, email)

    def _send(self, email: Email) -> None:
        message = EmailMessage()
        message["From"] = self._sender
        message["To"] = email.to
        message["Subject"] = email.subject
        message.set_content(email.text)
        context = ssl.create_default_context()
        if self._port == 465:
            with smtplib.SMTP_SSL(
                self._host, self._port, timeout=self._timeout, context=context
            ) as smtp:
                self._deliver(smtp, message)
        else:
            with smtplib.SMTP(self._host, self._port, timeout=self._timeout) as smtp:
                smtp.starttls(context=context)
                self._deliver(smtp, message)

    def _deliver(self, smtp: smtplib.SMTP, message: EmailMessage) -> None:
        if self._username:
            smtp.login(self._username, self._password)
        smtp.send_message(message)


def create_mailer(settings: Settings) -> Mailer:
    if not settings.smtp_host:
        return LogMailer()
    return SmtpMailer(
        settings.smtp_host,
        settings.smtp_port,
        settings.smtp_username,
        settings.smtp_password.get_secret_value(),
        settings.mail_from or settings.smtp_username,
    )


async def send_all(mailer: Mailer, emails: list[Email]) -> None:
    """Delivers notifications after the response has gone out. A failure is logged, never
    raised: the comment is saved either way, and one bad address must not stop the rest."""
    for email in emails:
        try:
            await mailer.send(email)
        except Exception:
            log.exception("sending email failed", subject=email.subject)


def one_line(text: str, limit: int = 120) -> str:
    """Text safe for a header such as Subject: no line breaks, bounded length."""
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"
