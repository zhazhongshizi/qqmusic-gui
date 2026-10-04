"""Explicit anonymous lyric smoke; prints metadata only, never lyric text or track identifiers."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path

import anyio

from qqmusic_provider.catalog import CatalogService, QQMusicCatalogSource

_LRC_TIMESTAMP = re.compile(r"\[\d{1,4}:\d{1,2}(?:\.\d{1,3})?\]")
_QRC_LINE_TIMESTAMP = re.compile(r"\[\d{1,10},\d{1,10}\]")
_QRC_WORD_TIMESTAMP = re.compile(r"\(\d{1,10},\d{1,10}\)")


async def _main() -> None:
    source = QQMusicCatalogSource(device_path=(Path(__file__).parent / ".device.json").resolve())
    await source._session.initialize()
    service = CatalogService(source)
    try:
        search = await service.execute(
            "search.songs", {"keyword": "晴天", "page": 1, "pageSize": 1}
        )
        items = search.result.get("items")
        if not isinstance(items, list) or not items or not isinstance(items[0], Mapping):
            raise RuntimeError("no_live_song")
        track_id = items[0].get("id")
        if not isinstance(track_id, str):
            raise RuntimeError("invalid_live_song")
        lyrics = await service.execute("lyrics.get", {"id": track_id})
    finally:
        await service.close()

    original = lyrics.result.get("lyric")
    translation = lyrics.result.get("translation")
    romanization = lyrics.result.get("romanization")
    if not isinstance(original, str):
        raise RuntimeError("invalid_live_lyrics")
    print(
        json.dumps(
            {
                "method": "lyrics.get",
                "hasLrcTimestamp": bool(_LRC_TIMESTAMP.search(original)),
                "hasQrcLineTimestamp": bool(_QRC_LINE_TIMESTAMP.search(original)),
                "hasQrcWordTimestamp": bool(_QRC_WORD_TIMESTAMP.search(original)),
                "hasQrcXmlEnvelope": original.lstrip().startswith("<?xml")
                or "<Lyric_" in original[:512],
                "originalBytes": len(original.encode("utf-8")),
                "hasTranslation": isinstance(translation, str) and bool(translation),
                "hasRomanization": isinstance(romanization, str) and bool(romanization),
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    anyio.run(_main)
