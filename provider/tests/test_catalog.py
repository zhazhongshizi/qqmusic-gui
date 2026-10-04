from __future__ import annotations

from collections.abc import Mapping
from typing import cast

import anyio
import pytest

from qqmusic_provider.catalog import (
    CatalogFailure,
    CatalogFailureCode,
    CatalogService,
    CatalogSource,
)


def _song(mid: str = "song-mid-1", title: str = "纸月光") -> dict[str, object]:
    return {
        "id": 101,
        "mid": mid,
        "name": title,
        "subtitle": "夜间版本",
        "singer": [{"id": 201, "mid": "artist-mid-1", "name": "林间电台"}],
        "album": {"id": 301, "mid": "album-mid-1", "name": "温室唱片"},
        "interval": 234,
        "file": {
            "media_mid": "media-mid-1",
            "size_128mp3": 1_000,
            "size_320mp3": 2_000,
            "size_flac": 0,
        },
        "pay": {"pay_play": 1},
        "status": 0,
        "futureField": {"safeToIgnore": True},
    }


def _song_with_artist_count(count: int) -> dict[str, object]:
    song = _song()
    song["singer"] = [
        {"id": 201 + index, "mid": f"artist-{index}", "name": f"Artist {index}"}
        for index in range(count)
    ]
    return song


class FakeSource(CatalogSource):
    def __init__(self, responses: Mapping[str, Mapping[str, object]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, Mapping[str, object]]] = []
        self.closed = False

    async def fetch(self, operation: str, params: Mapping[str, object]) -> Mapping[str, object]:
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
        return await CatalogService(source).execute(operation, params)

    return anyio.run(run), source


def test_song_search_normalizes_quality_pagination_and_ignores_extra_fields() -> None:
    reply, source = _execute(
        "search.songs",
        {"keyword": " 纸月光 ", "page": 2, "pageSize": 10},
        {
            "meta": {"nextpage": 3, "sum": 24, "newUpstreamMeta": True},
            "body": {"item_song": [_song()]},
            "newTopLevelField": "ignored",
        },
    )

    assert source.calls == [("search.songs", {"keyword": "纸月光", "page": 2, "pageSize": 10})]
    assert reply.result["page"] == 2
    assert reply.result["hasMore"] is True
    assert reply.result["total"] == 24
    song = cast("list[dict[str, object]]", reply.result["items"])[0]
    assert song["id"] == "song-mid-1"
    assert song["mediaMid"] == "media-mid-1"
    assert song["durationMs"] == 234_000
    assert song["coverCacheKey"] == "album-mid-1"
    assert "coverUrl" not in song
    assert "coverUrl" not in cast("dict[str, object]", song["album"])
    assert "coverUrl" not in cast("list[dict[str, object]]", song["artists"])[0]
    assert song["qualityCandidates"] == [
        {"quality": "flac", "available": False, "requiresSubscription": True},
        {"quality": "320k", "available": True, "requiresSubscription": True},
        {"quality": "128k", "available": True, "requiresSubscription": True},
    ]
    assert reply.warnings == []


def test_descriptions_keep_paragraphs_strip_markup_and_bound_long_text() -> None:
    biography = "<p>第一段 &amp; 简介</p><p>第二段<br/>第三行</p>\0" + "界" * 5000
    reply, _ = _execute(
        "album.detail", {"id": "album-1"},
        {"basicInfo": {"albumMid": "album-1", "albumName": "专辑", "desc": biography}},
    )
    album = cast("dict[str, object]", reply.result["album"])
    description = cast("str", album["description"])
    assert description.startswith("第一段 & 简介\n第二段\n第三行\n")
    assert len(description) == 4096
    assert "<p>" not in description and "\0" not in description


