"""QQMusicApi read-only catalog adapter and stable DTO normalization."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from html import unescape
from pathlib import Path
from typing import Any, Protocol, cast

from qqmusic_api.algorithms import qrc_decrypt  # type: ignore[import-untyped]

from .session import QQMusicSession

_MAX_TEXT = 512
_MAX_KEYWORD = 100
_MAX_PAGE = 100
_MAX_PAGE_SIZE = 50
_MAX_ARTISTS_PER_SONG = 32
_MID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_HTML_TAG = re.compile(r"<[^>]{1,128}>")


class CatalogFailureCode(str, Enum):
    INVALID_PARAMS = "invalid_params"
    NETWORK_UNAVAILABLE = "network_unavailable"
    RATE_LIMITED = "rate_limited"
    AUTHENTICATION_REQUIRED = "authentication_required"
    UPSTREAM_SCHEMA_CHANGED = "upstream_schema_changed"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"


class CatalogFailure(Exception):
    def __init__(self, code: CatalogFailureCode, *, retryable: bool = False) -> None:
        super().__init__(code.value)
        self.code = code.value
        self.retryable = retryable


class CatalogSource(Protocol):
    async def fetch(self, operation: str, params: Mapping[str, object]) -> Mapping[str, object]: ...

    async def close(self) -> None: ...


@dataclass(frozen=True, slots=True)
class CatalogReply:
    result: dict[str, object]
    warnings: list[dict[str, object]]


class QQMusicCatalogSource:
    """Lazy live source. Raw response bodies are normalized in this package."""

    def __init__(
        self, session: QQMusicSession | None = None, *, device_path: Path | str | None = None
    ) -> None:
        self._owns_session = session is None
        if session is None and device_path is None:
            raise ValueError("device_path_required")
        self._session = session if session is not None else QQMusicSession(cast("str", device_path))

    def _get_client(self) -> object:
        return self._session.client()

    async def fetch(self, operation: str, params: Mapping[str, object]) -> Mapping[str, object]:
        try:
            request = self._build_request(operation, params)
            raw = await request
        except Exception as error:
            raise _map_upstream_error(error) from None
        if not isinstance(raw, Mapping):
            raise CatalogFailure(CatalogFailureCode.UPSTREAM_SCHEMA_CHANGED)
        return cast("Mapping[str, object]", raw)

    async def close(self) -> None:
        if self._owns_session:
            await self._session.close()

    def _build_request(self, operation: str, params: Mapping[str, object]) -> Awaitable[object]:
        from qqmusic_api.core.request import Request  # type: ignore[import-untyped]
        from qqmusic_api.modules.search import SearchType  # type: ignore[import-untyped]

        client = cast("Any", self._get_client())
        request: Request[Any]
        if operation == "search.hotkeys":
            request = client.search.get_hotkey()
        elif operation == "search.complete":
            request = client.search.complete(cast("str", params["keyword"]))
        elif operation.startswith("search."):
            search_types = {
                "search.songs": SearchType.SONG,
                "search.artists": SearchType.SINGER,
                "search.albums": SearchType.ALBUM,
                "search.playlists": SearchType.SONGLIST,
            }
            request = client.search.search_by_type(
                cast("str", params["keyword"]),
                search_type=search_types[operation],
                page=cast("int", params["page"]),
                num=cast("int", params["pageSize"]),
                highlight=False,
            )
        elif operation == "recommend.guess":
            request = client.recommend.get_guess_recommend()
        elif operation == "recommend.radar":
            request = client.recommend.get_radar_recommend(page=cast("int", params["page"]))
        elif operation == "recommend.playlists":
            request = client.recommend.get_recommend_songlist(
                page=cast("int", params["page"]), num=cast("int", params["pageSize"])
            )
        elif operation == "recommend.newSongs":
            request = client.recommend.get_recommend_newsong(type=cast("int", params["area"]))
        elif operation == "charts.list":
            request = client.top.get_category()
        elif operation == "charts.detail":
            request = client.top.get_detail(
                cast("int", params["id"]),
                page=cast("int", params["page"]),
                num=cast("int", params["pageSize"]),
            )
        elif operation == "song.detail":
            request = client.song.get_detail(cast("str", params["id"]))
        elif operation == "playlist.detail":
            request = client.songlist.get_detail(
                cast("int", params["id"]),
                dirid=cast("int", params.get("dirId", 0)),
                page=cast("int", params["page"]),
                num=cast("int", params["pageSize"]),
            )
        elif operation == "album.detail":
            request = client.album.get_detail(cast("str", params["id"]))
        elif operation == "album.songs":
            request = client.album.get_song(
                cast("str", params["id"]),
                page=cast("int", params["page"]),
                num=cast("int", params["pageSize"]),
            )
        elif operation == "artist.detail":
            request = client.singer.get_desc([cast("str", params["id"])])
        elif operation == "artist.songs":
            request = client.singer.get_songs_list(
                cast("str", params["id"]),
                page=cast("int", params["page"]),
                num=cast("int", params["pageSize"]),
            )
        elif operation == "artist.albums":
            request = client.singer.get_album_list(
                cast("str", params["id"]),
                page=cast("int", params["page"]),
                num=cast("int", params["pageSize"]),
            )
        elif operation == "lyrics.get":
            request = client.lyric.get_lyric(cast("str", params["id"]), trans=True, roma=True)
        else:  # pragma: no cover - runtime allowlist prevents this
            raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
        return cast("Awaitable[object]", request.replace(response_model=None))


class CatalogService:
    def __init__(self, source: CatalogSource | None = None) -> None:
        self._source = source or QQMusicCatalogSource()

    async def execute(self, operation: str, raw_params: Mapping[str, object]) -> CatalogReply:
        params = _validate_params(operation, raw_params)
        raw = await self._source.fetch(operation, params)
        try:
            return _NORMALIZERS[operation](raw, params)
        except CatalogFailure:
            raise
        except (KeyError, TypeError, ValueError):
            raise CatalogFailure(CatalogFailureCode.UPSTREAM_SCHEMA_CHANGED) from None

    async def close(self) -> None:
        await self._source.close()


def _map_upstream_error(error: Exception) -> CatalogFailure:
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
        return CatalogFailure(CatalogFailureCode.NETWORK_UNAVAILABLE, retryable=True)
    if isinstance(error, RatelimitedError):
        return CatalogFailure(CatalogFailureCode.RATE_LIMITED, retryable=True)
    if isinstance(error, CredentialExpiredError | CredentialInvalidError):
        return CatalogFailure(CatalogFailureCode.AUTHENTICATION_REQUIRED)
    if isinstance(error, ApiDataError | ValidationError | KeyError | TypeError | ValueError):
        return CatalogFailure(CatalogFailureCode.UPSTREAM_SCHEMA_CHANGED)
    if isinstance(error, BaseApiException):
        return CatalogFailure(CatalogFailureCode.UPSTREAM_UNAVAILABLE, retryable=True)
    return CatalogFailure(CatalogFailureCode.UPSTREAM_UNAVAILABLE, retryable=True)


def _validate_params(operation: str, raw: Mapping[str, object]) -> dict[str, object]:
    if operation not in _NORMALIZERS:
        raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
    if (
        operation == "search.hotkeys"
        or operation == "charts.list"
        or operation == "recommend.guess"
    ):
        if raw:
            raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
        return {}

    allowed: set[str]
    params: dict[str, object] = {}
    if operation == "search.complete":
        allowed = {"keyword"}
        params["keyword"] = _keyword(raw.get("keyword"))
    elif operation.startswith("search."):
        allowed = {"keyword", "page", "pageSize"}
        params["keyword"] = _keyword(raw.get("keyword"))
        params.update(_pagination(raw))
    elif operation in {"recommend.radar", "recommend.playlists"}:
        allowed = {"page", "pageSize"} if operation.endswith("playlists") else {"page"}
        params.update(_pagination(raw, default_size=25 if operation.endswith("playlists") else 20))
        if operation == "recommend.radar":
            params.pop("pageSize")
    elif operation == "recommend.newSongs":
        allowed = {"area"}
        area = raw.get("area", 5)
        if type(area) is not int or not 1 <= area <= 6:
            raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
        params["area"] = area
    elif operation in {"song.detail", "album.detail", "artist.detail", "lyrics.get"}:
        allowed = {"id"}
        params["id"] = _stable_id(raw.get("id"), numeric_allowed=True)
    elif operation in {"playlist.detail", "charts.detail"}:
        allowed = {"id", "page", "pageSize"}
        identifier = raw.get("id")
        if type(identifier) is not int or identifier <= 0:
            raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
        params["id"] = identifier
        if operation == "playlist.detail" and "dirId" in raw:
            allowed.add("dirId")
            directory_id = raw.get("dirId")
            if type(directory_id) is not int or directory_id <= 0:
                raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
            params["dirId"] = directory_id
        params.update(_pagination(raw))
    elif operation in {"album.songs", "artist.songs", "artist.albums"}:
        allowed = {"id", "page", "pageSize"}
        params["id"] = _stable_id(raw.get("id"), numeric_allowed=True)
        params.update(_pagination(raw))
    else:
        raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
    if not set(raw).issubset(allowed):
        raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
    return params


def _keyword(value: object) -> str:
    if not isinstance(value, str):
        raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
    value = value.strip()
    if not value or len(value) > _MAX_KEYWORD or any(char in value for char in "\r\n\0"):
        raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
    return value


def _pagination(raw: Mapping[str, object], *, default_size: int = 20) -> dict[str, object]:
    page = raw.get("page", 1)
    page_size = raw.get("pageSize", default_size)
    if type(page) is not int or not 1 <= page <= _MAX_PAGE:
        raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
    if type(page_size) is not int or not 1 <= page_size <= _MAX_PAGE_SIZE:
        raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
    return {"page": page, "pageSize": page_size}


def _stable_id(value: object, *, numeric_allowed: bool = False) -> str:
    if numeric_allowed and type(value) is int and value > 0:
        return str(value)
    if not isinstance(value, str):
        raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
    value = value.strip()
    if not _MID_PATTERN.fullmatch(value):
        raise CatalogFailure(CatalogFailureCode.INVALID_PARAMS)
    return value


def _mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError
    return cast("Mapping[str, object]", value)


def _dig(value: Mapping[str, object], *path: str) -> object:
    current: object = value
    for key in path:
        current = _mapping(current).get(key)
    return current


def _first(value: Mapping[str, object], paths: Sequence[tuple[str, ...]]) -> object:
    for path in paths:
        try:
            candidate = _dig(value, *path)
        except ValueError:
            continue
        if candidate is not None:
            return candidate
    raise ValueError


def _list_at(value: Mapping[str, object], paths: Sequence[tuple[str, ...]]) -> list[object]:
    candidate = _first(value, paths)
    if not isinstance(candidate, list):
        raise ValueError
    return cast("list[object]", candidate)


def _text(value: Mapping[str, object], *keys: str, allow_empty: bool = False) -> str:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, str):
            candidate = _HTML_TAG.sub("", candidate).strip()
            if (
                (candidate or allow_empty)
                and len(candidate) <= _MAX_TEXT
                and not any(char in candidate for char in "\r\n\0")
            ):
                return candidate
    if allow_empty:
        return ""
    raise ValueError


def _entity_id(value: Mapping[str, object], *keys: str) -> str:
    for key in keys:
        candidate = value.get(key)
        if type(candidate) is int and candidate > 0:
            return str(candidate)
        if isinstance(candidate, str) and _MID_PATTERN.fullmatch(candidate.strip()):
            return candidate.strip()
    raise ValueError


def _description(value: Mapping[str, object], *keys: str) -> str:
    """Bounded plain text for biographies; preserve paragraphs rather than titles' rules."""
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, str):
            candidate = re.sub(r"(?i)<br\s*/?>|</p\s*>", "\n", candidate)
            return unescape(_HTML_TAG.sub("", candidate)).replace("\r\n", "\n").replace(
                "\r", "\n"
            ).replace("\0", "").strip()[:4096]
    return ""


