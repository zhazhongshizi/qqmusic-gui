"""Stateful provider protocol loop."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from importlib import metadata
from pathlib import Path
from typing import BinaryIO, TextIO

import anyio
from anyio.abc import ObjectSendStream, TaskGroup

from . import FIRST_METHOD, MAX_LINE_BYTES, PROTOCOL_VERSION, PROVIDER_NAME, PROVIDER_VERSION
from .auth import (
    IMPLEMENTED_AUTH_METHODS,
    AuthFailure,
    AuthFailureCode,
    AuthService,
    AuthSource,
    QQMusicAuthSource,
)
from .catalog import (
    IMPLEMENTED_CATALOG_METHODS,
    CatalogFailure,
    CatalogService,
    CatalogSource,
    QQMusicCatalogSource,
)
from .library import (
    IMPLEMENTED_LIBRARY_METHODS,
    PLAYLIST_WRITE_CAPABILITIES,
    LibraryFailure,
    LibraryService,
    LibrarySource,
    QQMusicLibrarySource,
)
from .logging import SafeLogger
from .playback import (
    IMPLEMENTED_PLAYBACK_METHODS,
    PlaybackFailure,
    PlaybackService,
    PlaybackSource,
    QQMusicPlaybackSource,
)
from .protocol import (
    ProtocolViolation,
    Request,
    error_frame,
    event_frame,
    parse_request,
    read_request_line,
    success_frame,
    write_frame,
)
from .session import QQMusicSession

_UPSTREAM_DISTRIBUTION = "qqmusic-api-python"
_UPSTREAM_REQUIRED_VERSION = "0.6.9"
UPSTREAM_TIMEOUT_SECONDS = 15.0
# QR status checks are a background task, not ordinary request/response calls.
# WeChat's upstream check can hold the connection for about 35 seconds.
QR_BACKGROUND_TIMEOUT_SECONDS = 45.0
AUTH_QR_EVENT = "auth.qr"
UPSTREAM_CONCURRENCY = 4
_WRITE_METHODS = frozenset(
    {
        "playlist.create",
        "playlist.delete",
        "playlist.addSongs",
        "playlist.removeSongs",
        "song.like",
        "song.unlike",
        "playlist.favorite",
        "playlist.unfavorite",
    }
)
_IMPLEMENTED_METHODS = (
    FIRST_METHOD,
    "system.ping",
    *IMPLEMENTED_AUTH_METHODS,
    *IMPLEMENTED_PLAYBACK_METHODS,
    *IMPLEMENTED_CATALOG_METHODS,
    *IMPLEMENTED_LIBRARY_METHODS,
)


def _upstream_status() -> dict[str, object]:
    try:
        installed_version: str | None = metadata.version(_UPSTREAM_DISTRIBUTION)
    except metadata.PackageNotFoundError:
        installed_version = None
    return {
        "name": _UPSTREAM_DISTRIBUTION,
        "requiredVersion": _UPSTREAM_REQUIRED_VERSION,
        "installedVersion": installed_version,
    }


def _handshake_result() -> dict[str, object]:
    return {
        "provider": {"name": PROVIDER_NAME, "version": PROVIDER_VERSION, "mode": "live"},
        "protocol": {"version": PROTOCOL_VERSION, "maxLineBytes": MAX_LINE_BYTES},
        "capabilities": {
            "authMethods": ["qq", "wx"],
            "searchTypes": ["songs", "artists", "albums", "playlists"],
            "recommendModules": ["guess", "radar", "newSongs", "playlists", "charts"],
            "playlistWrites": list(PLAYLIST_WRITE_CAPABILITIES),
            "playlistExtensions": {"rename": False, "description": False},
            "lyricVariants": ["original", "translation", "romanization"],
            "qualityCandidates": ["flac", "320k", "128k"],
        },
        "implementedMethods": list(_IMPLEMENTED_METHODS),
        "upstream": _upstream_status(),
    }


class ProviderRuntime:
    def __init__(
        self,
        catalog_source: CatalogSource | None = None,
        auth_source: AuthSource | None = None,
        playback_source: PlaybackSource | None = None,
        library_source: LibrarySource | None = None,
        device_path: Path | str | None = None,
    ) -> None:
        self._handshake_complete = False
        self._seen_request_ids: set[str] = set()
        self._session: QQMusicSession | None = None
        if (
            catalog_source is None
            and auth_source is None
            and playback_source is None
            and library_source is None
        ):
            if device_path is None:
                raise ValueError("device_path_required")
            self._session = QQMusicSession(device_path)
            catalog_source = QQMusicCatalogSource(self._session)
            auth_source = QQMusicAuthSource(self._session)
            playback_source = QQMusicPlaybackSource(self._session)
            library_source = QQMusicLibrarySource(self._session)
        production = self._session is not None
        self._catalog = CatalogService(catalog_source) if production or catalog_source else None
        self._auth = AuthService(auth_source) if production or auth_source else None
        self._playback = PlaybackService(playback_source) if production or playback_source else None
        self._library = LibraryService(library_source) if production or library_source else None
        self._upstream_slots = anyio.Semaphore(UPSTREAM_CONCURRENCY)
        self._admission_gate = anyio.Lock()
        self._write_lock = anyio.Lock()
        self._background_group: TaskGroup | None = None
        self._event_send: ObjectSendStream[dict[str, object]] | None = None
        self._logger: SafeLogger | None = None
        self._qr_generation = 0

    def attach_background(
        self,
        task_group: TaskGroup,
        event_send: ObjectSendStream[dict[str, object]],
    ) -> None:
        """Attach the provider's long-lived task and event output channels."""

        self._background_group = task_group
        self._event_send = event_send

    def attach_logger(self, logger: SafeLogger) -> None:
        self._logger = logger

    async def initialize(self) -> None:
        if self._session is not None:
            await self._session.initialize()

    def admit(self, request: Request) -> None:
        if request.request_id in self._seen_request_ids:
            raise ProtocolViolation("duplicate_request_id")
        self._seen_request_ids.add(request.request_id)

        if not self._handshake_complete:
            if request.method != FIRST_METHOD:
                raise ProtocolViolation("handshake_required")
            if set(request.params) != {"protocolVersion"}:
                raise ProtocolViolation("invalid_handshake")
            requested_version = request.params["protocolVersion"]
            if type(requested_version) is not int or requested_version != PROTOCOL_VERSION:
                raise ProtocolViolation("protocol_version_mismatch")
            self._handshake_complete = True

    async def dispatch(self, request: Request) -> dict[str, object]:
        was_ready = self._handshake_complete
        self.admit(request)
        if request.method == FIRST_METHOD and not was_ready:
            return success_frame(request.request_id, _handshake_result())
        return await self.dispatch_admitted(request)

    async def dispatch_admitted(self, request: Request) -> dict[str, object]:
        if request.method == FIRST_METHOD:
            return error_frame(request.request_id, "handshake_already_complete")

        if request.method == "system.ping":
            if request.params:
                return error_frame(request.request_id, "invalid_params")
            return success_frame(request.request_id, {"pong": True})
        if request.method in IMPLEMENTED_AUTH_METHODS:
            if request.method in {"auth.qr.start", "auth.qr.cancel", "auth.logout"}:
                self._qr_generation += 1
            qr_generation = self._qr_generation
            async with self._exclusive_upstream():
                failed_generation = self._session.generation if self._session is not None else 0
                try:
                    with anyio.fail_after(UPSTREAM_TIMEOUT_SECONDS):
                        response = await self._dispatch_business(request)
                except TimeoutError:
                    # Authentication operations are not replayed: QR polling, restore, refresh
                    # and logout may have reached QQ. Still retire the timed-out client so the
                    # next explicit request does not inherit a poisoned transport.
                    if self._session is not None:
                        await self._session.rebuild_if_current(failed_generation)
                    return error_frame(request.request_id, "upstream_timeout", retryable=True)
            if request.method == "auth.qr.start" and response.get("ok") is True:
                self._start_qr_background(response, qr_generation)
            return response
        if request.method in _WRITE_METHODS:
            return await self._dispatch_write(request)
        if request.method in (
            *IMPLEMENTED_PLAYBACK_METHODS,
            *IMPLEMENTED_CATALOG_METHODS,
            *IMPLEMENTED_LIBRARY_METHODS,
        ):
            return await self._dispatch_read(request)
        return error_frame(request.request_id, "method_not_found")

    async def _dispatch_write(self, request: Request) -> dict[str, object]:
        failed_generation = self._session.generation if self._session is not None else 0
        timed_out = False
        async with self._write_lock, self._upstream_slot():
            try:
                with anyio.fail_after(UPSTREAM_TIMEOUT_SECONDS):
                    return await self._dispatch_business(request)
            except TimeoutError:
                timed_out = True
        if timed_out and self._session is not None:
            # The write may already have reached QQ, so never replay it. Retire the timed-out
            # transport after releasing its slot so later reads do not inherit a poisoned client.
            async with self._exclusive_upstream():
                await self._session.rebuild_if_current(failed_generation)
        return error_frame(request.request_id, "outcome_unknown")

    async def _dispatch_read(self, request: Request) -> dict[str, object]:
        failed_generation = self._session.generation if self._session is not None else 0
        async with self._upstream_slot():
            try:
                with anyio.fail_after(UPSTREAM_TIMEOUT_SECONDS):
                    return await self._dispatch_business(request)
            except TimeoutError:
                pass
        if self._session is None:
            return error_frame(request.request_id, "upstream_timeout", retryable=True)
        async with self._exclusive_upstream():
            await self._session.rebuild_if_current(failed_generation)
        async with self._upstream_slot():
            try:
                with anyio.fail_after(UPSTREAM_TIMEOUT_SECONDS):
                    return await self._dispatch_business(request)
            except TimeoutError:
                return error_frame(request.request_id, "upstream_timeout", retryable=True)

    @asynccontextmanager
    async def _upstream_slot(self) -> AsyncIterator[None]:
        async with self._admission_gate:
            await self._upstream_slots.acquire()
        try:
            yield
        finally:
            self._upstream_slots.release()

    @asynccontextmanager
    async def _exclusive_upstream(self) -> AsyncIterator[None]:
        async with self._admission_gate:
            acquired = 0
            try:
                for _ in range(UPSTREAM_CONCURRENCY):
                    await self._upstream_slots.acquire()
                    acquired += 1
                yield
            finally:
                for _ in range(acquired):
                    self._upstream_slots.release()

    async def _dispatch_business(self, request: Request) -> dict[str, object]:
        if request.method in IMPLEMENTED_AUTH_METHODS:
            if self._auth is None:
                return error_frame(request.request_id, "method_not_found")
            try:
                result = await self._auth.execute(request.method, request.params)
            except AuthFailure as error:
                return error_frame(request.request_id, error.code, retryable=error.retryable)
            return success_frame(request.request_id, result)
        if request.method in IMPLEMENTED_PLAYBACK_METHODS:
            if self._playback is None:
                return error_frame(request.request_id, "method_not_found")
            try:
                playback_reply = await self._playback.execute(request.method, request.params)
            except PlaybackFailure as error:
                return error_frame(request.request_id, error.code, retryable=error.retryable)
            return success_frame(request.request_id, playback_reply.result)
        if request.method in IMPLEMENTED_CATALOG_METHODS:
            if self._catalog is None:
                return error_frame(request.request_id, "method_not_found")
            try:
                catalog_reply = await self._catalog.execute(request.method, request.params)
            except CatalogFailure as error:
                return error_frame(request.request_id, error.code, retryable=error.retryable)
            return success_frame(
                request.request_id,
                catalog_reply.result,
                catalog_reply.warnings,
            )
        if request.method in IMPLEMENTED_LIBRARY_METHODS:
            if self._library is None:
                return error_frame(request.request_id, "method_not_found")
            try:
                library_reply = await self._library.execute(request.method, request.params)
            except LibraryFailure as error:
                return error_frame(request.request_id, error.code, retryable=error.retryable)
            return success_frame(
                request.request_id,
                library_reply.result,
                library_reply.warnings,
            )
        return error_frame(request.request_id, "method_not_found")

    def _start_qr_background(self, response: dict[str, object], generation: int) -> None:
        task_group = self._background_group
        if task_group is None:
            return
        result = response.get("result")
        if not isinstance(result, dict):
            return
        session_id = result.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            return
        task_group.start_soon(self._run_qr_background, session_id, generation)

    async def _run_qr_background(self, session_id: str, generation: int) -> None:
        """Poll one QR session in the provider background and emit state events."""

        while self._qr_generation == generation:
            failed_generation = self._session.generation if self._session is not None else 0
            try:
                async with self._exclusive_upstream():
                    with anyio.fail_after(QR_BACKGROUND_TIMEOUT_SECONDS):
                        result = await self._auth_execute_qr_poll(session_id)
            except TimeoutError:
                if self._session is not None:
                    await self._session.rebuild_if_current(failed_generation)
                await self._emit_qr_event(
                    {
                        "sessionId": session_id,
                        "state": "error",
                        "code": "upstream_timeout",
                        "retryable": True,
                    }
                )
                return
            except AuthFailure as error:
                if self._logger is not None:
                    self._logger.log(
                        "debug",
                        "auth_qr_poll_failed",
                        authCode=error.code,
                        causeCode=error.cause_code or "none",
                    )
                await self._emit_qr_event(
                    {
                        "sessionId": session_id,
                        "state": "error",
                        "code": error.code,
                        "retryable": error.retryable,
                    }
                )
                return
            except Exception:
                await self._emit_qr_event(
                    {
                        "sessionId": session_id,
                        "state": "error",
                        "code": "provider_error",
                        "retryable": True,
                    }
                )
                return

            if self._qr_generation != generation:
                return
            state = result.get("state")
            if not isinstance(state, str):
                await self._emit_qr_event(
                    {
                        "sessionId": session_id,
                        "state": "error",
                        "code": "upstream_schema_changed",
                        "retryable": False,
                    }
                )
                return
            await self._emit_qr_event(result)
            if state in {"authenticated", "expired", "rejected"}:
                return
            if state == "waiting_confirmation":
                await anyio.sleep(0.8)
            elif state == "waiting_scan":
                await anyio.sleep(1.5)
            else:
                await self._emit_qr_event(
                    {
                        "sessionId": session_id,
                        "state": "error",
                        "code": "upstream_schema_changed",
                        "retryable": False,
                    }
                )
                return

    async def _auth_execute_qr_poll(self, session_id: str) -> dict[str, object]:
        if self._auth is None:
            raise AuthFailure(AuthFailureCode.UPSTREAM_UNAVAILABLE, retryable=True)
        return await self._auth.execute("auth.qr.poll", {"sessionId": session_id})

    async def _emit_qr_event(self, payload: dict[str, object]) -> None:
        event_send = self._event_send
        if event_send is None:
            return
        try:
            await event_send.send(event_frame(AUTH_QR_EVENT, payload))
        except (anyio.BrokenResourceError, anyio.ClosedResourceError):
            return

    async def close(self) -> None:
        catalog_error: Exception | None = None
        try:
            if self._catalog is not None:
                await self._catalog.close()
        except Exception as error:
            catalog_error = error
        try:
            if self._auth is not None:
                await self._auth.close()
        except Exception:
            if catalog_error is None:
                catalog_error = RuntimeError("auth_close_failed")
        try:
            if self._playback is not None:
                await self._playback.close()
        except Exception:
            if catalog_error is None:
                catalog_error = RuntimeError("playback_close_failed")
        try:
            if self._library is not None:
                await self._library.close()
        except Exception:
            if catalog_error is None:
                catalog_error = RuntimeError("library_close_failed")
        if self._session is not None:
            try:
                await self._session.close()
            except Exception:
                if catalog_error is None:
                    catalog_error = RuntimeError("session_close_failed")
        if catalog_error is not None:
            raise catalog_error


