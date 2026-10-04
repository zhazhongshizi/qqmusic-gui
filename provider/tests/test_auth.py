from __future__ import annotations

import base64
from collections.abc import Mapping

import pytest

from qqmusic_provider import auth
from qqmusic_provider.auth import (
    AuthFailure,
    AuthFailureCode,
    AuthService,
    QrArtifact,
    QrCheck,
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _credential(**changes: object) -> dict[str, object]:
    credential: dict[str, object] = {
        "openid": "openid-value",
        "refresh_token": "refresh-token",
        "access_token": "access-token",
        "expired_at": 1_900_000_000,
        "musicid": 123456,
        "musickey": "qqmusic-key",
        "unionid": "union-id",
        "str_musicid": "123456",
        "refresh_key": "refresh-key",
        "musickey_create_time": 1_800_000_000,
        "key_expires_in": 86_400,
        "first_login": 0,
        "bind_account_type": 0,
        "need_refresh_key_in": 0,
        "encrypt_uin": "encrypted-uin",
        "login_type": 2,
    }
    credential.update(changes)
    return credential


class OfflineAuthSource:
    def __init__(self) -> None:
        self.checks: list[QrCheck] = []
        self.artifacts: list[QrArtifact] = []
        self.restored: Mapping[str, object] | None = None
        self.valid = True
        self.refresh = _credential(musickey="refreshed-key")
        self.logout_calls = 0
        self.close_calls = 0

    async def start_qr(self, login_method: str) -> QrArtifact:
        artifact = QrArtifact(
            data=(b"png-fixture" if login_method == "qq" else b"jpeg-fixture"),
            mime_type=("image/png" if login_method == "qq" else "image/jpeg"),
            handle={"loginMethod": login_method, "sentinelIdentifier": "private"},
        )
        self.artifacts.append(artifact)
        return artifact

    async def check_qr(self, handle: object) -> QrCheck:
        assert "sentinelIdentifier" in handle
        return self.checks.pop(0)

    async def restore(self, credential: Mapping[str, object]) -> None:
        self.restored = dict(credential)

    async def check_credential(self) -> bool:
        return self.valid

    async def refresh_credential(self) -> Mapping[str, object]:
        return self.refresh

    async def logout(self) -> None:
        self.logout_calls += 1

    async def close(self) -> None:
        self.close_calls += 1


class FailingAfterConfirmationSource(OfflineAuthSource):
    async def check_qr(self, handle: object) -> QrCheck:
        if self.checks:
            return await super().check_qr(handle)
        raise AuthFailure(AuthFailureCode.NETWORK_UNAVAILABLE, retryable=True)


@pytest.mark.anyio
async def test_qr_login_state_machine_keeps_identifier_private_and_clears_image() -> None:
    source = OfflineAuthSource()
    source.checks = [
        QrCheck("waiting_scan"),
        QrCheck("waiting_confirmation"),
        QrCheck("authenticated", _credential()),
    ]
    service = AuthService(source)

    started = await service.execute("auth.qr.start", {"loginMethod": "qq"})
    assert started["loginMethod"] == "qq"
    assert started["mimeType"] == "image/png"
    assert base64.b64decode(str(started["imageBase64"])) == b"png-fixture"
    assert "sentinelIdentifier" not in str(started)
    assert source.artifacts[0].data == b""
    session_id = str(started["sessionId"])

    scanning = await service.execute("auth.qr.poll", {"sessionId": session_id})
    confirming = await service.execute("auth.qr.poll", {"sessionId": session_id})
    done = await service.execute("auth.qr.poll", {"sessionId": session_id})

    assert scanning == {"sessionId": session_id, "state": "waiting_scan"}
    assert confirming == {"sessionId": session_id, "state": "waiting_confirmation"}
    assert done["state"] == "authenticated"
    assert done["account"] == {"musicId": "123456", "loginMethod": "qq"}
    assert done["credential"] == _credential()
    replayed = await service.execute("auth.qr.poll", {"sessionId": session_id})
    assert replayed == done
    assert source.checks == []


@pytest.mark.anyio
async def test_qr_authorization_error_after_confirmation_fuses_the_session() -> None:
    source = FailingAfterConfirmationSource()
    source.checks = [QrCheck("waiting_confirmation")]
    service = AuthService(source)
    started = await service.execute("auth.qr.start", {"loginMethod": "qq"})
    session_id = str(started["sessionId"])

    waiting = await service.execute("auth.qr.poll", {"sessionId": session_id})
    assert waiting["state"] == "waiting_confirmation"

    with pytest.raises(AuthFailure) as first:
        await service.execute("auth.qr.poll", {"sessionId": session_id})
    assert first.value.code == AuthFailureCode.QR_OUTCOME_UNKNOWN.value

    with pytest.raises(AuthFailure) as repeated:
        await service.execute("auth.qr.poll", {"sessionId": session_id})
    assert repeated.value.code == AuthFailureCode.QR_OUTCOME_UNKNOWN.value

    cancelled = await service.execute("auth.qr.cancel", {"sessionId": session_id})
    assert cancelled == {"sessionId": session_id, "state": "cancelled"}


@pytest.mark.anyio
async def test_new_qr_session_invalidates_old_and_cancel_is_terminal() -> None:
    source = OfflineAuthSource()
    service = AuthService(source)

    first = await service.execute("auth.qr.start", {"loginMethod": "qq"})
    second = await service.execute("auth.qr.start", {"loginMethod": "wx"})
    with pytest.raises(AuthFailure, match="auth_session_not_found"):
        await service.execute("auth.qr.poll", {"sessionId": first["sessionId"]})

    cancelled = await service.execute("auth.qr.cancel", {"sessionId": second["sessionId"]})
    assert cancelled == {"sessionId": second["sessionId"], "state": "cancelled"}
    with pytest.raises(AuthFailure, match="auth_session_not_found"):
        await service.execute("auth.qr.cancel", {"sessionId": second["sessionId"]})


@pytest.mark.anyio
async def test_qr_ttl_expires_without_polling_upstream(monkeypatch: pytest.MonkeyPatch) -> None:
    source = OfflineAuthSource()
    source.checks = [QrCheck("authenticated", _credential())]
    clock = {"monotonic": 100.0, "wall": 1_800_000_000.0}
    monkeypatch.setattr(auth.time, "monotonic", lambda: clock["monotonic"])
    monkeypatch.setattr(auth.time, "time", lambda: clock["wall"])
    service = AuthService(source)
    started = await service.execute("auth.qr.start", {"loginMethod": "qq"})
    assert started["expiresAtMs"] == 1_800_000_180_000

    clock["monotonic"] += auth.QR_TTL_SECONDS
    first = await service.execute("auth.qr.poll", {"sessionId": started["sessionId"]})
    second = await service.execute("auth.qr.poll", {"sessionId": started["sessionId"]})
    assert first == {"sessionId": started["sessionId"], "state": "expired"}
    assert second == first
    assert len(source.checks) == 1
    with pytest.raises(AuthFailure, match="auth_session_not_found"):
        await service.execute("auth.qr.poll", {"sessionId": started["sessionId"]})


@pytest.mark.anyio
async def test_early_terminal_is_retained_and_waiting_state_clears_the_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"monotonic": 100.0}
    monkeypatch.setattr(auth.time, "monotonic", lambda: clock["monotonic"])
    for terminal in ("rejected", "expired"):
        source = OfflineAuthSource()
        source.checks = [QrCheck(terminal), QrCheck("waiting_scan"), QrCheck(terminal)]
        service = AuthService(source)
        started = await service.execute("auth.qr.start", {"loginMethod": "qq"})
        first = await service.execute("auth.qr.poll", {"sessionId": started["sessionId"]})
        recovered = await service.execute("auth.qr.poll", {"sessionId": started["sessionId"]})
        repeated = await service.execute("auth.qr.poll", {"sessionId": started["sessionId"]})
        assert first["state"] == terminal
        assert recovered["state"] == "waiting_scan"
        assert repeated["state"] == terminal

        clock["monotonic"] += auth.QR_MIN_DISPLAY_SECONDS
        source.checks = [QrCheck(terminal)]
        confirmed = await service.execute("auth.qr.poll", {"sessionId": started["sessionId"]})
        assert confirmed["state"] == terminal
        with pytest.raises(AuthFailure, match="auth_session_not_found"):
            await service.execute("auth.qr.poll", {"sessionId": started["sessionId"]})