def test_artist_description_keeps_multiline_text_without_affecting_identity() -> None:
    reply, _ = _execute(
        "artist.detail", {"id": "artist-1"},
        {"singer_list": [{"basic_info": {"mid": "artist-1", "name": "歌手"},
                          "ex_info": {"desc": "简介第一段\r\n第二段"}}]},
    )
    artist = cast("dict[str, object]", reply.result["artist"])
    assert artist["description"] == "简介第一段\n第二段"
    assert artist["id"] == "artist-1"


@pytest.mark.parametrize(
    ("page", "expected_has_more"),
    [(1, True), (2, True), (4, False)],
)
def test_artist_songs_derives_has_more_from_total_num_for_first_middle_and_last_page(
    page: int, expected_has_more: bool
) -> None:
    reply, _ = _execute(
        "artist.songs",
        {"id": "artist-mid-1", "page": page, "pageSize": 30},
        {"songList": [_song()], "totalNum": 95},
    )
    assert reply.result["total"] == 95
    assert reply.result["hasMore"] is expected_has_more


def test_artist_songs_total_num_has_priority_over_legacy_total_keys() -> None:
    reply, _ = _execute(
        "artist.songs",
        {"id": "artist-mid-1", "page": 1, "pageSize": 30},
        {"songList": [_song()], "totalNum": 95, "total": 1, "sum": 2},
    )
    assert reply.result["total"] == 95
    assert reply.result["hasMore"] is True


@pytest.mark.parametrize("total_num", [-1, True, "95"])
def test_artist_songs_invalid_total_num_is_omitted_and_does_not_enable_pagination(
    total_num: object,
) -> None:
    reply, _ = _execute(
        "artist.songs",
        {"id": "artist-mid-1", "page": 1, "pageSize": 30},
        {"songList": [_song()], "totalNum": total_num},
    )
    assert "total" not in reply.result
    assert reply.result["hasMore"] is False


def test_artist_songs_keeps_partial_items_and_uses_total_num_for_next_page() -> None:
    reply, _ = _execute(
        "artist.songs",
        {"id": "artist-mid-1", "page": 1, "pageSize": 30},
        {"songList": [_song("good-1"), {"mid": "broken", "name": 42}], "totalNum": 31},
    )
    assert [item["id"] for item in cast("list[dict[str, object]]", reply.result["items"])] == [
        "good-1"
    ]
    assert reply.result["total"] == 31
    assert reply.result["hasMore"] is True
    assert reply.warnings == [{"code": "item_invalid", "entity": "song", "index": 1}]


def test_song_omits_missing_media_mid_and_rejects_an_invalid_present_value() -> None:
    missing = _song()
    cast("dict[str, object]", missing["file"]).pop("media_mid")
    reply, _ = _execute(
        "search.songs",
        {"keyword": "月光"},
        {"meta": {"nextpage": -1, "sum": 1}, "body": {"item_song": [missing]}},
    )
    assert "mediaMid" not in cast("list[dict[str, object]]", reply.result["items"])[0]

    invalid = _song()
    cast("dict[str, object]", invalid["file"])["media_mid"] = "bad/media-mid"
    reply, _ = _execute(
        "search.songs",
        {"keyword": "月光"},
        {"meta": {"nextpage": -1, "sum": 1}, "body": {"item_song": [invalid]}},
    )
    assert reply.result["items"] == []
    assert len(reply.warnings) == 1


def test_song_omits_missing_album_mid_and_rejects_an_invalid_present_value() -> None:
    missing = _song()
    cast("dict[str, object]", missing["album"]).pop("mid")
    reply, _ = _execute(
        "search.songs",
        {"keyword": "月光"},
        {"meta": {"nextpage": -1, "sum": 1}, "body": {"item_song": [missing]}},
    )
    item = cast("list[dict[str, object]]", reply.result["items"])[0]
    assert "coverCacheKey" not in item

    invalid = _song()
    cast("dict[str, object]", invalid["album"])["mid"] = "bad/album-mid"
    reply, _ = _execute(
        "search.songs",
        {"keyword": "月光"},
        {"meta": {"nextpage": -1, "sum": 1}, "body": {"item_song": [invalid]}},
    )
    assert reply.result["items"] == []
    assert len(reply.warnings) == 1


