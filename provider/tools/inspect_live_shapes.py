"""Print key/type shapes for selected public read-only responses; never prints values."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path

import anyio

from qqmusic_provider.catalog import QQMusicCatalogSource
from qqmusic_provider.session import QQMusicSession


def _shape(value: object, depth: int = 0) -> object:
    if depth >= 7:
        return type(value).__name__
    if isinstance(value, Mapping):
        return {str(key): _shape(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list):
        return {
            "type": "list",
            "length": len(value),
            "first": _shape(value[0], depth + 1) if value else None,
        }
    return type(value).__name__


async def _main() -> None:
    session = QQMusicSession((Path(__file__).parent / ".device.json").resolve())
    await session.initialize()
    source = QQMusicCatalogSource(session)
    try:
        completion = await source.fetch("search.complete", {"keyword": "周"})
        charts = await source.fetch("charts.list", {})
    finally:
        await source.close()
        await session.close()
    print(
        json.dumps(
            {"search.complete": _shape(completion), "charts.list": _shape(charts)},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    anyio.run(_main)
