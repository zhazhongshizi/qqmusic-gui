from __future__ import annotations

from collections.abc import Mapping
from types import SimpleNamespace

import pytest

from qqmusic_provider.playback import (
    PlaybackFailure,
    PlaybackFailureCode,
    PlaybackService,
    QQMusicPlaybackSource,
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class OfflinePlaybackSource:
    def __init__(self, response: Mapping[str, object]) -> None:
        self.response = response
        self.calls: list[tuple[str, tuple[str, ...]]] = []
        self.closed = False
        self.mv_response: Mapping[str, object] | None = None
        self.mv_calls: list[str] = []

    async def resolve(self, song_mid: str, qualities: tuple[str, ...]) -> Mapping[str, object]:
        self.calls.append((song_mid, qualities))
        return self.response

    async def close(self) -> None:
        self.closed = True

    async def resolve_mv(self, song_mid: str) -> Mapping[str, object] | None:
        self.mv_calls.append(song_mid)
        return self.mv_response


def _response(
    items: list[dict[str, object]], *, authenticated: bool = True
) -> dict[str, object]:
    return {"expiration": 7_200, "items": items, "authenticated": authenticated}


def _item(quality: str, result: int, purl: str = "") -> dict[str, object]:
    return {"quality": quality, "result": result, "purl": purl}


@pytest.mark.anyio
async def test_disabled_mv_fallback_never_resolves_mv() -> None:
    source = OfflinePlaybackSource(_response([_item("128k", 104004)]))
    source.mv_response = {"durationSeconds": 182, "items": [_mv_item()]}
    with pytest.raises(PlaybackFailure) as raised:
        await PlaybackService(source).execute(
            "playback.resolve",
            {"id": "fixtureMid", "preferredQuality": "128k", "allowMvFallback": False},
        )
    assert raised.value.code == PlaybackFailureCode.PLAYBACK_UNAVAILABLE.value
    assert source.mv_calls == []


@pytest.mark.anyio
@pytest.mark.parametrize("value", [0, 1, "false", None])
async def test_mv_fallback_parameter_requires_a_boolean(value: object) -> None:
    source = OfflinePlaybackSource(_response([]))
    with pytest.raises(PlaybackFailure):
        await PlaybackService(source).execute(
            "playback.resolve",
            {"id": "fixtureMid", "preferredQuality": "128k", "allowMvFallback": value},
        )
    assert source.calls == []
    assert source.mv_calls == []


@pytest.mark.anyio
async def test_resolves_highest_available_quality_to_reviewed_cdn() -> None:
    source = OfflinePlaybackSource(
        _response(
            [
                _item("flac", 0, "F000fixture.flac?vkey=SENTINEL_VKEY"),
                _item("320k", 0, "M800fixture.mp3?vkey=unused"),
                _item("128k", 0, "M500fixture.mp3?vkey=unused"),
            ]
        )
    )
    service = PlaybackService(source)

    reply = await service.execute(
        "playback.resolve", {"id": "fixtureMid", "preferredQuality": "auto"}
    )

    assert source.calls == [("fixtureMid", ("flac", "320k", "128k"))]
    assert reply.result == {
        "trackId": "fixtureMid",
        "quality": "flac",
        "url": "https://isure.stream.qqmusic.qq.com/F000fixture.flac?vkey=SENTINEL_VKEY",
        "expiresInSeconds": 7_200,
    }
    assert source.mv_calls == []


@pytest.mark.anyio
async def test_falls_back_in_declared_order_without_upgrading_preference() -> None:
    source = OfflinePlaybackSource(
        _response([_item("320k", 104004), _item("128k", 0, "M500fixture.mp3?vkey=v")])
    )
    reply = await PlaybackService(source).execute(
        "playback.resolve", {"id": "fixtureMid", "preferredQuality": "320k"}
    )
    assert reply.result["quality"] == "128k"
    assert source.calls[0][1] == ("320k", "128k")


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("authenticated", "result", "expected"),
    [
        (False, 104003, PlaybackFailureCode.AUTHENTICATION_REQUIRED),
        (True, 104003, PlaybackFailureCode.ENTITLEMENT_DENIED),
        (True, 104013, PlaybackFailureCode.DEVICE_LIMIT),
        (True, 104004, PlaybackFailureCode.PLAYBACK_UNAVAILABLE),
    ],
)
async def test_maps_entitlement_and_availability_failures(
    authenticated: bool,
    result: int,
    expected: PlaybackFailureCode,
) -> None:
    source = OfflinePlaybackSource(
        _response([_item("128k", result)], authenticated=authenticated)
    )
    with pytest.raises(PlaybackFailure) as raised:
        await PlaybackService(source).execute(
            "playback.resolve", {"id": "fixtureMid", "preferredQuality": "128k"}
        )
    assert raised.value.code == expected.value
    assert source.mv_calls == ([] if result == 104013 else ["fixtureMid"])