def test_one_bad_search_item_returns_valid_items_and_stable_warning() -> None:
    reply, _ = _execute(
        "search.songs",
        {"keyword": "月光"},
        {
            "meta": {"nextpage": -1, "sum": 3},
            "body": {
                "item_song": [
                    _song("good-1", "第一首"),
                    {"mid": "broken", "name": 42},
                    _song("good-2", "第二首"),
                ]
            },
        },
    )

    assert [item["id"] for item in cast("list[dict[str, object]]", reply.result["items"])] == [
        "good-1",
        "good-2",
    ]
    assert reply.warnings == [{"code": "item_invalid", "entity": "item_song", "index": 1}]


def test_song_with_nine_artists_is_valid() -> None:
    reply, _ = _execute(
        "search.songs",
        {"keyword": "合作"},
        {"meta": {"nextpage": -1, "sum": 1}, "body": {"item_song": [_song_with_artist_count(9)]}},
    )
    items = cast("list[dict[str, object]]", reply.result["items"])
    assert len(items) == 1
    assert len(cast("list[dict[str, object]]", items[0]["artists"])) == 9
    assert reply.warnings == []


@pytest.mark.parametrize("artist_count", [0, 33])
def test_song_with_invalid_artist_count_is_skipped_with_item_warning(artist_count: int) -> None:
    reply, _ = _execute(
        "search.songs",
        {"keyword": "合作"},
        {
            "meta": {"nextpage": -1, "sum": 1},
            "body": {"item_song": [_song_with_artist_count(artist_count)]},
        },
    )
    assert reply.result["items"] == []
    assert reply.warnings == [{"code": "item_invalid", "entity": "item_song", "index": 0}]


@pytest.mark.parametrize(
    ("operation", "bucket", "item", "expected_id"),
    [
        (
            "search.artists",
            "singer",
            {"singerMid": "artist-1", "singerName": "方格岛"},
            "artist-1",
        ),
        (
            "search.albums",
            "item_album",
            {"albumMid": "album-1", "albumName": "纸上温室"},
            "album-1",
        ),
        (
            "search.playlists",
            "item_songlist",
            {"tid": 71, "title": "夜航歌单", "songnum": 12},
            "71",
        ),
    ],
)
def test_four_typed_searches_have_stable_entity_dtos(
    operation: str, bucket: str, item: Mapping[str, object], expected_id: str
) -> None:
    reply, _ = _execute(
        operation,
        {"keyword": "夜航"},
        {"meta": {"nextpage": -1, "sum": 1}, "body": {bucket: [item]}},
    )
    assert cast("list[dict[str, object]]", reply.result["items"])[0]["id"] == expected_id


def test_response_level_missing_bucket_is_schema_changed() -> None:
    with pytest.raises(CatalogFailure) as captured:
        _execute(
            "search.songs",
            {"keyword": "月光"},
            {"meta": {"nextpage": -1, "sum": 0}, "body": {}},
        )
    assert captured.value.code == CatalogFailureCode.UPSTREAM_SCHEMA_CHANGED.value


@pytest.mark.parametrize(
    "params",
    [
        {"keyword": ""},
        {"keyword": "valid", "page": 0},
        {"keyword": "valid", "pageSize": 51},
        {"keyword": "valid", "arbitrary": "method"},
    ],
)
def test_invalid_search_params_never_reach_source(params: Mapping[str, object]) -> None:
    source = FakeSource({"search.songs": {}})

    async def run() -> None:
        with pytest.raises(CatalogFailure) as captured:
            await CatalogService(source).execute("search.songs", params)
        assert captured.value.code == CatalogFailureCode.INVALID_PARAMS.value

    anyio.run(run)
    assert source.calls == []