async def _run(
    stdin: BinaryIO,
    stdout: TextIO,
    stderr: TextIO,
    catalog_source: CatalogSource | None,
    auth_source: AuthSource | None,
    playback_source: PlaybackSource | None,
    library_source: LibrarySource | None,
    device_path: Path | str | None,
) -> int:
    """Run the blocking protocol loop and return a process-style exit code."""

    logger = SafeLogger(stderr)
    runtime = ProviderRuntime(
        catalog_source, auth_source, playback_source, library_source, device_path=device_path
    )
    runtime.attach_logger(logger)
    logger.log("info", "provider_started", providerVersion=PROVIDER_VERSION)
    try:
        await runtime.initialize()
        try:
            return await _serve(stdin, stdout, logger, runtime)
        except ProtocolViolation as error:
            logger.log("error", "protocol_violation", violation=error.code)
            return 2
        except (BrokenPipeError, OSError):
            logger.log("error", "protocol_io_failed")
            return 3
        except BaseExceptionGroup as failure_group:
            failures = _leaf_exceptions(failure_group)
            protocol_failure = next(
                (failure for failure in failures if isinstance(failure, ProtocolViolation)), None
            )
            if isinstance(protocol_failure, ProtocolViolation):
                logger.log(
                    "error", "protocol_violation", violation=protocol_failure.code
                )
                return 2
            if any(isinstance(failure, BrokenPipeError | OSError) for failure in failures):
                logger.log("error", "protocol_io_failed")
                return 3
            leaf_failure = failures[0]
            logger.log(
                "error", "provider_internal_error", errorType=type(leaf_failure).__name__
            )
            return 4
        except Exception as error:  # pragma: no cover - last-resort process containment
            logger.log("error", "provider_internal_error", errorType=type(error).__name__)
            return 4
    finally:
        try:
            await runtime.close()
        except Exception:  # pragma: no cover - defensive shutdown containment
            logger.log("error", "provider_close_failed")


