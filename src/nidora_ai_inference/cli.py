"""Command-line entry point: `serve` and `download`."""

from __future__ import annotations

import argparse
import logging
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nidora-ai-inference")
    sub = parser.add_subparsers(dest="command", required=True)

    serve_p = sub.add_parser("serve", help="run the inference API server")
    serve_p.add_argument("--host", default=None)
    serve_p.add_argument("--port", type=int, default=None)
    serve_p.add_argument("--reload", action="store_true", help="dev auto-reload")

    dl_p = sub.add_parser("download", help="download models/LoRAs from the manifest")
    dl_p.add_argument("names", nargs="*", help="manifest entries to download")
    dl_p.add_argument(
        "--all",
        action="store_true",
        help="download everything referenced by enabled pipeline profiles",
    )

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    if args.command == "serve":
        return _serve(args)
    if args.command == "download":
        return _download(args)
    return 1


def _serve(args: argparse.Namespace) -> int:
    import os

    import uvicorn

    from .core.config import Settings

    # \r-based progress bars (tqdm, HF downloads) garble non-tty logs (pods,
    # `docker logs`) — real progress is emitted as log lines instead.
    if not sys.stderr.isatty():
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        os.environ.setdefault("TQDM_DISABLE", "1")

    settings = Settings()
    host = args.host or settings.host
    port = args.port or settings.port

    if args.reload:
        uvicorn.run(
            "nidora_ai_inference.app:create_app",
            factory=True,
            host=host,
            port=port,
            reload=True,
        )
    else:
        from .app import create_app

        uvicorn.run(create_app(settings), host=host, port=port)
    return 0


def _download(args: argparse.Namespace) -> int:
    from .core.config import Settings, load_model_manifest, load_pipeline_profiles
    from .models.manifest import download_models, models_for_profiles

    settings = Settings()
    manifest = load_model_manifest(settings.models_config)

    if args.all:
        profiles = load_pipeline_profiles(settings.pipelines_config)
        names = models_for_profiles(profiles)
    elif args.names:
        names = args.names
    else:
        print("nothing to do — pass model names or --all", file=sys.stderr)
        return 2

    unknown = [n for n in names if n not in manifest]
    if unknown:
        print(f"unknown manifest entries: {', '.join(unknown)}", file=sys.stderr)
        return 2

    download_models(settings, manifest, names)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