def _non_negative(value: object, default: int = 0) -> int:
    return value if type(value) is int and value >= 0 else default


def _cover(value: Mapping[str, object], *, album: bool = False, artist: bool = False) -> str | None:
    for key in ("coverUrl", "picurl", "picUrl", "pic", "logo", "singerPic", "frontPicUrl"):
        candidate = value.get(key)
        if (
            isinstance(candidate, str)
            and candidate.startswith("https://")
            and len(candidate) <= 2_048
        ):
            return candidate
    mid = value.get("mid") or value.get("albumMid") or value.get("singerMid")
    if isinstance(mid, str) and _MID_PATTERN.fullmatch(mid):
        kind = "T002" if album else "T001" if artist else ""
        if kind:
            return f"https://y.gtimg.cn/music/photo_new/{kind}R300x300M000{mid}.jpg"
    return None


def _artist(value: object, *, include_cover: bool = True) -> dict[str, object]:
    item = _mapping(value)
    result: dict[str, object] = {
        "id": _entity_id(
            item,
            "mid",
            "singerMid",
            "singerMID",
            "singer_mid",
            "SingerMid",
            "id",
            "singerId",
            "SingerID",
        ),
        "name": _text(item, "name", "singerName", "Name", "title"),
    }
    if include_cover:
        result["coverUrl"] = _cover(item, artist=True)
    return result


