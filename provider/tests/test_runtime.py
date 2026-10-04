from __future__ import annotations

import io
import json
from collections.abc import Mapping
from pathlib import Path

import anyio
import pytest
from jsonschema import Draft202012Validator

from qqmusic_provider import MAX_LINE_BYTES
from qqmusic_provider.auth import AuthSource, QrArtifact, QrCheck
from qqmusic_provider.catalog import CatalogSource
from qqmusic_provider.library import LibrarySource
from qqmusic_provider.logging import SafeLogger
from qqmusic_provider.protocol import Request
from qqmusic_provider.runtime import ProviderRuntime, run

_ROOT = Path(__file__).resolve().parents[2]
_FIXTURES = _ROOT / "tests" / "fixtures" / "provider-v1"
_SCHEMA = json.loads((_ROOT / "contracts" / "protocol-v1.schema.json").read_text(encoding="utf-8"))
_PROTOCOL_VALIDATOR = Draft202012Validator(_SCHEMA)


class _OfflineCatalog(CatalogSource):
    async def fetch(self, operation: str, params: Mapping[str, object]) -> Mapping[str, object]:
        assert operation == "search.songs"
        assert params == {"keyword": "晴天", "page": 1, "pageSize": 20}
        return {
            "meta": {"nextpage": -1, "sum": 1},
            "body": {
                "item_song": [
                    {
                        "id": 1,
                        "mid": "fixture-song-001",
                        "name": "晴天",
                        "singer": [{"id": 2, "mid": "artist-1", "name": "周杰伦"}],
                        "album": {"id": 3, "mid": "album-1", "name": "叶惠美"},
                        "interval": 269,
                        "file": {"size_128mp3": 1, "size_320mp3": 1, "size_flac": 0},
                        "pay": {},
                        "status": 0,
                    }
                ]
            },
        }

    async def close(self) -> None:
        return None


class _FailingCloseCatalog(_OfflineCatalog):
    async def close(self) -> None:
        raise RuntimeError("Cookie=SENTINEL_CLOSE_SECRET")


class _SlowCatalog(_OfflineCatalog):
    async def fetch(self, operation: str, params: Mapping[str, object]) -> Mapping[str, object]:
        await anyio.sleep(0.05)
        return await super().fetch(operation, params)


class _EventAuth(AuthSource):
    def __init__(self) -> None:
        self.checks = [QrCheck("expired")]

    async def start_qr(self, login_method: str) -> QrArtifact:
        return QrArtifact(b"png-fixture", "image/png", {"method": login_method})

    async def check_qr(self, handle: object) -> QrCheck:
        assert handle == {"method": "qq"}
        return self.checks.pop(0)

    async def restore(self, credential: Mapping[str, object]) -> None:
        return None

    async def check_credential(self) -> bool:
        return False

    async def refresh_credential(self) -> Mapping[str, object]:
        return {}

    async def logout(self) -> None:
        return None

    async def close(self) -> None:
        return None


class _RebuildTrackingSession:
    def __init__(self) -> None:
        self.generation = 1
        self.rebuild_calls: list[int] = []

    async def rebuild_if_current(self, failed_generation: int) -> int:
        self.rebuild_calls.append(failed_generation)
        if failed_generation == self.generation:
            self.generation += 1
        return self.generation

    async def close(self) -> None:
        return None


class _TimeoutWriteThenReadLibrary(LibrarySource):
    def __init__(self, session: _RebuildTrackingSession) -> None:
        self.session = session
        self.write_calls = 0
        self.read_generations: list[int] = []

    async def execute(self, operation: str, params: Mapping[str, object]) -> Mapping[str, object]:
        if operation == "playlist.create":
            self.write_calls += 1
            await anyio.sleep(1)
            return {"succeeded": True, "playlistId": 991, "editableId": 88, "name": "late"}
        assert operation == "library.playlists"
        self.read_generations.append(self.session.generation)
        return {"total": 0, "finished": True, "playlists": []}

    async def close(self) -> None:
        return None


