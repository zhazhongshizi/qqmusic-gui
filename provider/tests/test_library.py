from __future__ import annotations

from collections.abc import Mapping
from types import SimpleNamespace
from typing import cast

import anyio
import pytest

from qqmusic_provider.library import (
    LibraryFailure,
    LibraryFailureCode,
    LibraryService,
    LibrarySource,
    _resolve_song_info,
)


def _song(mid: str = "song-mid-1") -> dict[str, object]:
    return {
        "id": 101,
        "mid": mid,
        "type": 1,
        "name": "纸月光",
        "singer": [{"id": 201, "mid": "artist-mid-1", "name": "林间电台"}],
        "album": {"id": 301, "mid": "album-mid-1", "name": "温室唱片"},
        "interval": 234,
        "file": {"size_128mp3": 1, "size_320mp3": 1, "size_flac": 0},
        "pay": {},
        "status": 0,
    }


class FakeSource(LibrarySource):
    def __init__(self, responses: Mapping[str, Mapping[str, object]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, Mapping[str, object]]] = []
        self.closed = False

    async def execute(self, operation: str, params: Mapping[str, object]) -> Mapping[str, object]:
        self.calls.append((operation, params))
        return self.responses[operation]

    async def close(self) -> None:
        self.closed = True


def _execute(
    operation: str,
    params: Mapping[str, object],
    response: Mapping[str, object],
):
    source = FakeSource({operation: response})

    async def run():
        service = LibraryService(source)
        reply = await service.execute(operation, params)
        await service.close()
        return reply

    return anyio.run(run), source


def test_created_and_favorite_playlists_are_normalized_without_owner_secrets() -> None:
    created, source = _execute(
        "library.playlists",
        {"kind": "created", "page": 1, "pageSize": 20},
        {
            "total": 1,
            "finished": True,
            "playlists": [
                {
                    "id": 991,
                    "dirid": 88,
                    "title": "夜航",
                    "songnum": 12,
                    "uin": "SENTINEL_PRIVATE_UIN",
                }
            ],
        },
    )

    assert source.calls == [("library.playlists", {"kind": "created", "page": 1, "pageSize": 20})]
    assert created.result == {
        "kind": "created",
        "items": [
            {
                "id": "991",
                "title": "夜航",
                "description": "",
                "coverUrl": None,
                "songCount": 12,
                "listenCount": 0,
                "editableId": "88",
            }
        ],
        "page": 1,
        "hasMore": False,
        "total": 1,
    }
    assert "SENTINEL" not in str(created.result)
    assert source.closed is True


def test_created_playlist_pagination_uses_the_full_upstream_count_before_slicing() -> None:
    playlists = [
        {
            "id": 1_000 + index,
            "dirid": 2_000 + index,
            "title": f"歌单 {index}",
            "songnum": index,
        }
        for index in range(51)
    ]
    first_page, _ = _execute(
        "library.playlists",
        {"kind": "created", "page": 1, "pageSize": 50},
        {"playlists": playlists},
    )
    second_page, _ = _execute(
        "library.playlists",
        {"kind": "created", "page": 2, "pageSize": 50},
        {"playlists": playlists},
    )

    assert len(cast("list[dict[str, object]]", first_page.result["items"])) == 50
    assert first_page.result["total"] == 51
    assert first_page.result["hasMore"] is True
    assert len(cast("list[dict[str, object]]", second_page.result["items"])) == 1
    assert second_page.result["total"] == 51
    assert second_page.result["hasMore"] is False


def test_liked_songs_share_catalog_dto_and_preserve_partial_item_warnings() -> None:
    reply, _ = _execute(
        "library.liked",
        {"page": 2, "pageSize": 10},
        {
            "songs": [_song(), {"mid": "broken"}],
            "total": 21,
            "hasmore": 1,
        },
    )

    songs = cast("list[dict[str, object]]", reply.result["items"])
    assert songs[0]["id"] == "song-mid-1"
    assert reply.result["page"] == 2
    assert reply.result["hasMore"] is True
    assert reply.warnings == [{"code": "item_invalid", "entity": "song", "index": 1}]


