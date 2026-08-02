"""FastAPI application factory."""

from __future__ import annotations

import logging
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__
from .api.routes import router
from .core.config import Settings, load_pipeline_profiles
from .core.jobs import JobStore
from .core.worker import GpuWorker

log = logging.getLogger("nidora")


def _request_key(request: Request) -> str:
    key = request.headers.get("x-api-key")
    if key:
        return key
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:]
    return ""


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        profiles = load_pipeline_profiles(settings.pipelines_config)
        settings.outputs_dir.mkdir(parents=True, exist_ok=True)

        if settings.auto_download:
            from .models.manifest import download_for_profiles

            download_for_profiles(settings, profiles)

        store = JobStore(settings.db_path)
        worker = GpuWorker(store=store, settings=settings, profiles=profiles)

        app.state.settings = settings
        app.state.profiles = profiles
        app.state.store = store
        app.state.worker = worker

        worker.start()
        if settings.warmup:
            if settings.warmup in profiles:
                log.info("warming up pipeline at startup: %s", settings.warmup)
                worker.warmup(settings.warmup)
            else:
                log.warning("NIDORA_WARMUP=%r is not a known pipeline — skipped", settings.warmup)
        log.info(
            "nidora-ai-inference %s ready — device=%s, pipelines=%s",
            __version__,
            settings.resolve_device(),
            ", ".join(profiles) or "(none)",
        )
        yield
        worker.stop()
        store.close()

    app = FastAPI(title="nidora-ai-inference", version=__version__, lifespan=lifespan)
    app.include_router(router)

    if settings.api_key:

        @app.middleware("http")
        async def require_api_key(request: Request, call_next):
            if request.url.path.startswith("/v1/") and not secrets.compare_digest(
                _request_key(request), settings.api_key
            ):
                return JSONResponse({"detail": "invalid or missing API key"}, status_code=401)
            return await call_next(request)

    else:
        log.warning("NIDORA_API_KEY not set — the API is unauthenticated")

    return app