def _album(value: object, *, include_cover: bool = True) -> dict[str, object]:
    item = _mapping(value)
    result: dict[str, object] = {
        "id": _entity_id(item, "mid", "albumMid", "albumMID", "id", "albumID"),
        "title": _text(item, "name", "title", "albumName"),
        "publishDate": _text(item, "time_public", "publishDate", "publish_date", allow_empty=True),
    }
    if include_cover:
        result["coverUrl"] = _cover(item, album=True)
    return result


def _album_cache_key(value: Mapping[str, object]) -> str | None:
    for key in ("mid", "albumMid", "albumMID", "album_mid"):
        candidate = value.get(key)
        if candidate is None:
            continue
        if isinstance(candidate, str) and _MID_PATTERN.fullmatch(candidate.strip()):
            return candidate.strip()
        raise ValueError
    return None


def _song(value: object) -> dict[str, object]:
    item = _mapping(value)
    singers = item.get("singer", item.get("artists"))
    if (
        not isinstance(singers, list)
        or not singers
        or len(singers) > _MAX_ARTISTS_PER_SONG
    ):
        raise ValueError
    artists = [_artist(singer, include_cover=False) for singer in singers]
    album_value = _mapping(item.get("album"))
    album = _album(album_value, include_cover=False)
    cover_cache_key = _album_cache_key(album_value)
    interval = item.get("interval")
    duration_ms = item.get("durationMs")
    if type(duration_ms) is not int:
        duration_ms = _non_negative(interval) * 1_000
    if duration_ms < 0 or duration_ms > 86_400_000:
        raise ValueError
    file_info = item.get("file")
    file_map = _mapping(file_info) if isinstance(file_info, Mapping) else {}
    media_mid_value = file_map.get("media_mid")
    media_mid = None
    if media_mid_value is not None:
        if not isinstance(media_mid_value, str) or not _MID_PATTERN.fullmatch(
            media_mid_value.strip()
        ):
            raise ValueError
        media_mid = media_mid_value.strip()
    pay_info = item.get("pay")
    pay_map = _mapping(pay_info) if isinstance(pay_info, Mapping) else {}
    requires_subscription = bool(
        _non_negative(pay_map.get("pay_play")) or _non_negative(pay_map.get("pay_month"))
    )
    qualities = [
        {
            "quality": quality,
            "available": _non_negative(file_map.get(size_key)) > 0,
            "requiresSubscription": requires_subscription,
        }
        for quality, size_key in (
            ("flac", "size_flac"),
            ("320k", "size_320mp3"),
            ("128k", "size_128mp3"),
        )
    ]
    result: dict[str, object] = {
        "id": _entity_id(item, "mid", "songMid", "id", "songId"),
        "title": _text(item, "name", "title", "title_main"),
        "subtitle": _text(item, "subtitle", "title_extra", allow_empty=True),
        "artists": artists,
        "album": album,
        "durationMs": duration_ms,
        "qualityCandidates": qualities,
        "availability": {
            "status": "unavailable" if _non_negative(item.get("status")) not in (0,) else "unknown",
            "requiresSubscription": requires_subscription,
        },
    }
    if cover_cache_key is not None:
        result["coverCacheKey"] = cover_cache_key
    if media_mid is not None:
        result["mediaMid"] = media_mid
    return result


