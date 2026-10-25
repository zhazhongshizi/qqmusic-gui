"""Exercise the pinned SDK's real requests without contacting QQ or an account."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace

import pytest
from qqmusic_api.core.request import CgiRequest, HttpRequest

from qqmusic_provider.catalog import QQMusicCatalogSource, _validate_params
from qqmusic_provider.library import QQMusicLibrarySource, _resolve_song_info
from qqmusic_provider.session import QQMusicSession

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def sdk_session(tmp_path: Path):
    session = QQMusicSession(tmp_path / "qq-device.json")
    await session.initialize()
    try:
        yield session
    finally:
        await session.close()


async def test_real_sdk_session_rebuild_keeps_device_and_credential(sdk_session: QQMusicSession):
    client = sdk_session.client()
    device = await client._engine._cgi._device_store.get_device()
    credential = client.credential
    assert client._engine.transport._client.multiplexed is False
    assert client._engine.transport._client.trust_env is False
    await sdk_session.rebuild_if_current(sdk_session.generation)
    rebuilt = sdk_session.client()
    assert rebuilt.credential is credential
    rebuilt_device = await rebuilt._engine._cgi._device_store.get_device()
    assert rebuilt_device == device
    assert rebuilt._engine.transport._client.multiplexed is False
    assert rebuilt._engine.transport._client.trust_env is False


@pytest.mark.parametrize("empty_cookie", ["", None])
async def test_real_sdk_qq_login_accepts_empty_response_cookies(
    sdk_session: QQMusicSession, monkeypatch: pytest.MonkeyPatch, empty_cookie: str | None,
):
    from niquests.models import Response
    from qqmusic_api.models.login import QR, QRLoginType

    from qqmusic_provider.auth import QQMusicAuthSource

    client = sdk_session.client()
    original_execute = client.execute
    visited = []

    async def request(method, url, **kwargs):
        visited.append(url)
        response = Response()
        response.status_code = 200
        response._content_consumed = True
        response.encoding = "utf-8"
        if url.endswith("ptqrlogin"):
            response._content = (
                b"ptuiCB('0','0','https://fixture.invalid/?uin=123&service=ptqrlogin"
                b"&ptsigx=fixture-signature&s_url=fixture','0','fixture');"
            )
        elif url.endswith("check_sig"):
            response.status_code = 302
            response._content = b""
            response.cookies.set("p_skey", "fixture-signature-cookie")
            response.cookies.set("empty-upstream-cookie", empty_cookie)
        else:
            assert url == "https://graph.qq.com/oauth2.0/authorize"
            assert kwargs["cookies"]["p_skey"] == "fixture-signature-cookie"
            response.status_code = 302
            response._content = b""
            response.headers["Location"] = "https://fixture.invalid/?code=fixture-code&state=state"
        return response

    async def execute(descriptor):
        if isinstance(descriptor, CgiRequest):
            assert descriptor.module == "QQConnectLogin.LoginServer"
            assert descriptor.method == "QQLogin"
            assert descriptor.param == {"code": "fixture-code"}
            return {"musicid": 123, "musickey": "fixture-music-key"}
        return await original_execute(descriptor)

    monkeypatch.setattr(client._engine.transport._client, "request", request)
    monkeypatch.setattr(client, "execute", execute)
    result = await QQMusicAuthSource(sdk_session).check_qr(
        QR(b"", QRLoginType.QQ, "image/png", "fixture-qr-signature")
    )
    assert result.state == "authenticated"
    assert result.credential["musicid"] == 123
    assert client.credential.musickey == "fixture-music-key"
    assert len(visited) == 3


async def test_response_cookie_fix_preserves_missing_and_conflicting_names(
    sdk_session: QQMusicSession, monkeypatch: pytest.MonkeyPatch,
):
    from niquests.cookies import CookieConflictError
    from niquests.models import Response
    from qqmusic_api.core.transport import PreparedRequest

    response = Response()
    response.status_code = 200
    response._content = b""
    response._content_consumed = True
    response.cookies.set("empty", "", domain="fixture.invalid", path="/")
    response.cookies.set("duplicate", "one", domain="a.invalid")
    response.cookies.set("duplicate", "two", domain="b.invalid")

    async def request(*args, **kwargs):
        return response

    transport = sdk_session.client()._engine.transport
    monkeypatch.setattr(transport._client, "request", request)
    result = await transport.request(PreparedRequest("GET", "https://fixture.invalid/"))
    assert result.cookies["empty"] == ""
    with pytest.raises(KeyError):
        result.cookies["missing"]
    with pytest.raises(CookieConflictError):
        result.cookies["duplicate"]
    assert len(result.cookies) == 3
    assert any(cookie.domain == "fixture.invalid" for cookie in result.cookies)


_CATALOG_CASES = [
    ("search.hotkeys", {}),
    ("search.complete", {"keyword": "晴"}),
    *[(f"search.{kind}", {"keyword": "晴天", "page": 2, "pageSize": 3})
      for kind in ("songs", "artists", "albums", "playlists")],
    ("recommend.guess", {}),
    ("recommend.radar", {"page": 2}),
    ("recommend.playlists", {"page": 2, "pageSize": 3}),
    ("recommend.newSongs", {"area": 5}),
    ("charts.list", {}),
    ("charts.detail", {"id": 26, "page": 2, "pageSize": 3}),
    *[(method, {"id": "fixtureMid"})
      for method in ("song.detail", "album.detail", "artist.detail", "lyrics.get")],
    ("playlist.detail", {"id": 123, "dirId": 456, "page": 2, "pageSize": 3}),
    *[(method, {"id": "fixtureMid", "page": 2, "pageSize": 3})
      for method in ("album.songs", "artist.songs", "artist.albums")],
]


@pytest.mark.parametrize(("method", "params"), _CATALOG_CASES)
async def test_catalog_uses_real_sdk_descriptors_and_raw_results(
    sdk_session: QQMusicSession, monkeypatch: pytest.MonkeyPatch,
    method: str, params: Mapping[str, object],
):
    captured = []

    async def execute(request):
        assert isinstance(request, CgiRequest | HttpRequest)
        assert request.response_model is None
        captured.append(request)
        return {"sentinel": "raw-result"}

    monkeypatch.setattr(sdk_session.client(), "execute", execute)
    source = QQMusicCatalogSource(sdk_session)
    result = await source.fetch(method, _validate_params(method, params))
    assert result == {"sentinel": "raw-result"}
    assert len(captured) == 1
    if method == "search.songs":
        assert captured[0].param["page_num"] == 2
        assert captured[0].param["num_per_page"] == 3
    if method == "lyrics.get":
        assert captured[0].param["trans"] == captured[0].param["roma"] == 1


@pytest.mark.parametrize("numeric", [False, True])
async def test_song_queries_use_sdk_query_info(
    sdk_session: QQMusicSession, monkeypatch: pytest.MonkeyPatch, numeric: bool,
):
    async def execute(request):
        assert request.param["types"] == [0, 0]
        assert request.param["ids" if numeric else "mids"] == (
            [101, 102] if numeric else ["mid-a", "mid-b"]
        )
        return SimpleNamespace(tracks=[
            SimpleNamespace(id=101, mid="mid-a", type=1),
            SimpleNamespace(id=102, mid="mid-b", type=2),
        ])

    monkeypatch.setattr(sdk_session.client(), "execute", execute)
    ids = ["101", "102"] if numeric else ["mid-a", "mid-b"]
    assert await _resolve_song_info(sdk_session.client(), ids) == [(101, 1), (102, 2)]


@pytest.mark.parametrize("operation", [
    "playlist.addSongs", "playlist.removeSongs", "song.like", "song.unlike",
])
async def test_library_writes_build_correct_sdk_requests_without_network(
    sdk_session: QQMusicSession, monkeypatch: pytest.MonkeyPatch, operation: str,
):
    from qqmusic_api import Credential

    sdk_session.client().credential = Credential(
        musicid=123, musickey="fixture-key", encrypt_uin="fixture-uin",
    )
    captured = []

    async def execute(request):
        captured.append(request)
        if request.method == "CgiGetTrackInfo":
            return SimpleNamespace(tracks=[SimpleNamespace(id=101, mid="mid-a", type=1)])
        assert request.require_login is True
        assert request.credential is sdk_session.client().credential
        return {"retCode": 0}

    monkeypatch.setattr(sdk_session.client(), "execute", execute)
    result = await QQMusicLibrarySource(sdk_session).execute(
        operation, {"songIds": ["mid-a"], "playlistId": 456},
    )
    assert result == {"succeeded": True, "affectedCount": 1}
    assert len(captured) == 2
    assert captured[1].method == (
        "AddSonglist" if operation in {"playlist.addSongs", "song.like"} else "DelSonglist"
    )
