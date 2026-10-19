from app.core.ratelimit.limiter import RateLimit

# Credential endpoints fail closed: without Redis we cannot slow password guessing across
# instances, so it is safer to refuse briefly than to let guesses through.
LOGIN_PER_IP = RateLimit("login-ip", capacity=5, period_s=60, fail_open=False)
LOGIN_PER_EMAIL = RateLimit("login-email", capacity=10, period_s=3600, fail_open=False)
REGISTER_PER_IP = RateLimit("register-ip", capacity=3, period_s=3600, fail_open=False)
# These send email, so they fail closed too: without Redis, nothing would stop a mail bomb.
PASSWORD_FORGOT_PER_IP = RateLimit("forgot-ip", capacity=5, period_s=3600, fail_open=False)
PASSWORD_FORGOT_PER_EMAIL = RateLimit("forgot-email", capacity=3, period_s=3600, fail_open=False)
PASSWORD_RESET_PER_IP = RateLimit("reset-ip", capacity=10, period_s=3600, fail_open=False)
VERIFY_RESEND_PER_USER = RateLimit("verify-resend", capacity=3, period_s=3600, fail_open=False)
GOOGLE_PER_IP = RateLimit("google-ip", capacity=20, period_s=600)

REFRESH_PER_IP = RateLimit("refresh-ip", capacity=30, period_s=60)
API_PER_USER = RateLimit("api-user", capacity=120, period_s=60)
COLLAB_TICKET_PER_USER = RateLimit("collab-ticket", capacity=30, period_s=60)
SHARING_PER_USER = RateLimit("sharing", capacity=30, period_s=3600)
BRANCH_CREATE_PER_USER = RateLimit("branch-create", capacity=20, period_s=3600)
COMMENT_WRITE_PER_USER = RateLimit("comment-write", capacity=60, period_s=600)
