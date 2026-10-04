"""Explicit read-only live smoke; never runs as part of normal automation."""

from __future__ import annotations

import json
from pathlib import Path

import anyio

from qqmusic_provider.catalog import CatalogService, QQMusicCatalogSource


async def _main() -> None:
    source = QQMusicCatalogSource(device_path=(Path(__file__).parent / ".device.json").resolve())
    await source._session.initialize()
    service = CatalogService(source)
    try:
        reply = await service.execute("search.songs", {"keyword": "晴天", "page": 1, "pageSize": 3})
        discover = await service.execute("recommend.newSongs", {"area": 5})
    finally:
        await service.close()

    items = reply.result.get("items")
    safe_items: list[dict[str, object]] = []
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict):
                safe_items.append({"id": item.get("id"), "title": item.get("title")})
    print(
        json.dumps(
            {
                "method": "search.songs",
                "count": len(safe_items),
                "items": safe_items,
                "warningCodes": [warning.get("code") for warning in reply.warnings],
                "discoverCount": len(discover.result.get("items", []))
                if isinstance(discover.result.get("items"), list)
                else -1,
                "discoverWarningCodes": [
                    warning.get("code") for warning in discover.warnings
                ],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    anyio.run(_main)
