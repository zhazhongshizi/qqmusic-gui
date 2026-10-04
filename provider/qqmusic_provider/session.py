"""Lifecycle boundary for the single QQMusicApi client."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

import anyio


class SessionCompatibilityFailure(RuntimeError):
    """The pinned upstream client no longer exposes a required transport control."""


class SessionConfigurationFailure(RuntimeError):
    """The trusted host did not provide a usable device-state path."""


ClientFactory = Callable[[str], Any]


class QQMusicSession:
    """Own, validate and replace the sole upstream client."""

    def __init__(
        self,
        device_path: Path | str,
        *,
        client_factory: ClientFactory | None = None,
    ) -> None:
        raw_path = Path(device_path)
        if not raw_path.is_absolute():
            raise SessionConfigurationFailure("device_path_not_absolute")
        self._device_path = raw_path.resolve()
        self._client_factory = client_factory or self._default_client_factory
        self._client: Any | None = None
        self._generation = 0
        self._rebuild_lock = anyio.Lock()
        self._closed = False

    @staticmethod
    def _default_client_factory(device_path: str) -> Any:
        from qqmusic_api import Client  # type: ignore[import-untyped]

        return Client(device_path=device_path, connect_retries=2)

    @property
    def generation(self) -> int:
        return self._generation

    async def initialize(self) -> None:
        async with self._rebuild_lock:
            if self._closed:
                raise RuntimeError("session_closed")
            if self._client is None:
                self._client = await self._create_client(None)
                self._generation = 1

    def client(self) -> Any:
        if self._client is None:
            raise RuntimeError("session_not_initialized")
        return self._client

    async def rebuild_if_current(self, failed_generation: int) -> int:
        async with self._rebuild_lock:
            if self._closed:
                raise RuntimeError("session_closed")
            if self._generation != failed_generation:
                return self._generation
            old_client = self.client()
            credential = old_client.credential
            new_client = await self._create_client(credential)
            self._client = new_client
            self._generation += 1
            with suppress(Exception):
                await old_client.close()
            return self._generation

    async def _create_client(self, credential: object | None) -> Any:
        client = self._client_factory(str(self._device_path))
        try:
            transport = getattr(client, "_session", None)
            if transport is None or not hasattr(transport, "multiplexed"):
                raise SessionCompatibilityFailure("multiplexed_control_missing")
            transport.multiplexed = False
            if transport.multiplexed is not False:
                raise SessionCompatibilityFailure("multiplexed_disable_failed")
            # The desktop client has no provider proxy setting. Do not inherit a
            # proxy injected by the host shell/IDE (for example a dead sandbox
            # endpoint); Windows TUN/system routing remains available to the
            # process and explicit provider proxy support can be added later.
            if hasattr(transport, "trust_env"):
                transport.trust_env = False
            if credential is not None:
                client.credential = credential
            device_store = getattr(client, "_device_store", None)
            get_device = getattr(device_store, "get_device", None)
            if get_device is None:
                raise SessionCompatibilityFailure("device_store_missing")
            await get_device()
            return client
        except Exception:
            with suppress(Exception):
                await client.close()
            raise

    async def close(self) -> None:
        async with self._rebuild_lock:
            if self._closed:
                return
            self._closed = True
            client = self._client
            self._client = None
            if client is not None:
                await client.close()