def test_hotkeys_completion_and_lyrics_are_normalized_without_raw_transport_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hotkeys, _ = _execute(
        "search.hotkeys", {}, {"vec_hotkey": [{"query": "新歌", "rawTrace": "ignored"}]}
    )
    completion, _ = _execute(
        "search.complete", {"keyword": "周"}, {"itemlist": [{"word": "周杰伦"}]}
    )
    lyrics, _ = _execute(
        "lyrics.get",
        {"id": "song-mid-1"},
        {"songID": 101, "lyric": "[00:01]纸月光", "trans": "Paper moon", "roma": "zhi"},
    )
    assert hotkeys.result == {"items": [{"keyword": "新歌"}]}
    assert completion.result == {"items": [{"keyword": "周杰伦"}]}
    assert lyrics.result == {
        "trackId": "song-mid-1",
        "lyric": "[00:01]纸月光",
        "translation": "Paper moon",
        "romanization": "zhi",
    }

    monkeypatch.setattr("qqmusic_provider.catalog.qrc_decrypt", lambda value: f"decoded:{value}")
    encrypted, _ = _execute(
        "lyrics.get",
        {"id": "song-mid-1"},
        {"songID": 101, "crypt": 1, "lyric": "aa", "trans": "bb", "roma": ""},
    )
    assert encrypted.result == {
        "trackId": "song-mid-1",
        "lyric": "decoded:aa",
        "translation": "decoded:bb",
        "romanization": "",
    }


def test_recommendation_chart_and_detail_shapes_use_the_same_song_normalizer() -> None:
    guess, _ = _execute("recommend.guess", {}, {"tracks": [_song()]})
    radar, _ = _execute(
        "recommend.radar", {"page": 1}, {"VecSongs": [{"Track": _song()}], "HasMore": 0}
    )
    chart, _ = _execute(
        "charts.detail",
        {"id": 26, "page": 1, "pageSize": 20},
        {"songInfoList": [_song()], "data": {"totalNum": 1}},
    )
    detail, _ = _execute("song.detail", {"id": "song-mid-1"}, {"track_info": _song()})

    assert cast("list[object]", guess.result["items"])
    assert cast("list[object]", radar.result["items"])
    assert cast("list[object]", chart.result["items"])
    assert cast("dict[str, object]", detail.result["song"])["id"] == "song-mid-1"


def test_new_song_recommendations_are_a_bounded_one_shot_list() -> None:
    reply, _ = _execute(
        "recommend.newSongs",
        {"area": 5},
        {"songlist": [_song(f"song-{index}", f"第 {index} 首") for index in range(59)]},
    )
    assert len(cast("list[object]", reply.result["items"])) == 50
    assert reply.result["hasMore"] is False


def test_chart_category_accepts_the_real_zero_group_id() -> None:
    reply, _ = _execute(
        "charts.list",
        {},
        {
            "group": [
                {
                    "groupId": 0,
                    "groupName": "巅峰榜",
                    "toplist": [
                        {
                            "topId": 26,
                            "title": "热歌榜",
                            "frontPicUrl": "https://y.gtimg.cn/example.jpg",
                            "updateTime": "2026-08-12",
                        }
                    ],
                }
            ]
        },
    )
    groups = cast("list[dict[str, object]]", reply.result["groups"])
    assert groups[0]["id"] == "0"
    assert reply.warnings == []


def test_playlist_album_and_artist_read_only_details_are_typed() -> None:
    playlist, _ = _execute(
        "playlist.detail",
        {"id": 71, "page": 1, "pageSize": 20},
        {
            "dirinfo": {"tid": 71, "title": "夜航歌单"},
            "songlist": [_song()],
            "total_song_num": 1,
            "hasmore": 0,
        },
    )
    album, _ = _execute(
        "album.detail",
        {"id": "album-mid-1"},
        {"basicInfo": {"albumMid": "album-mid-1", "albumName": "温室唱片", "desc": "简介"}},
    )
    artist, _ = _execute(
        "artist.detail",
        {"id": "artist-mid-1"},
        {
            "singer_list": [
                {
                    "basic_info": {"singer_mid": "artist-mid-1", "name": "林间电台"},
                    "ex_info": {"desc": "来自温室的声音"},
                }
            ]
        },
    )
    assert cast("dict[str, object]", playlist.result["summary"])["id"] == "71"
    assert cast("dict[str, object]", album.result["album"])["id"] == "album-mid-1"
    artist_result = cast("dict[str, object]", artist.result["artist"])
    assert artist_result["id"] == "artist-mid-1"
    assert artist_result["description"] == "来自温室的声音"