@pytest.mark.anyio
async def test_credential_restore_check_refresh_and_logout_contract() -> None:
    source = OfflineAuthSource()
    service = AuthService(source)
    credential = _credential()

    restored = await service.execute("auth.credential.restore", {"credential": credential})
    checked = await service.execute("auth.credential.check", {})
    refreshed = await service.execute("auth.credential.refresh", {})
    signed_out = await service.execute("auth.logout", {})
    await service.close()

    assert restored == {"status": "restored"}
    assert source.restored == credential
    assert checked == {"status": "authenticated"}
    assert refreshed == {"status": "authenticated", "credential": source.refresh}
    assert signed_out == {"status": "signed_out"}
    assert source.logout_calls == 1
    assert source.close_calls == 1


@pytest.mark.anyio
async def test_invalid_params_and_credentials_fail_with_stable_codes() -> None:
    service = AuthService(OfflineAuthSource())
    invalid_calls = [
        ("auth.qr.start", {"loginMethod": "mobile"}),
        ("auth.qr.start", {"loginMethod": "qq", "extra": True}),
        ("auth.qr.poll", {"sessionId": ""}),
        ("auth.credential.check", {"unexpected": True}),
        ("auth.credential.restore", {"credential": {"musickey": "secret"}}),
    ]
    for method, params in invalid_calls:
        with pytest.raises(AuthFailure) as raised:
            await service.execute(method, params)
        expected = (
            AuthFailureCode.CREDENTIAL_INVALID.value
            if method == "auth.credential.restore"
            else AuthFailureCode.INVALID_PARAMS.value
        )
        assert raised.value.code == expected


@pytest.mark.anyio
async def test_oversized_or_unknown_qr_image_is_rejected_and_erased() -> None:
    class InvalidImageSource(OfflineAuthSource):
        async def start_qr(self, login_method: str) -> QrArtifact:
            artifact = QrArtifact(b"x", "image/gif", object())
            self.artifacts.append(artifact)
            return artifact

    invalid = InvalidImageSource()
    with pytest.raises(AuthFailure) as raised:
        await AuthService(invalid).execute("auth.qr.start", {"loginMethod": "qq"})
    assert raised.value.code == AuthFailureCode.UPSTREAM_SCHEMA_CHANGED.value
    assert invalid.artifacts[0].data == b""