def _mv_item(
    size: int = 1000, url: str = "https://mv.music.tc.qq.com/test.mp4"
) -> dict[str, object]:
    return {"code": 0, "format": 264, "fileSize": size, "urls": [url], "expiration": 86400}


@pytest.mark.anyio
async def test_unavailable_song_uses_smallest_linked_mv_without_changing_track_identity() -> None:
    source = OfflinePlaybackSource(_response([_item("128k", 104004)]))
    source.mv_response = {
        "durationSeconds": 317,
        "items": [_mv_item(4000), _mv_item(1000)],
    }
    result = (await PlaybackService(source).execute(
        "playback.resolve", {"id": "fixtureMid", "preferredQuality": "128k"}
    )).result
    assert source.mv_calls == ["fixtureMid"]
    assert result == {
        "trackId": "fixtureMid", "quality": "qq-mv",
        "url": "https://mv.music.tc.qq.com/test.mp4",
        "expiresInSeconds": 86400, "durationMs": 317000,
    }


@pytest.mark.anyio
@pytest.mark.parametrize("url", [
    "https://attacker.example/test.mp4", "http://mv.music.tc.qq.com/test.mp4",
    "https://mv.music.tc.qq.com.attacker.example/test.mp4",
    "https://user@mv.music.tc.qq.com/test.mp4",
    "https://mv.music.tc.qq.com:444/test.mp4",
])
async def test_mv_rejects_unreviewed_hosts_or_unsafe_urls(url: str) -> None:
    source = OfflinePlaybackSource(_response([_item("128k", 104004)]))
    source.mv_response = {"durationSeconds": 317, "items": [_mv_item(url=url)]}
    with pytest.raises(PlaybackFailure) as raised:
        await PlaybackService(source).execute(
            "playback.resolve", {"id": "fixtureMid", "preferredQuality": "128k"})
    assert raised.value.code == PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED.value


@pytest.mark.anyio
async def test_unplayable_mv_keeps_the_song_unavailable() -> None:
    source = OfflinePlaybackSource(_response([_item("128k", 104004)]))
    source.mv_response = {"durationSeconds": 317, "items": [{**_mv_item(), "code": 2000}]}
    with pytest.raises(PlaybackFailure) as raised:
        await PlaybackService(source).execute(
            "playback.resolve", {"id": "fixtureMid", "preferredQuality": "128k"})
    assert raised.value.code == PlaybackFailureCode.PLAYBACK_UNAVAILABLE.value


@pytest.mark.anyio
@pytest.mark.parametrize("authenticated", [True, False])
async def test_104003_recording_can_use_a_separately_authorized_mv(authenticated: bool) -> None:
    source = OfflinePlaybackSource(_response([_item("128k", 104003)], authenticated=authenticated))
    source.mv_response = {"durationSeconds": 182, "items": [_mv_item()]}
    reply = await PlaybackService(source).execute(
        "playback.resolve", {"id": "fixtureMid", "preferredQuality": "128k"})
    assert reply.result["quality"] == "qq-mv"


