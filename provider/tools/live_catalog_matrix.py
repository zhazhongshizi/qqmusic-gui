"""Explicit live read-only catalog matrix with redacted status-only output."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path

import anyio

from qqmusic_provider.catalog import (
    CatalogFailure,
    CatalogReply,
    CatalogService,
    QQMusicCatalogSource,
)


def _first_item(reply: CatalogReply) -> Mapping[str, object] | None:
    items = reply.result.get("items")
    if isinstance(items, list) and items and isinstance(items[0], Mapping):
        return items[0]
    return None


async def _main() -> None:
    source = QQMusicCatalogSource(device_path=(Path(__file__).parent / ".device.json").resolve())
    await source._session.initialize()
    service = CatalogService(source)
    results: list[dict[str, object]] = []

    async def call(method: str, params: Mapping[str, object]) -> CatalogReply | None:
        try:
            reply = await service.execute(method, params)
            item_count = (
                len(reply.result.get("items", []))
                if isinstance(reply.result.get("items"), list)
                else None
            )
            results.append(
                {
                    "method": method,
                    "ok": True,
                    "itemCount": item_count,
                    "warningCount": len(reply.warnings),
                    "warnings": reply.warnings,
                }
            )
            return reply
        except CatalogFailure as error:
            results.append({"method": method, "ok": False, "code": error.code})
        except Exception as error:  # status-only containment for a manual smoke
            results.append({"method": method, "ok": False, "code": type(error).__name__})
        return None

    try:
        await call("search.hotkeys", {})
        await call("search.complete", {"keyword": "周"})
        song_search = await call("search.songs", {"keyword": "晴天", "pageSize": 3})
        artist_search = await call("search.artists", {"keyword": "周杰伦", "pageSize": 3})
        album_search = await call("search.albums", {"keyword": "叶惠美", "pageSize": 3})
        playlist_search = await call("search.playlists", {"keyword": "华语", "pageSize": 3})
        await call("recommend.guess", {})
        await call("recommend.radar", {"page": 1})
        await call("recommend.playlists", {"page": 1, "pageSize": 3})
        await call("recommend.newSongs", {"area": 5})
        charts = await call("charts.list", {})

        song = _first_item(song_search) if song_search else None
        artist = _first_item(artist_search) if artist_search else None
        album = _first_item(album_search) if album_search else None
        playlist = _first_item(playlist_search) if playlist_search else None
        if song and isinstance(song.get("id"), str):
            await call("song.detail", {"id": song["id"]})
            await call("lyrics.get", {"id": song["id"]})
        if artist and isinstance(artist.get("id"), str):
            await call("artist.detail", {"id": artist["id"]})
            await call("artist.songs", {"id": artist["id"], "pageSize": 3})
            await call("artist.albums", {"id": artist["id"], "pageSize": 3})
        if album and isinstance(album.get("id"), str):
            await call("album.detail", {"id": album["id"]})
            await call("album.songs", {"id": album["id"], "pageSize": 3})
        if playlist and isinstance(playlist.get("id"), str) and playlist["id"].isdecimal():
            await call("playlist.detail", {"id": int(playlist["id"]), "pageSize": 3})
        if charts:
            groups = charts.result.get("groups")
            if isinstance(groups, list) and groups and isinstance(groups[0], Mapping):
                chart_items = groups[0].get("charts")
                if (
                    isinstance(chart_items, list)
                    and chart_items
                    and isinstance(chart_items[0], Mapping)
                ):
                    chart_id = chart_items[0].get("id")
                    if isinstance(chart_id, str) and chart_id.isdecimal():
                        await call("charts.detail", {"id": int(chart_id), "pageSize": 3})
    finally:
        await service.close()

    print(json.dumps(results, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    anyio.run(_main)