@pytest.mark.parametrize(
    ("operation", "params", "raw", "expected"),
    [
        (
            "playlist.create",
            {"name": "  夜航  "},
            {"succeeded": True, "playlistId": 991, "editableId": 88, "name": "夜航"},
            {
                "status": "applied",
                "playlist": {"id": "991", "editableId": "88", "title": "夜航"},
            },
        ),
        (
            "playlist.addSongs",
            {"playlistId": 88, "songIds": ["song-mid-1", "song-mid-2"]},
            {"succeeded": True, "affectedCount": 2},
            {"status": "applied", "affectedCount": 2},
        ),
        (
            "song.like",
            {"songIds": ["101"]},
            {"succeeded": True, "affectedCount": 1},
            {"status": "applied", "affectedCount": 1},
        ),
        (
            "playlist.unfavorite",
            {"playlistId": 999},
            {"succeeded": True},
            {"status": "applied"},
        ),
    ],
)
def test_allowlisted_writes_have_exact_validated_shapes(
    operation: str,
    params: Mapping[str, object],
    raw: Mapping[str, object],
    expected: Mapping[str, object],
) -> None:
    reply, source = _execute(operation, params, raw)
    assert reply.result == expected
    assert source.calls[0][0] == operation


@pytest.mark.parametrize(
    ("operation", "params"),
    [
        ("playlist.create", {"name": "\n"}),
        ("playlist.delete", {"playlistId": "88"}),
        ("playlist.addSongs", {"playlistId": 88, "songIds": []}),
        ("playlist.addSongs", {"playlistId": 88, "songIds": ["101", "song-mid"]}),
        ("song.like", {"songIds": ["same", "same"]}),
        ("playlist.favorite", {"playlistId": 1, "extra": True}),
    ],
)
def test_invalid_write_intents_never_reach_source(
    operation: str, params: Mapping[str, object]
) -> None:
    source = FakeSource({operation: {}})

    async def run() -> None:
        with pytest.raises(LibraryFailure) as captured:
            await LibraryService(source).execute(operation, params)
        assert captured.value.code == LibraryFailureCode.INVALID_PARAMS.value

    anyio.run(run)
    assert source.calls == []


def test_upstream_write_rejection_is_stable_and_not_reported_as_applied() -> None:
    source = FakeSource({"playlist.delete": {"succeeded": False}})

    async def run() -> None:
        with pytest.raises(LibraryFailure) as captured:
            await LibraryService(source).execute("playlist.delete", {"playlistId": 88})
        assert captured.value.code == LibraryFailureCode.WRITE_REJECTED.value

    anyio.run(run)


def test_song_mid_resolution_requires_a_complete_numeric_result() -> None:
    class Query:
        async def query_song(self, values: list[str]):
            assert values == ["mid-a", "mid-b"]
            return SimpleNamespace(
                tracks=[
                    SimpleNamespace(id=101, mid="mid-a", type=1),
                    SimpleNamespace(id=102, mid="mid-b", type=2),
                ]
            )

    resolved = anyio.run(_resolve_song_info, SimpleNamespace(song=Query()), ["mid-a", "mid-b"])
    assert resolved == [(101, 1), (102, 2)]


def test_song_resolution_rejects_wrong_upstream_identity() -> None:
    class Query:
        async def query_song(self, _values: list[str]):
            return SimpleNamespace(tracks=[SimpleNamespace(id=999, mid="wrong-mid", type=1)])

    async def run() -> None:
        with pytest.raises(LibraryFailure, match="upstream_schema_changed"):
            await _resolve_song_info(SimpleNamespace(song=Query()), ["requested-mid"])

    anyio.run(run)
