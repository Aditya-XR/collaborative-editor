from httpx import ASGITransport, AsyncClient

from app.core.config import Settings
from app.main import create_app


async def test_lifespan_wires_real_checks_that_fail_without_services() -> None:
    # Nothing listens on port 1, so both real checks must fail rather than hang.
    settings = Settings(
        env="test",
        database_url="postgresql+asyncpg://nobody:nothing@127.0.0.1:1/none",
        redis_url="redis://127.0.0.1:1/0",
        readiness_timeout=0.5,
    )
    app = create_app(settings)

    async with app.router.lifespan_context(app):
        assert set(app.state.readiness_checks) == {"database", "redis"}
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/readyz")

    assert response.status_code == 503
    checks = response.json()["checks"]
    assert checks["database"]["status"] == "error"
    assert checks["redis"]["status"] == "error"
    assert "nothing" not in response.text
