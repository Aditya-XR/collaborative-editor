import smtplib
from email.message import EmailMessage
from typing import Any, ClassVar

import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.core.mail import Email, LogMailer, SmtpMailer, create_mailer, one_line


class FakeSmtp:
    sessions: ClassVar[list["FakeSmtp"]] = []

    def __init__(self, host: str, port: int, **kwargs: Any) -> None:
        self.address = (host, port)
        self.tls = "context" in kwargs  # SMTP_SSL gets a context; plain SMTP upgrades later
        self.login_as: tuple[str, str] | None = None
        self.sent: list[EmailMessage] = []
        FakeSmtp.sessions.append(self)

    def __enter__(self) -> "FakeSmtp":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def starttls(self, context: object) -> None:
        self.tls = True

    def login(self, username: str, password: str) -> None:
        self.login_as = (username, password)

    def send_message(self, message: EmailMessage) -> None:
        assert self.tls, "never send credentials or mail before TLS"
        self.sent.append(message)


@pytest.fixture(autouse=True)
def fake_smtp(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeSmtp.sessions = []
    monkeypatch.setattr(smtplib, "SMTP", FakeSmtp)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSmtp)


def test_without_an_smtp_host_emails_are_only_logged() -> None:
    assert isinstance(create_mailer(Settings(smtp_host="")), LogMailer)


@pytest.mark.parametrize("port", [465, 587])
async def test_smtp_sends_over_tls_with_the_configured_account(port: int) -> None:
    mailer = create_mailer(
        Settings(
            smtp_host="smtp.example.com",
            smtp_port=port,
            smtp_username="bot@example.com",
            smtp_password=SecretStr("app-password"),
        )
    )
    assert isinstance(mailer, SmtpMailer)

    await mailer.send(Email(to="ada@example.com", subject="Hello", text="Body"))

    [session] = FakeSmtp.sessions
    assert session.address == ("smtp.example.com", port)
    assert session.login_as == ("bot@example.com", "app-password")
    [message] = session.sent
    assert (message["From"], message["To"], message["Subject"]) == (
        "bot@example.com",
        "ada@example.com",
        "Hello",
    )
    assert message.get_content().strip() == "Body"


def test_header_text_is_one_bounded_line() -> None:
    assert one_line("Line one\r\nBcc: someone@example.com") == "Line one Bcc: someone@example.com"
    assert one_line("x" * 200, 10) == "xxxxxxxxx…"