def _playlist(value: object) -> dict[str, object]:
    item = _mapping(value)
    return {
        "id": _entity_id(item, "id", "tid", "dissid"),
        "title": _text(item, "title", "name", "dissname"),
        "description": _description(item, "desc", "description"),
        "coverUrl": _cover(item),
        "songCount": _non_negative(item.get("songnum", item.get("songNum"))),
        "listenCount": _non_negative(item.get("listennum", item.get("playCnt"))),
    }


def _normalize_items(
    items: list[object], normalizer: Callable[[object], dict[str, object]], entity: str
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    valid: list[dict[str, object]] = []
    warnings: list[dict[str, object]] = []
    for index, item in enumerate(items):
        try:
            valid.append(normalizer(item))
        except (KeyError, TypeError, ValueError):
            warnings.append({"code": "item_invalid", "entity": entity, "index": index})
    return valid, warnings


def _page_result(
    items: list[dict[str, object]],
    warnings: list[dict[str, object]],
    raw: Mapping[str, object],
    params: Mapping[str, object],
) -> CatalogReply:
    page = cast("int", params.get("page", 1))
    page_size = params.get("pageSize", 100)
    if type(page_size) is int:
        items = items[:page_size]
    total_raw: object | None = None
    for key in ("total_num", "totalNum", "total", "sum"):
        if key in raw:
            total_raw = raw[key]
            break
    total = total_raw if type(total_raw) is int and total_raw >= 0 else None
    has_more_raw: object | None = None
    for key in ("hasMore", "hasmore", "has_more", "HasMore"):
        if key in raw:
            has_more_raw = raw[key]
            break
    if has_more_raw is not None:
        has_more = bool(has_more_raw)
    elif "nextpage" in raw:
        next_page = raw["nextpage"]
        has_more = next_page != -1 if type(next_page) is int else False
    elif total is not None and type(page_size) is int:
        has_more = page * page_size < total
    else:
        has_more = False
    result: dict[str, object] = {"items": items, "page": page, "hasMore": has_more}
    if total is not None:
        result["total"] = total
    return CatalogReply(result, warnings)


def _typed_search(
    raw: Mapping[str, object],
    params: Mapping[str, object],
    key: str,
    normalizer: Callable[[object], dict[str, object]],
) -> CatalogReply:
    items = _list_at(raw, (("body", key), (key,)))
    normalized, warnings = _normalize_items(items, normalizer, key)
    meta = raw.get("meta")
    page_meta = _mapping(meta) if isinstance(meta, Mapping) else raw
    return _page_result(normalized, warnings, page_meta, params)


def _search_songs(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
    return _typed_search(raw, params, "item_song", _song)


def _search_artists(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
    return _typed_search(raw, params, "singer", _artist)


def _search_albums(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
    return _typed_search(raw, params, "item_album", _album)


def _search_playlists(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
    return _typed_search(raw, params, "item_songlist", _playlist)


def _hotkeys(raw: Mapping[str, object], _params: Mapping[str, object]) -> CatalogReply:
    items = _list_at(raw, (("hotkey",), ("vec_hotkey",), ("data", "hotkey")))
    values: list[dict[str, object]] = []
    warnings: list[dict[str, object]] = []
    for index, item in enumerate(items):
        try:
            mapped = _mapping(item)
            values.append({"keyword": _text(mapped, "query", "key", "word", "title")})
        except (TypeError, ValueError):
            warnings.append({"code": "item_invalid", "entity": "hotkey", "index": index})
    return CatalogReply({"items": values}, warnings)


def _complete(raw: Mapping[str, object], _params: Mapping[str, object]) -> CatalogReply:
    items = _list_at(raw, (("itemlist",), ("items",), ("data", "itemlist")))
    values: list[dict[str, object]] = []
    warnings: list[dict[str, object]] = []
    for index, item in enumerate(items):
        try:
            mapped = _mapping(item)
            values.append({"keyword": _text(mapped, "word", "query", "key", "name", "hint")})
        except (TypeError, ValueError):
            warnings.append({"code": "item_invalid", "entity": "suggestion", "index": index})
    return CatalogReply({"items": values[:20]}, warnings)


def _song_list(
    paths: Sequence[tuple[str, ...]], entity: str = "song"
) -> Callable[[Mapping[str, object], Mapping[str, object]], CatalogReply]:
    def normalize(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
        items = _list_at(raw, paths)
        unwrapped: list[object] = []
        for item in items:
            if isinstance(item, Mapping):
                item_map = _mapping(item)
                unwrapped.append(item_map.get("Track", item_map.get("songInfo", item)))
            else:
                unwrapped.append(item)
        normalized, warnings = _normalize_items(unwrapped, _song, entity)
        return _page_result(normalized, warnings, raw, params)

    return normalize


def _playlist_list(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
    items = _list_at(raw, (("List",), ("songlists",)))
    unwrapped = []
    for item in items:
        try:
            unwrapped.append(_first(_mapping(item), (("Playlist", "basic"), ("basic",))))
        except ValueError:
            unwrapped.append(item)
    normalized, warnings = _normalize_items(unwrapped, _playlist, "playlist")
    return _page_result(normalized, warnings, raw, params)


def _new_song_list(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
    reply = _song_list((("songlist",), ("songs",)))(raw, {**params, "pageSize": _MAX_PAGE_SIZE})
    # This upstream module has an area filter but no page cursor. Exposing hasMore
    # would promise a page the client cannot request, so the normalized result is
    # a bounded one-shot list.
    reply.result["hasMore"] = False
    return reply


def _chart_list(raw: Mapping[str, object], _params: Mapping[str, object]) -> CatalogReply:
    groups = _list_at(raw, (("group",),))
    result: list[dict[str, object]] = []
    warnings: list[dict[str, object]] = []
    for group_index, group in enumerate(groups):
        try:
            group_map = _mapping(group)
            charts, chart_warnings = _normalize_items(
                _list_at(group_map, (("toplist",),)),
                lambda value: {
                    "id": _entity_id(_mapping(value), "topId", "id"),
                    "title": _text(_mapping(value), "title", "name"),
                    "coverUrl": _cover(_mapping(value)),
                    "updateTime": _text(_mapping(value), "updateTime", allow_empty=True),
                },
                "chart",
            )
            warnings.extend(chart_warnings)
            group_id = group_map.get("groupId", group_map.get("id"))
            if type(group_id) is not int or group_id < 0:
                raise ValueError
            result.append(
                {
                    "id": str(group_id),
                    "title": _text(group_map, "groupName", "name"),
                    "charts": charts,
                }
            )
        except (TypeError, ValueError):
            warnings.append({"code": "item_invalid", "entity": "chart_group", "index": group_index})
    return CatalogReply({"groups": result}, warnings)


def _detail_with_songs(
    raw: Mapping[str, object],
    params: Mapping[str, object],
    info_paths: Sequence[tuple[str, ...]],
    song_paths: Sequence[tuple[str, ...]],
    kind: str,
) -> CatalogReply:
    info = _mapping(_first(raw, info_paths))
    summary = _playlist(info) if kind == "playlist" else _album(info)
    items = _list_at(raw, song_paths)
    normalized, warnings = _normalize_items(items, _song, "song")
    page = _page_result(normalized, warnings, raw, params)
    return CatalogReply({"summary": summary, "songs": page.result}, warnings)


def _song_detail(raw: Mapping[str, object], _params: Mapping[str, object]) -> CatalogReply:
    return CatalogReply({"song": _song(_first(raw, (("track_info",), ("track",))))}, [])


def _playlist_detail(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
    return _detail_with_songs(
        raw, params, (("dirinfo",), ("info",)), (("songlist",), ("songs",)), "playlist"
    )


def _album_detail(raw: Mapping[str, object], _params: Mapping[str, object]) -> CatalogReply:
    album = _mapping(_first(raw, (("basicInfo",), ("album",))))
    return CatalogReply(
        {"album": {**_album(album), "description": _description(album, "desc")}}, []
    )


def _album_songs(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
    items = _list_at(raw, (("songList",), ("song_list",)))
    unwrapped = [
        (_mapping(item).get("songInfo") if isinstance(item, Mapping) else item) for item in items
    ]
    normalized, warnings = _normalize_items(unwrapped, _song, "song")
    return _page_result(normalized, warnings, raw, params)


def _artist_detail(raw: Mapping[str, object], _params: Mapping[str, object]) -> CatalogReply:
    if "singer_list" in raw:
        details = raw["singer_list"]
        if not isinstance(details, list):
            raise ValueError
        if not details:
            return CatalogReply({"artist": None}, [])
        detail = _mapping(details[0])
        artist = _mapping(_first(detail, (("basic_info",),)))
        extra = detail.get("ex_info")
        extra_info = _mapping(extra) if isinstance(extra, Mapping) else {}
        description = _description(extra_info, "desc")
    else:
        artist = _mapping(_first(raw, (("Info", "Singer"), ("singer",))))
        base = _mapping(_first(raw, (("Info", "BaseInfo"), ("base_info",))))
        description = _description(base, "Desc", "desc")
    return CatalogReply(
        {
            "artist": {
                **_artist(artist),
                "description": description,
            }
        },
        [],
    )


def _artist_albums(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
    items = _list_at(raw, (("albumList",), ("album_list",)))
    normalized, warnings = _normalize_items(items, _album, "album")
    return _page_result(normalized, warnings, raw, params)


def _lyrics(raw: Mapping[str, object], params: Mapping[str, object]) -> CatalogReply:
    song_id = raw.get("songID", raw.get("song_id"))
    if type(song_id) is not int or song_id <= 0:
        raise CatalogFailure(CatalogFailureCode.UPSTREAM_SCHEMA_CHANGED)

    crypt = raw.get("crypt", 0)
    if type(crypt) is not int or crypt not in {0, 1}:
        raise CatalogFailure(CatalogFailureCode.UPSTREAM_SCHEMA_CHANGED)

    def lyric_text(key: str) -> str:
        value = raw.get(key, "")
        if not isinstance(value, str) or len(value.encode("utf-8")) > 512_000 or "\0" in value:
            raise CatalogFailure(CatalogFailureCode.UPSTREAM_SCHEMA_CHANGED)
        if crypt == 1 and value:
            value = qrc_decrypt(value)
            if len(value.encode("utf-8")) > 512_000 or "\0" in value:
                raise CatalogFailure(CatalogFailureCode.UPSTREAM_SCHEMA_CHANGED)
        return value

    lyric = lyric_text("lyric")
    if not lyric:
        raise CatalogFailure(CatalogFailureCode.UPSTREAM_SCHEMA_CHANGED)
    return CatalogReply(
        {
            "trackId": params["id"],
            "lyric": lyric,
            "translation": lyric_text("trans"),
            "romanization": lyric_text("roma"),
        },
        [],
    )


_NORMALIZERS: dict[str, Callable[[Mapping[str, object], Mapping[str, object]], CatalogReply]] = {
    "search.hotkeys": _hotkeys,
    "search.complete": _complete,
    "search.songs": _search_songs,
    "search.artists": _search_artists,
    "search.albums": _search_albums,
    "search.playlists": _search_playlists,
    "recommend.guess": _song_list((("tracks",), ("songs",))),
    "recommend.radar": _song_list((("VecSongs",), ("songs",))),
    "recommend.playlists": _playlist_list,
    "recommend.newSongs": _new_song_list,
    "charts.list": _chart_list,
    "charts.detail": _song_list((("songInfoList",), ("songs",))),
    "song.detail": _song_detail,
    "playlist.detail": _playlist_detail,
    "album.detail": _album_detail,
    "album.songs": _album_songs,
    "artist.detail": _artist_detail,
    "artist.songs": _song_list((("songList",), ("song_list",))),
    "artist.albums": _artist_albums,
    "lyrics.get": _lyrics,
}

IMPLEMENTED_CATALOG_METHODS = tuple(_NORMALIZERS)