def test_artist_detail_known_empty_singer_list_is_a_typed_not_found_result() -> None:
    reply, source = _execute("artist.detail", {"id": "artist-mid-1"}, {"singer_list": []})
    assert reply.result == {"artist": None}
    assert reply.warnings == []
    assert source.calls == [("artist.detail", {"id": "artist-mid-1"})]


def test_artist_detail_non_list_singer_list_remains_a_schema_failure() -> None:
    with pytest.raises(CatalogFailure) as captured:
        _execute("artist.detail", {"id": "artist-mid-1"}, {"singer_list": {}})
    assert captured.value.code == CatalogFailureCode.UPSTREAM_SCHEMA_CHANGED.value


def test_artist_songs_normalizes_pagination_and_uses_the_fixed_source_operation() -> None:
    reply, source = _execute(
        "artist.songs",
        {"id": "artist-mid-1", "page": 2, "pageSize": 10},
        {"songList": [_song()], "total": 24, "hasmore": 1},
    )
    assert source.calls == [
        ("artist.songs", {"id": "artist-mid-1", "page": 2, "pageSize": 10})
    ]
    assert reply.result["page"] == 2
    assert reply.result["hasMore"] is True
    assert reply.result["total"] == 24
    assert len(cast("list[object]", reply.result["items"])) == 1


def test_artist_songs_empty_page_is_valid() -> None:
    reply, _ = _execute(
        "artist.songs",
        {"id": "artist-mid-1"},
        {"songList": [], "total": 0, "hasmore": 0},
    )
    assert reply.result == {"items": [], "page": 1, "hasMore": False, "total": 0}
    assert reply.warnings == []


def test_artist_songs_keeps_valid_items_and_warns_for_bad_items() -> None:
    reply, _ = _execute(
        "artist.songs",
        {"id": "artist-mid-1"},
        {"songList": [_song("good-1"), {"mid": "broken", "name": 42}, _song("good-2")]},
    )
    assert [
        item["id"] for item in cast("list[dict[str, object]]", reply.result["items"])
    ] == ["good-1", "good-2"]
    assert reply.warnings == [{"code": "item_invalid", "entity": "song", "index": 1}]


@pytest.mark.parametrize(
    "params",
    [
        {"id": ""},
        {"id": "bad/id"},
        {"id": "artist-mid-1", "page": 0},
        {"id": "artist-mid-1", "pageSize": 51},
        {"id": "artist-mid-1", "unexpected": True},
    ],
)
def test_artist_songs_rejects_invalid_params_before_source_call(
    params: Mapping[str, object],
) -> None:
    source = FakeSource({"artist.songs": {}})

    async def run() -> None:
        with pytest.raises(CatalogFailure) as captured:
            await CatalogService(source).execute("artist.songs", params)
        assert captured.value.code == CatalogFailureCode.INVALID_PARAMS.value

    anyio.run(run)
    assert source.calls == []


def test_playlist_detail_accepts_a_positive_created_directory_id() -> None:
    reply, source = _execute(
        "playlist.detail",
        {"id": 71, "dirId": 201, "page": 1, "pageSize": 20},
        {
            "dirinfo": {"tid": 71, "title": "我喜欢"},
            "songlist": [_song()],
            "total_song_num": 1,
            "hasmore": 0,
        },
    )
    assert source.calls[0][1]["dirId"] == 201
    assert len(cast("dict[str, object]", reply.result["songs"])["items"]) == 1