def _execute(payload: bytes) -> tuple[int, list[dict[str, object]], str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    exit_code = run(io.BytesIO(payload), stdout, stderr, _OfflineCatalog())
    frames = [json.loads(line) for line in stdout.getvalue().splitlines()]
    for frame in frames:
        _PROTOCOL_VALIDATOR.validate(frame)
    return exit_code, frames, stderr.getvalue()


def test_handshake_ping_and_offline_catalog_search() -> None:
    payload = (_FIXTURES / "valid-requests.ndjson").read_bytes()

    exit_code, frames, stderr = _execute(payload)

    assert exit_code == 0
    assert [frame["id"] for frame in frames] == ["hello-1", "ping-1", "search-1"]
    assert frames[0]["result"]["protocol"] == {"version": 1, "maxLineBytes": MAX_LINE_BYTES}
    assert frames[0]["result"]["provider"]["mode"] == "live"
    assert frames[0]["result"]["capabilities"]["searchTypes"] == [
        "songs",
        "artists",
        "albums",
        "playlists",
    ]
    assert frames[0]["result"]["capabilities"]["playlistWrites"] == [
        "create",
        "delete",
        "addSongs",
        "removeSongs",
        "likeSong",
        "unlikeSong",
        "favoritePlaylist",
        "unfavoritePlaylist",
    ]
    assert frames[1]["result"] == {"pong": True}
    assert frames[2]["result"]["items"][0]["title"] == "晴天"
    assert frames[2]["warnings"] == []
    assert "provider_started" in stderr


@pytest.mark.anyio
async def test_qr_start_uses_background_task_and_emits_state_event() -> None:
    runtime = ProviderRuntime(auth_source=_EventAuth())
    send, receive = anyio.create_memory_object_stream[dict[str, object]](4)
    async with anyio.create_task_group() as group:
        runtime.attach_background(group, send)
        await runtime.dispatch(
            Request("hello", "system.handshake", {"protocolVersion": 1})
        )
        response = await runtime.dispatch_admitted(
            Request("start", "auth.qr.start", {"loginMethod": "qq"})
        )
        assert response["ok"] is True
        with anyio.fail_after(1):
            frame = await receive.receive()
        assert frame["event"] == "auth.qr"
        assert frame["payload"]["state"] == "expired"
        group.cancel_scope.cancel()
    await send.aclose()


def test_slow_request_does_not_block_later_ping() -> None:
    handshake = b'{"v":1,"id":"h","method":"system.handshake","params":{"protocolVersion":1}}\n'
    search = (
        b'{"v":1,"id":"slow","method":"search.songs","params":{'
        b'"keyword":"\xe6\x99\xb4\xe5\xa4\xa9","page":1,"pageSize":20}}\n'
    )
    ping = b'{"v":1,"id":"fast","method":"system.ping","params":{}}\n'
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = run(io.BytesIO(handshake + search + ping), stdout, stderr, _SlowCatalog())
    frames = [json.loads(line) for line in stdout.getvalue().splitlines()]

    assert exit_code == 0
    assert [frame["id"] for frame in frames] == ["h", "fast", "slow"]


def test_first_request_must_be_handshake() -> None:
    exit_code, frames, stderr = _execute(
        b'{"v":1,"id":"ping-1","method":"system.ping","params":{}}\n'
    )

    assert exit_code == 2
    assert frames == []
    assert "handshake_required" in stderr


def test_duplicate_request_id_is_fatal() -> None:
    handshake = b'{"v":1,"id":"same","method":"system.handshake","params":{"protocolVersion":1}}\n'
    ping = b'{"v":1,"id":"same","method":"system.ping","params":{}}\n'

    exit_code, frames, stderr = _execute(handshake + ping)

    assert exit_code == 2
    assert len(frames) == 1
    assert "duplicate_request_id" in stderr


def test_second_handshake_returns_stable_nonfatal_error() -> None:
    first = b'{"v":1,"id":"h1","method":"system.handshake","params":{"protocolVersion":1}}\n'
    second = b'{"v":1,"id":"h2","method":"system.handshake","params":{"protocolVersion":1}}\n'

    exit_code, frames, _stderr = _execute(first + second)

    assert exit_code == 0
    assert frames[1]["error"] == {"code": "handshake_already_complete", "retryable": False}


def test_source_close_failure_is_contained_and_redacted() -> None:
    stdout = io.StringIO()
    stderr = io.StringIO()
    handshake = b'{"v":1,"id":"h","method":"system.handshake","params":{"protocolVersion":1}}\n'

    exit_code = run(io.BytesIO(handshake), stdout, stderr, _FailingCloseCatalog())

    assert exit_code == 0
    assert "provider_close_failed" in stderr.getvalue()
    assert "SENTINEL_CLOSE_SECRET" not in stderr.getvalue()


def test_version_mismatch_fixture_is_fatal() -> None:
    exit_code, frames, stderr = _execute((_FIXTURES / "version-mismatch.ndjson").read_bytes())

    assert exit_code == 2
    assert frames == []
    assert "protocol_version_mismatch" in stderr


def test_invalid_utf8_fixture_is_fatal() -> None:
    hex_payload = (_FIXTURES / "invalid-utf8.hex").read_text(encoding="ascii")
    payload = bytes.fromhex("".join(line.split("#", 1)[0] for line in hex_payload.splitlines()))

    exit_code, frames, stderr = _execute(payload)

    assert exit_code == 2
    assert frames == []
    assert "invalid_utf8" in stderr


def test_oversized_line_is_fatal() -> None:
    recipe = json.loads((_FIXTURES / "oversized-line.json").read_text(encoding="utf-8"))
    payload = recipe["byte"].encode("ascii") * (MAX_LINE_BYTES + recipe["extraBytes"]) + b"\n"

    exit_code, frames, stderr = _execute(payload)

    assert exit_code == 2
    assert frames == []
    assert "line_too_long" in stderr


def test_excessive_json_nesting_is_a_stable_protocol_violation() -> None:
    nested = "[" * 5_000 + "0" + "]" * 5_000
    payload = (
        '{"v":1,"id":"deep","method":"system.handshake","params":{"protocolVersion":1,'
        '"nested":' + nested + "}}\n"
    ).encode()

    exit_code, frames, stderr = _execute(payload)

    assert exit_code == 2
    assert frames == []
    assert "json_nesting_too_deep" in stderr


def test_unknown_method_and_invalid_params_return_stable_errors() -> None:
    handshake = b'{"v":1,"id":"h","method":"system.handshake","params":{"protocolVersion":1}}\n'
    unknown = b'{"v":1,"id":"u","method":"arbitrary.execute","params":{}}\n'
    invalid = b'{"v":1,"id":"s","method":"search.songs","params":{"keyword":""}}\n'

    exit_code, frames, _stderr = _execute(handshake + unknown + invalid)

    assert exit_code == 0
    assert frames[1]["error"] == {"code": "method_not_found", "retryable": False}
    assert frames[2]["error"] == {"code": "invalid_params", "retryable": False}


@pytest.mark.anyio
async def test_timed_out_write_is_not_replayed_and_rebuilds_before_the_next_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("qqmusic_provider.runtime.UPSTREAM_TIMEOUT_SECONDS", 0.01)
    session = _RebuildTrackingSession()
    library = _TimeoutWriteThenReadLibrary(session)
    runtime = ProviderRuntime(library_source=library)
    runtime._session = session  # type: ignore[assignment]  # Inject the production lifecycle seam.

    write = await runtime.dispatch_admitted(
        Request("write-1", "playlist.create", {"name": "timeout fixture"})
    )
    read = await runtime.dispatch_admitted(
        Request(
            "read-1",
            "library.playlists",
            {"kind": "created", "page": 1, "pageSize": 20},
        )
    )

    assert write["ok"] is False
    assert write["error"] == {"code": "outcome_unknown", "retryable": False}
    assert library.write_calls == 1
    assert session.rebuild_calls == [1]
    assert session.generation == 2
    assert read["ok"] is True
    assert library.read_generations == [2]


def test_stderr_logger_redacts_secret_fields_and_inline_values() -> None:
    stderr = io.StringIO()
    logger = SafeLogger(stderr)

    logger.log(
        "error",
        "sample",
        token="SENTINEL_TOKEN",
        detail=(
            "Cookie: uin=SENTINEL_UIN; p_skey=SENTINEL_PSKEY; qqmusic_key=SENTINEL_QQMUSIC_KEY"
        ),
        nested={
            "password": "SENTINEL_PASSWORD",
            "openid": "SENTINEL_OPENID",
            "musickey": "SENTINEL_MUSICKEY",
            "refresh_key": "SENTINEL_REFRESH_KEY",
            "qrsig": "SENTINEL_QRSIG",
        },
        upstream=(
            "openid=SENTINEL_INLINE_OPENID refresh_key=SENTINEL_INLINE_REFRESH_KEY "
            "musickey=SENTINEL_INLINE_MUSICKEY"
        ),
    )

    logged = stderr.getvalue()
    assert "SENTINEL" not in logged
    assert "sample" in logged
    assert logged.count("[REDACTED]") >= 8
