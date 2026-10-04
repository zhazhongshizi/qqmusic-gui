from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from qqmusic_provider.session import (
    QQMusicSession,
    SessionCompatibilityFailure,
)

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class FakeClient:
    def __init__(self, path: str, *, multiplexed: bool = True) -> None:
        self.path = path
        self.credential: object = SimpleNamespace(musicid=0, musickey="")
        self._session = SimpleNamespace(multiplexed=multiplexed, trust_env=True)
        self._device_store = SimpleNamespace(get_device=self.get_device)
        self.closed = 0
        self.device_loaded = 0

    async def get_device(self) -> object:
        self.device_loaded += 1
        return object()

    async def close(self) -> None:
        self.closed += 1


def _device_path(name: str) -> Path:
    return (Path.cwd() / ".tmp" / name / "qq-device.json").resolve()


async def test_initializes_persistent_device_and_disables_multiplexing() -> None:
    created: list[FakeClient] = []

    def factory(path: str) -> FakeClient:
        client = FakeClient(path)
        created.append(client)
        return client

    device_path = _device_path("session-initialize")
    session = QQMusicSession(device_path, client_factory=factory)
    await session.initialize()

    assert created[0].path == str(device_path.resolve())
    assert created[0]._session.multiplexed is False
    assert created[0]._session.trust_env is False
    assert created[0].device_loaded == 1


async def test_rebuild_is_single_flight_and_preserves_credential() -> None:
    created: list[FakeClient] = []

    def factory(path: str) -> FakeClient:
        client = FakeClient(path)
        created.append(client)
        return client

    session = QQMusicSession(_device_path("session-rebuild"), client_factory=factory)
    await session.initialize()
    credential = SimpleNamespace(musicid=7, musickey="secret")
    session.client().credential = credential
    old_generation = session.generation

    first = await session.rebuild_if_current(old_generation)
    second = await session.rebuild_if_current(old_generation)

    assert first == second == old_generation + 1
    assert len(created) == 2
    assert session.client().credential is credential
    assert created[0].closed == 1


async def test_missing_multiplexed_attribute_is_a_compatibility_failure() -> None:
    class BrokenClient(FakeClient):
        def __init__(self, path: str) -> None:
            super().__init__(path)
            self._session = SimpleNamespace()

    session = QQMusicSession(_device_path("session-broken"), client_factory=BrokenClient)

    with pytest.raises(SessionCompatibilityFailure):
        await session.initialize()
