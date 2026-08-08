"""Entry point: `python -m nidora_agent`, started by the pod entrypoint."""

from __future__ import annotations

import asyncio
import logging
import signal

from .client import Agent
from .config import AGENT_VERSION, load_config


async def _main() -> None:
    config = load_config()
    logging.basicConfig(
        level=config.log_level.upper(),
        format="[agent] %(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("nidora_agent")
    log.info(
        "starting v%s pod=%s gateway=%s pipelines=%s sglang=%s",
        AGENT_VERSION,
        config.pod_id,
        config.gateway_url,
        ",".join(config.pipelines),
        config.sglang_url,
    )

    agent = Agent(config)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, agent.stop)

    await agent.run()
    log.info("agent stopped")


def run() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    run()