@pytest.mark.anyio
async def test_upstream_authentication_failure_does_not_attempt_mv() -> None:
    class ExpiredSource(OfflinePlaybackSource):
        async def resolve(self, song_mid: str, qualities: tuple[str, ...]) -> Mapping[str, object]:
            raise PlaybackFailure(PlaybackFailureCode.AUTHENTICATION_REQUIRED)

    source = ExpiredSource(_response([]))
    with pytest.raises(PlaybackFailure):
        await PlaybackService(source).execute(
            "playback.resolve", {"id": "fixtureMid", "preferredQuality": "128k"})
    assert source.mv_calls == []


@pytest.mark.anyio
async def test_live_adapter_requests_h264_and_joins_cdn_authorization_without_http() -> None:
    class Request:
        def __init__(self) -> None:
            self.param = {"format": 265, "vids": ["linkedVid"], "dolby": 1, "use_ipv6": 1}

        def replace(self, *, param: dict[str, object]) -> Request:
            assert param["format"] == 264
            assert param["dolby"] == 0
            assert param["use_ipv6"] == 0
            return self

        def __await__(self):
            async def response():
                return SimpleNamespace(data={"linkedVid": SimpleNamespace(
                    duration=182, mp4=[SimpleNamespace(
                        code=0, format=264, file_size=6000, expire=86400,
                        url=["http://mv6.music.tc.qq.com", "https://mv.music.tc.qq.com"],
                        cn="fixture.mp4", vkey="SENTINEL_AUTHORIZED_PATH",
                    )])})
            return response().__await__()

    async def detail(mid: str):
        return SimpleNamespace(track=SimpleNamespace(mid=mid, mv=SimpleNamespace(vid="linkedVid")))

    def urls(vids: list[str]):
        assert vids == ["linkedVid"]
        return Request()

    client = SimpleNamespace(
        song=SimpleNamespace(get_detail=detail), mv=SimpleNamespace(get_mv_urls=urls)
    )
    session = SimpleNamespace(client=lambda: client)
    source = QQMusicPlaybackSource(session)  # type: ignore[arg-type]
    result = await source.resolve_mv("fixtureMid")
    assert result is not None
    assert result["items"] == [{
        "code": 0, "format": 264, "fileSize": 6000, "expiration": 86400,
        "urls": ["https://mv.music.tc.qq.com/SENTINEL_AUTHORIZED_PATH/fixture.mp4?fname=fixture.mp4"],
    }]


@pytest.mark.anyio
async def test_rejects_absolute_or_path_escaping_purl() -> None:
    unsafe_values = [
        "https://attacker.example/audio.mp3",
        "//attacker.example/audio.mp3",
        "/absolute/audio.mp3",
        "../audio.mp3",
        "folder\\audio.mp3",
    ]
    for purl in unsafe_values:
        source = OfflinePlaybackSource(_response([_item("128k", 0, purl)]))
        with pytest.raises(PlaybackFailure) as raised:
            await PlaybackService(source).execute(
                "playback.resolve", {"id": "fixtureMid", "preferredQuality": "128k"}
            )
        assert raised.value.code == PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED.value


@pytest.mark.anyio
async def test_rejects_invalid_params_and_misaligned_upstream_items() -> None:
    service = PlaybackService(OfflinePlaybackSource(_response([])))
    invalid = [
        {},
        {"id": "", "preferredQuality": "auto"},
        {"id": "mid", "preferredQuality": "master"},
        {"id": "bad/mid", "preferredQuality": "128k"},
        {"id": "mid", "preferredQuality": "128k", "url": "https://attacker.example"},
    ]
    for params in invalid:
        with pytest.raises(PlaybackFailure) as raised:
            await service.execute("playback.resolve", params)
        assert raised.value.code == PlaybackFailureCode.INVALID_PARAMS.value

    mismatched = PlaybackService(
        OfflinePlaybackSource(_response([_item("flac", 0, "F000fixture.flac")]))
    )
    with pytest.raises(PlaybackFailure) as raised:
        await mismatched.execute(
            "playback.resolve", {"id": "mid", "preferredQuality": "128k"}
        )
    assert raised.value.code == PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED.value


@pytest.mark.anyio
async def test_close_is_forwarded_to_source() -> None:
    source = OfflinePlaybackSource(_response([]))
    service = PlaybackService(source)
    await service.close()
    assert source.closed