def _leaf_exceptions(group: BaseExceptionGroup) -> list[BaseException]:
    leaves: list[BaseException] = []
    for error in group.exceptions:
        if isinstance(error, BaseExceptionGroup):
            leaves.extend(_leaf_exceptions(error))
        else:
            leaves.append(error)
    return leaves


async def _serve(
    stdin: BinaryIO, stdout: TextIO, logger: SafeLogger, runtime: ProviderRuntime
) -> int:
    first_payload = await anyio.to_thread.run_sync(read_request_line, stdin)
    if first_payload is None:
        logger.log("info", "stdin_closed")
        return 0
    first_request = parse_request(first_payload)
    first_response = await runtime.dispatch(first_request)
    write_frame(stdout, first_response)

    send, receive = anyio.create_memory_object_stream[dict[str, object]](UPSTREAM_CONCURRENCY * 2)

    async def write_responses() -> None:
        async with receive:
            async for response in receive:
                write_frame(stdout, response)

    async def execute(request: Request) -> None:
        response = await runtime.dispatch_admitted(request)
        await send.send(response)

    async with anyio.create_task_group() as writer_group:
        writer_group.start_soon(write_responses)
        async with anyio.create_task_group() as background_group:
            runtime.attach_background(background_group, send)
            async with anyio.create_task_group() as request_group:
                while True:
                    payload = await anyio.to_thread.run_sync(read_request_line, stdin)
                    if payload is None:
                        logger.log("info", "stdin_closed")
                        break
                    request = parse_request(payload)
                    runtime.admit(request)
                    request_group.start_soon(execute, request)
            background_group.cancel_scope.cancel()
        await send.aclose()
    return 0


def run(
    stdin: BinaryIO,
    stdout: TextIO,
    stderr: TextIO,
    catalog_source: CatalogSource | None = None,
    auth_source: AuthSource | None = None,
    playback_source: PlaybackSource | None = None,
    library_source: LibrarySource | None = None,
    device_path: Path | str | None = None,
) -> int:
    """Run the protocol loop in one AnyIO lifetime so the upstream session stays stable."""

    return anyio.run(
        _run,
        stdin,
        stdout,
        stderr,
        catalog_source,
        auth_source,
        playback_source,
        library_source,
        device_path,
    )
