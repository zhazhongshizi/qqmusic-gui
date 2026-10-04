"""GetVkey playback resolution with ordered quality fallback and stable failures."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Protocol, cast
from urllib.parse import quote, urlencode, urljoin, urlsplit

from .session import QQMusicSession

IMPLEMENTED_PLAYBACK_METHODS = ("playback.resolve",)
_MAX_MID_LENGTH = 128
_MAX_PURL_LENGTH = 1_800
_CDN_BASE = "https://isure.stream.qqmusic.qq.com/"
_MV_HOSTS = ("mv.music.tc.qq.com", "mv6.music.tc.qq.com")
_QUALITY_ORDER = {
    "auto": ("flac", "320k", "128k"),
    "flac": ("flac", "320k", "128k"),
    "320k": ("320k", "128k"),
    "128k": ("128k",),
}


class PlaybackFailureCode(str, Enum):
    INVALID_PARAMS = "invalid_params"
    NETWORK_UNAVAILABLE = "network_unavailable"
    RATE_LIMITED = "rate_limited"
    AUTHENTICATION_REQUIRED = "authentication_required"
    ENTITLEMENT_DENIED = "entitlement_denied"
    DEVICE_LIMIT = "playback_device_limit"
    PLAYBACK_UNAVAILABLE = "playback_unavailable"
    UPSTREAM_SCHEMA_CHANGED = "upstream_schema_changed"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"


class PlaybackFailure(Exception):
    def __init__(self, code: PlaybackFailureCode, *, retryable: bool = False) -> None:
        super().__init__(code.value)
        self.code = code.value
        self.retryable = retryable


class PlaybackSource(Protocol):
    async def resolve(
        self, song_mid: str, qualities: tuple[str, ...]
    ) -> Mapping[str, object]: ...

    async def resolve_mv(self, song_mid: str) -> Mapping[str, object] | None: ...

    async def close(self) -> None: ...


class QQMusicPlaybackSource:
    def __init__(
        self, session: QQMusicSession | None = None, *, device_path: Path | str | None = None
    ) -> None:
        self._owns_session = session is None
        if session is None and device_path is None:
            raise ValueError("device_path_required")
        self._session = session if session is not None else QQMusicSession(cast("str", device_path))

    async def resolve(self, song_mid: str, qualities: tuple[str, ...]) -> Mapping[str, object]:
        from qqmusic_api.modules.song import (  # type: ignore[import-untyped]
            SongFileInfo,
            SongFileType,
        )

        file_types = {
            "flac": SongFileType.FLAC,
            "320k": SongFileType.MP3_320,
            "128k": SongFileType.MP3_128,
        }
        client = self._session.client()
        requests = [
            SongFileInfo(mid=song_mid, file_type=file_types[quality]) for quality in qualities
        ]
        try:
            response = await client.song.get_song_urls(requests)
        except Exception as error:
            raise _map_upstream_error(error) from None
        data = getattr(response, "data", None)
        expiration = getattr(response, "expiration", None)
        if not isinstance(data, list) or type(expiration) is not int:
            raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
        items: list[dict[str, object]] = []
        for quality, item in zip(qualities, data, strict=False):
            items.append(
                {
                    "quality": quality,
                    "result": getattr(item, "result", None),
                    "purl": getattr(item, "purl", None),
                }
            )
        credential = client.credential
        authenticated = bool(
            getattr(credential, "musicid", 0) and getattr(credential, "musickey", "")
        )
        return {
            "expiration": expiration,
            "items": items,
            "authenticated": authenticated,
        }

    async def resolve_mv(self, song_mid: str) -> Mapping[str, object] | None:
        client = self._session.client()
        try:
            detail = await client.song.get_detail(song_mid)
            track = detail.track
            if track.mid != song_mid:
                raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
            vid = track.mv.vid
            if not vid:
                return None
            if not isinstance(vid, str) or len(vid) > 128 or not vid.isalnum():
                raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
            request = client.mv.get_mv_urls([vid])
            # H.264 avoids requiring the optional Windows HEVC extension.
            params = {**request.param, "format": 264, "dolby": 0, "use_ipv6": 0}
            reply = await request.replace(param=params)
        except PlaybackFailure:
            raise
        except Exception as error:
            raise _map_upstream_error(error) from None
        streams = reply.data.get(vid)
        if streams is None:
            return None
        return {
            "durationSeconds": streams.duration,
            "items": [
                {
                    "code": item.code,
                    "format": item.format,
                    "fileSize": item.file_size,
                    "urls": _mv_playback_urls(item),
                    "expiration": item.expire,
                }
                for item in streams.mp4
            ],
        }

    async def close(self) -> None:
        if self._owns_session:
            await self._session.close()


@dataclass(frozen=True, slots=True)
class PlaybackReply:
    result: dict[str, object]


class PlaybackService:
    def __init__(self, source: PlaybackSource | None = None) -> None:
        self._source = source or QQMusicPlaybackSource()

    async def execute(
        self, operation: str, raw_params: Mapping[str, object]
    ) -> PlaybackReply:
        if operation != "playback.resolve":
            raise PlaybackFailure(PlaybackFailureCode.INVALID_PARAMS)
        song_mid, preferred = _validate_params(raw_params)
        qualities = _QUALITY_ORDER[preferred]
        raw = await self._source.resolve(song_mid, qualities)
        try:
            result = _normalize_resolution(raw, song_mid, qualities)
        except PlaybackFailure as error:
            if raw_params.get("allowMvFallback", True) is False:
                raise
            # GetVkey's 104003 also occurs for unavailable recordings. A linked
            # MV must obtain its own successful authorization; it never reuses
            # or alters the recording's permission. Upstream login/network
            # exceptions occur before normalization and never enter this path.
            if error.code not in {
                PlaybackFailureCode.PLAYBACK_UNAVAILABLE.value,
                PlaybackFailureCode.AUTHENTICATION_REQUIRED.value,
                PlaybackFailureCode.ENTITLEMENT_DENIED.value,
            }:
                raise
            try:
                mv = await self._source.resolve_mv(song_mid)
                if mv is None:
                    raise error
                result = _normalize_mv_resolution(mv, song_mid)
            except PlaybackFailure as mv_error:
                if mv_error.code in {
                    PlaybackFailureCode.PLAYBACK_UNAVAILABLE.value,
                    PlaybackFailureCode.AUTHENTICATION_REQUIRED.value,
                    PlaybackFailureCode.ENTITLEMENT_DENIED.value,
                }:
                    raise error from None
                raise
        return PlaybackReply(result)

    async def close(self) -> None:
        await self._source.close()


def _validate_params(raw: Mapping[str, object]) -> tuple[str, str]:
    if set(raw) not in ({"id", "preferredQuality"}, {"id", "preferredQuality", "allowMvFallback"}):
        raise PlaybackFailure(PlaybackFailureCode.INVALID_PARAMS)
    if "allowMvFallback" in raw and type(raw["allowMvFallback"]) is not bool:
        raise PlaybackFailure(PlaybackFailureCode.INVALID_PARAMS)
    song_mid = raw.get("id")
    preferred = raw.get("preferredQuality")
    if (
        not isinstance(song_mid, str)
        or not song_mid
        or len(song_mid) > _MAX_MID_LENGTH
        or not all(character.isalnum() or character in "_-" for character in song_mid)
        or not isinstance(preferred, str)
        or preferred not in _QUALITY_ORDER
    ):
        raise PlaybackFailure(PlaybackFailureCode.INVALID_PARAMS)
    return song_mid, preferred


def _normalize_resolution(
    raw: Mapping[str, object], song_mid: str, qualities: tuple[str, ...]
) -> dict[str, object]:
    if set(raw) != {"expiration", "items", "authenticated"}:
        raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
    expiration = raw.get("expiration")
    items = raw.get("items")
    authenticated = raw.get("authenticated")
    if (
        type(expiration) is not int
        or not 0 <= expiration <= 86_400
        or not isinstance(items, list)
        or len(items) > len(qualities)
        or type(authenticated) is not bool
    ):
        raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)

    denial_codes: set[int] = set()
    for index, item_value in enumerate(items):
        if not isinstance(item_value, Mapping):
            raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
        item = cast("Mapping[str, object]", item_value)
        if set(item) != {"quality", "result", "purl"}:
            raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
        quality = item.get("quality")
        result = item.get("result")
        purl = item.get("purl")
        if quality != qualities[index] or type(result) is not int or not isinstance(purl, str):
            raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
        if result == 0 and purl:
            url = _safe_media_url(purl)
            return {
                "trackId": song_mid,
                "quality": quality,
                "url": url,
                "expiresInSeconds": expiration,
            }
        denial_codes.add(result)

    if 104013 in denial_codes:
        raise PlaybackFailure(PlaybackFailureCode.DEVICE_LIMIT)
    if 104003 in denial_codes:
        code = (
            PlaybackFailureCode.ENTITLEMENT_DENIED
            if authenticated
            else PlaybackFailureCode.AUTHENTICATION_REQUIRED
        )
        raise PlaybackFailure(code)
    raise PlaybackFailure(PlaybackFailureCode.PLAYBACK_UNAVAILABLE)


def _safe_media_url(purl: str) -> str:
    if not purl or len(purl) > _MAX_PURL_LENGTH or "\\" in purl:
        raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
    parsed = urlsplit(purl)
    path_segments = parsed.path.split("/")
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.fragment
        or purl.startswith(("/", "//"))
        or ".." in path_segments
        or "%2e" in parsed.path.lower()
    ):
        raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
    resolved = urljoin(_CDN_BASE, purl)
    if not resolved.startswith(_CDN_BASE):
        raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
    return resolved


def _normalize_mv_resolution(raw: Mapping[str, object], song_mid: str) -> dict[str, object]:
    if set(raw) != {"durationSeconds", "items"}:
        raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
    duration = raw.get("durationSeconds")
    items = raw.get("items")
    if type(duration) is not int or not 0 < duration <= 86_400 or not isinstance(items, list):
        raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
    if len(items) > 32:
        raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
    candidates: list[tuple[int, str, int]] = []
    for item in items:
        if not isinstance(item, dict) or set(item) != {
            "code", "format", "fileSize", "urls", "expiration"
        }:
            raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
        if type(item["code"]) is not int or type(item["format"]) is not int:
            raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
        if item["code"] != 0 or item["format"] != 264:
            continue
        size, expiration, urls = item["fileSize"], item["expiration"], item["urls"]
        if (
            type(size) is not int or size <= 0
            or type(expiration) is not int or not 0 < expiration <= 86_400
            or not isinstance(urls, list) or len(urls) > 8
        ):
            raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
        for url in urls:
            if not isinstance(url, str) or len(url) > 2_048 or "\\" in url:
                raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
            try:
                parsed = urlsplit(url)
                port = parsed.port
            except ValueError:
                raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED) from None
            if (
                parsed.scheme != "https" or parsed.hostname not in _MV_HOSTS
                or parsed.username is not None or parsed.password is not None
                or parsed.fragment or port not in (None, 443)
            ):
                raise PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
            candidates.append((size, url, expiration))
    if not candidates:
        raise PlaybackFailure(PlaybackFailureCode.PLAYBACK_UNAVAILABLE)
    # No picture is displayed: choose the smallest compatible video stream.
    _, url, expiration = min(candidates, key=lambda item: (
        item[0], urlsplit(item[1]).hostname != "mv.music.tc.qq.com"
    ))
    return {
        "trackId": song_mid,
        "quality": "qq-mv",
        "url": url,
        "expiresInSeconds": expiration,
        "durationMs": duration * 1_000,
    }


def _mv_playback_urls(item: Any) -> list[str]:
    """QQ returns CDN bases plus an independently authorized path and filename."""
    urls: list[str] = []
    for base in item.url:
        parsed = urlsplit(base)
        if parsed.scheme == "http" and parsed.hostname in _MV_HOSTS:
            continue  # Use the HTTPS alternative returned by QQ.
        if parsed.path not in ("", "/"):
            urls.append(base)
            continue
        if not item.cn or not item.vkey:
            continue
        path = f"{quote(item.vkey, safe='')}/{quote(item.cn, safe='')}"
        urls.append(urljoin(base.rstrip("/") + "/", path) + "?" + urlencode({"fname": item.cn}))
    return urls


def _map_upstream_error(error: Exception) -> PlaybackFailure:
    from pydantic import ValidationError
    from qqmusic_api import (  # type: ignore[import-untyped]
        ApiDataError,
        BaseApiException,
        CredentialExpiredError,
        CredentialInvalidError,
        HTTPError,
        NetworkError,
        RatelimitedError,
    )

    if isinstance(error, NetworkError | HTTPError):
        return PlaybackFailure(PlaybackFailureCode.NETWORK_UNAVAILABLE, retryable=True)
    if isinstance(error, RatelimitedError):
        return PlaybackFailure(PlaybackFailureCode.RATE_LIMITED, retryable=True)
    if isinstance(error, CredentialExpiredError | CredentialInvalidError):
        return PlaybackFailure(PlaybackFailureCode.AUTHENTICATION_REQUIRED)
    if isinstance(error, ApiDataError | ValidationError | KeyError | TypeError | ValueError):
        return PlaybackFailure(PlaybackFailureCode.UPSTREAM_SCHEMA_CHANGED)
    if isinstance(error, BaseApiException):
        return PlaybackFailure(PlaybackFailureCode.UPSTREAM_UNAVAILABLE, retryable=True)
    return PlaybackFailure(PlaybackFailureCode.UPSTREAM_UNAVAILABLE, retryable=True)
