"""Explicit anonymous GetVkey smoke; never prints the resolved URL or token."""

from __future__ import annotations

import asyncio
from pathlib import Path
from urllib.parse import urlsplit

from qqmusic_provider.catalog import CatalogService, QQMusicCatalogSource
from qqmusic_provider.playback import PlaybackFailure, PlaybackService, QQMusicPlaybackSource
from qqmusic_provider.session import QQMusicSession


async def main() -> None:
    session = QQMusicSession((Path(__file__).parent / ".device.json").resolve())
    await session.initialize()
    catalog = CatalogService(QQMusicCatalogSource(session))
    playback = PlaybackService(QQMusicPlaybackSource(session))
    try:
        search = await catalog.execute(
            "search.songs", {"keyword": "晴天", "page": 1, "pageSize": 1}
        )
        items = search.result.get("items")
        if not isinstance(items, list) or not items or not isinstance(items[0], dict):
            raise RuntimeError("live_search_empty")
        song_mid = items[0].get("id")
        if not isinstance(song_mid, str):
            raise RuntimeError("live_search_invalid")
        try:
            resolution = await playback.execute(
                "playback.resolve", {"id": song_mid, "preferredQuality": "auto"}
            )
        except PlaybackFailure as error:
            print(
                f"live_playback_resolution_result status={error.code} "
                f"retryable={error.retryable}"
            )
            return
        host = urlsplit(str(resolution.result["url"])).hostname
        print(
            "live_playback_resolution_result status=resolved "
            f"quality={resolution.result['quality']} host={host} "
            f"expires={resolution.result['expiresInSeconds']}"
        )
    finally:
        await catalog.close()
        await playback.close()
        await session.close()


if __name__ == "__main__":
    asyncio.run(main())
