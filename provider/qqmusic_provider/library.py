"""Authenticated QQ Music library reads and allowlisted playlist writes."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Protocol, cast

from .catalog import _normalize_items, _playlist, _song
from .session import QQMusicSession

IMPLEMENTED_LIBRARY_METHODS = (
    "library.playlists",
    "library.liked",
    "playlist.create",
    "playlist.delete",
    "playlist.addSongs",
    "playlist.removeSongs",
    "song.like",
    "song.unlike",
    "playlist.favorite",
    "playlist.unfavorite",
)

PLAYLIST_WRITE_CAPABILITIES = (
    "create",
    "delete",
    "addSongs",
    "removeSongs",
    "likeSong",
    "unlikeSong",
    "favoritePlaylist",
    "unfavoritePlaylist",
)

_READ_METHODS = frozenset({"library.playlists", "library.liked"})
_MAX_PAGE = 100
_MAX_PAGE_SIZE = 50
_MAX_WRITE_SONGS = 100
_MAX_PLAYLIST_NAME = 100
_MAX_STABLE_ID = 128


class LibraryFailureCode(str, Enum):
    INVALID_PARAMS = "invalid_params"
    NETWORK_UNAVAILABLE = "network_unavailable"
    RATE_LIMITED = "rate_limited"
    AUTHENTICATION_REQUIRED = "authentication_required"
    WRITE_REJECTED = "write_rejected"
    UPSTREAM_SCHEMA_CHANGED = "upstream_schema_changed"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"


class LibraryFailure(Exception):
    def __init__(self, code: LibraryFailureCode, *, retryable: bool = False) -> None:
        super().__init__(code.value)
        self.code = code.value
        self.retryable = retryable


class LibrarySource(Protocol):
    async def execute(
        self, operation: str, params: Mapping[str, object]
    ) -> Mapping[str, object]: ...

    async def close(self) -> None: ...


@dataclass(frozen=True, slots=True)
class LibraryReply:
    result: dict[str, object]
    warnings: list[dict[str, object]]


class QQMusicLibrarySource:
    """Live adapter. Credentials stay inside the shared provider session."""

    def __init__(
        self, session: QQMusicSession | None = None, *, device_path: Path | str | None = None
    ) -> None:
        self._owns_session = session is None
        if session is None and device_path is None:
            raise ValueError("device_path_required")
        self._session = session if session is not None else QQMusicSession(cast("str", device_path))

    async def execute(self, operation: str, params: Mapping[str, object]) -> Mapping[str, object]:
        client = cast("Any", self._session.client())
        credential = client.credential
        if not (
            getattr(credential, "musicid", 0)
            and getattr(credential, "musickey", "")
            and getattr(credential, "encrypt_uin", "")
        ):
            raise LibraryFailure(LibraryFailureCode.AUTHENTICATION_REQUIRED)

        try:
            if operation == "library.playlists":
                if params["kind"] == "created":
                    response = await client.user.get_created_songlist(
                        credential.musicid, credential=credential
                    )
                else:
                    response = await client.user.get_fav_songlist(
                        credential.encrypt_uin,
                        page=cast("int", params["page"]),
                        num=cast("int", params["pageSize"]),
                        credential=credential,
                    )
                return _model_payload(response)
            if operation == "library.liked":
                response = await client.user.get_fav_song(
                    credential.encrypt_uin,
                    page=cast("int", params["page"]),
                    num=cast("int", params["pageSize"]),
                    credential=credential,
                )
                return _model_payload(response)
            if operation == "playlist.create":
                response = await client.songlist.create(
                    cast("str", params["name"]), credential=credential
                )
                return {
                    "succeeded": getattr(response, "retCode", None) == 0,
                    "playlistId": getattr(response, "id", None),
                    "editableId": getattr(response, "dirid", None),
                    "name": getattr(response, "name", None),
                }
            if operation == "playlist.delete":
                response = await client.songlist.delete(
                    cast("int", params["playlistId"]), credential=credential
                )
                return {"succeeded": getattr(response, "retCode", None) == 0}
            if operation in {
                "playlist.addSongs",
                "playlist.removeSongs",
                "song.like",
                "song.unlike",
            }:
                song_info = await _resolve_song_info(client, cast("list[str]", params["songIds"]))
                if operation == "playlist.addSongs":
                    succeeded = await client.songlist.add_songs(
                        cast("int", params["playlistId"]), song_info, credential=credential
                    )
                elif operation == "playlist.removeSongs":
                    succeeded = await client.songlist.del_songs(
                        cast("int", params["playlistId"]), song_info, credential=credential
                    )
                elif operation == "song.like":
                    succeeded = await client.songlist.like_song(song_info, credential=credential)
                else:
                    succeeded = await client.songlist.unlike_song(song_info, credential=credential)
                return {"succeeded": succeeded, "affectedCount": len(song_info)}
            if operation in {"playlist.favorite", "playlist.unfavorite"}:
                playlist_id = cast("int", params["playlistId"])
                if operation == "playlist.favorite":
                    succeeded = await client.user.fav_songlist(playlist_id, credential=credential)
                else:
                    succeeded = await client.user.unfav_songlist(playlist_id, credential=credential)
                return {"succeeded": succeeded}
        except LibraryFailure:
            raise
        except Exception as error:
            raise _map_upstream_error(error) from None
        raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)

    async def close(self) -> None:
        if self._owns_session:
            await self._session.close()


class LibraryService:
    def __init__(self, source: LibrarySource | None = None) -> None:
        self._source = source or QQMusicLibrarySource()

    async def execute(self, operation: str, raw_params: Mapping[str, object]) -> LibraryReply:
        params = _validate_params(operation, raw_params)
        raw = await self._source.execute(operation, params)
        try:
            if operation == "library.playlists":
                return _normalize_playlists(raw, params)
            if operation == "library.liked":
                return _normalize_liked(raw, params)
            return LibraryReply(_normalize_write(operation, raw, params), [])
        except LibraryFailure:
            raise
        except (KeyError, TypeError, ValueError):
            raise LibraryFailure(LibraryFailureCode.UPSTREAM_SCHEMA_CHANGED) from None

    async def close(self) -> None:
        await self._source.close()


def _validate_params(operation: str, raw: Mapping[str, object]) -> dict[str, object]:
    if operation not in IMPLEMENTED_LIBRARY_METHODS:
        raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
    if operation == "library.playlists":
        if not set(raw).issubset({"kind", "page", "pageSize"}):
            raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
        kind = raw.get("kind")
        if kind not in {"created", "favorite"}:
            raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
        return {"kind": kind, **_pagination(raw)}
    if operation == "library.liked":
        if not set(raw).issubset({"page", "pageSize"}):
            raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
        return _pagination(raw)
    if operation == "playlist.create":
        if set(raw) != {"name"}:
            raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
        name = raw.get("name")
        if not isinstance(name, str):
            raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
        name = name.strip()
        if (
            not name
            or len(name) > _MAX_PLAYLIST_NAME
            or any(character in name for character in "\r\n\0")
        ):
            raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
        return {"name": name}
    if operation in {
        "playlist.delete",
        "playlist.favorite",
        "playlist.unfavorite",
    }:
        if set(raw) != {"playlistId"}:
            raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
        return {"playlistId": _positive_int(raw.get("playlistId"))}
    if operation in {"playlist.addSongs", "playlist.removeSongs"}:
        if set(raw) != {"playlistId", "songIds"}:
            raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
        return {
            "playlistId": _positive_int(raw.get("playlistId")),
            "songIds": _song_ids(raw.get("songIds")),
        }
    if operation in {"song.like", "song.unlike"}:
        if set(raw) != {"songIds"}:
            raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
        return {"songIds": _song_ids(raw.get("songIds"))}
    raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)


def _pagination(raw: Mapping[str, object]) -> dict[str, object]:
    page = raw.get("page", 1)
    page_size = raw.get("pageSize", 20)
    if type(page) is not int or not 1 <= page <= _MAX_PAGE:
        raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
    if type(page_size) is not int or not 1 <= page_size <= _MAX_PAGE_SIZE:
        raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
    return {"page": page, "pageSize": page_size}


def _positive_int(value: object) -> int:
    if type(value) is not int or value <= 0:
        raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
    return value


def _song_ids(value: object) -> list[str]:
    if not isinstance(value, list) or not value or len(value) > _MAX_WRITE_SONGS:
        raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
    song_ids: list[str] = []
    for item in value:
        if (
            not isinstance(item, str)
            or not item
            or len(item) > _MAX_STABLE_ID
            or not all(character.isalnum() or character in "_-" for character in item)
            or item in song_ids
        ):
            raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
        song_ids.append(item)
    if any(identifier.isdecimal() for identifier in song_ids) and not all(
        identifier.isdecimal() for identifier in song_ids
    ):
        raise LibraryFailure(LibraryFailureCode.INVALID_PARAMS)
    return song_ids


def _normalize_playlists(raw: Mapping[str, object], params: Mapping[str, object]) -> LibraryReply:
    items = raw.get("playlists", raw.get("v_playlist", raw.get("v_list")))
    if not isinstance(items, list):
        raise ValueError
    created = params["kind"] == "created"

    def normalize_playlist(value: object) -> dict[str, object]:
        playlist = _playlist(value)
        mapped = cast("Mapping[str, object]", value)
        editable_id = mapped.get("dirid", mapped.get("dirId")) if created else None
        if created and (type(editable_id) is not int or editable_id <= 0):
            raise ValueError
        playlist["editableId"] = str(editable_id) if created else None
        return playlist

    normalized, warnings = _normalize_items(items, normalize_playlist, "playlist")
    page = cast("int", params["page"])
    page_size = cast("int", params["pageSize"])
    normalized_total = len(normalized)
    if created:
        start = (page - 1) * page_size
        normalized = normalized[start : start + page_size]
    else:
        normalized = normalized[:page_size]
    total_raw = raw.get("total")
    total = total_raw if type(total_raw) is int and total_raw >= 0 else normalized_total
    has_more_raw = raw.get("hasmore")
    has_more = bool(has_more_raw) if has_more_raw is not None else page * page_size < total
    return LibraryReply(
        {
            "kind": params["kind"],
            "items": normalized,
            "page": page,
            "hasMore": has_more,
            "total": total,
        },
        warnings,
    )


def _normalize_liked(raw: Mapping[str, object], params: Mapping[str, object]) -> LibraryReply:
    items = raw.get("songs", raw.get("songlist"))
    if not isinstance(items, list):
        raise ValueError
    normalized, warnings = _normalize_items(items, _song, "song")
    page_size = cast("int", params["pageSize"])
    total_raw = raw.get("total", raw.get("total_song_num"))
    total = total_raw if type(total_raw) is int and total_raw >= 0 else len(normalized)
    has_more_raw = raw.get("hasmore")
    return LibraryReply(
        {
            "items": normalized[:page_size],
            "page": params["page"],
            "hasMore": bool(has_more_raw) if has_more_raw is not None else False,
            "total": total,
        },
        warnings,
    )


def _normalize_write(
    operation: str, raw: Mapping[str, object], params: Mapping[str, object]
) -> dict[str, object]:
    if not isinstance(raw.get("succeeded"), bool):
        raise ValueError
    if not raw["succeeded"]:
        raise LibraryFailure(LibraryFailureCode.WRITE_REJECTED)
    result: dict[str, object] = {"status": "applied"}
    if operation == "playlist.create":
        playlist_id = raw.get("playlistId")
        editable_id = raw.get("editableId")
        name = raw.get("name")
        if (
            type(playlist_id) is not int
            or playlist_id <= 0
            or type(editable_id) is not int
            or editable_id <= 0
            or not isinstance(name, str)
        ):
            raise ValueError
        result["playlist"] = {
            "id": str(playlist_id),
            "editableId": str(editable_id),
            "title": name,
        }
    if operation in {
        "playlist.addSongs",
        "playlist.removeSongs",
        "song.like",
        "song.unlike",
    }:
        affected = raw.get("affectedCount")
        if type(affected) is not int or affected != len(cast("list[str]", params["songIds"])):
            raise ValueError
        result["affectedCount"] = affected
    return result


async def _resolve_song_info(client: Any, song_ids: list[str]) -> list[tuple[int, int]]:
    lookup: list[int] | list[str]
    lookup = [int(identifier) for identifier in song_ids] if song_ids[0].isdecimal() else song_ids
    response = await client.song.query_song(lookup)
    tracks = getattr(response, "tracks", None)
    if not isinstance(tracks, list) or len(tracks) != len(song_ids):
        raise LibraryFailure(LibraryFailureCode.UPSTREAM_SCHEMA_CHANGED)
    resolved: list[tuple[int, int]] = []
    returned_ids: list[str] = []
    for track in tracks:
        song_id = getattr(track, "id", None)
        song_type = getattr(track, "type", None)
        if type(song_id) is not int or song_id <= 0 or type(song_type) is not int or song_type < 0:
            raise LibraryFailure(LibraryFailureCode.UPSTREAM_SCHEMA_CHANGED)
        resolved.append((song_id, song_type))
        returned = str(song_id) if song_ids[0].isdecimal() else getattr(track, "mid", None)
        if not isinstance(returned, str):
            raise LibraryFailure(LibraryFailureCode.UPSTREAM_SCHEMA_CHANGED)
        returned_ids.append(returned)
    if sorted(returned_ids) != sorted(song_ids) or len(set(returned_ids)) != len(returned_ids):
        raise LibraryFailure(LibraryFailureCode.UPSTREAM_SCHEMA_CHANGED)
    return resolved


def _model_payload(value: object) -> Mapping[str, object]:
    try:
        payload = cast("Any", value).model_dump(mode="json")
    except Exception as error:
        raise _map_upstream_error(error) from None
    if not isinstance(payload, Mapping):
        raise LibraryFailure(LibraryFailureCode.UPSTREAM_SCHEMA_CHANGED)
    return cast("Mapping[str, object]", payload)


def _map_upstream_error(error: Exception) -> LibraryFailure:
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
        return LibraryFailure(LibraryFailureCode.NETWORK_UNAVAILABLE, retryable=True)
    if isinstance(error, RatelimitedError):
        return LibraryFailure(LibraryFailureCode.RATE_LIMITED, retryable=True)
    if isinstance(error, CredentialExpiredError | CredentialInvalidError):
        return LibraryFailure(LibraryFailureCode.AUTHENTICATION_REQUIRED)
    if isinstance(error, ApiDataError | ValidationError | KeyError | TypeError | ValueError):
        return LibraryFailure(LibraryFailureCode.UPSTREAM_SCHEMA_CHANGED)
    if isinstance(error, BaseApiException):
        return LibraryFailure(LibraryFailureCode.UPSTREAM_UNAVAILABLE, retryable=True)
    return LibraryFailure(LibraryFailureCode.UPSTREAM_UNAVAILABLE, retryable=True)
