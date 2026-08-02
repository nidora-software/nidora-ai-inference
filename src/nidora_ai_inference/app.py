"""FastAPI application factory."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import __version__
from .api.routes import router
from .core.config import Settings, load_pipeline_profiles
from .core.jobs import JobStore
from .core.worker import GpuWorker

log = logging.getLogger("nidora")


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
    return app
