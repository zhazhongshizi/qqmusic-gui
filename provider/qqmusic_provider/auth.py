"""In-memory QR authentication state machine and credential recovery adapter."""

from __future__ import annotations

import base64
import json
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Protocol, cast

from .session import QQMusicSession

QR_TTL_SECONDS = 180
QR_MIN_DISPLAY_SECONDS = 60
QR_POLL_AFTER_MS = 1_500
QR_COMPLETED_REPLAY_SECONDS = 90
MAX_QR_IMAGE_BYTES = 512 * 1024
MAX_CREDENTIAL_JSON_BYTES = 2_400

IMPLEMENTED_AUTH_METHODS = (
    "auth.qr.start",
    "auth.qr.poll",
    "auth.qr.cancel",
    "auth.credential.restore",
    "auth.credential.check",
    "auth.credential.refresh",
    "auth.logout",
)

_CREDENTIAL_STRING_FIELDS = frozenset(
    {
        "openid",
        "refresh_token",
        "access_token",
        "musickey",
        "unionid",
        "str_musicid",
        "refresh_key",
        "encrypt_uin",
    }
)
_CREDENTIAL_INTEGER_FIELDS = frozenset(
    {
        "expired_at",
        "musicid",
        "musickey_create_time",
        "key_expires_in",
        "first_login",
        "bind_account_type",
        "need_refresh_key_in",
        "login_type",
    }
)
_CREDENTIAL_FIELDS = _CREDENTIAL_STRING_FIELDS | _CREDENTIAL_INTEGER_FIELDS


class AuthFailureCode(str, Enum):
    INVALID_PARAMS = "invalid_params"
    SESSION_NOT_FOUND = "auth_session_not_found"
    NETWORK_UNAVAILABLE = "auth_network_unavailable"
    RATE_LIMITED = "auth_rate_limited"
    CREDENTIAL_INVALID = "credential_invalid"
    ACCOUNT_RESTRICTED = "auth_account_restricted"
    DEVICE_LIMIT = "auth_device_limit"
    UPSTREAM_SCHEMA_CHANGED = "upstream_schema_changed"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"
    QR_OUTCOME_UNKNOWN = "auth_qr_outcome_unknown"


class AuthFailure(Exception):
    def __init__(
        self,
        code: AuthFailureCode,
        *,
        retryable: bool = False,
        cause_code: str | None = None,
    ) -> None:
        super().__init__(code.value)
        self.code = code.value
        self.retryable = retryable
        self.cause_code = cause_code


@dataclass(slots=True)
class QrArtifact:
    data: bytes
    mime_type: str
    handle: object


@dataclass(frozen=True, slots=True)
class QrCheck:
    state: str
    credential: Mapping[str, object] | None = None


class AuthSource(Protocol):
    async def start_qr(self, login_method: str) -> QrArtifact: ...

    async def check_qr(self, handle: object) -> QrCheck: ...

    async def restore(self, credential: Mapping[str, object]) -> None: ...

    async def check_credential(self) -> bool: ...

    async def refresh_credential(self) -> Mapping[str, object]: ...

    async def logout(self) -> None: ...

    async def close(self) -> None: ...


class QQMusicAuthSource:
    """Thin QQMusicApi adapter. It never writes credentials or QR images to disk."""

    def __init__(
        self, session: QQMusicSession | None = None, *, device_path: Path | str | None = None
    ) -> None:
        self._owns_session = session is None
        if session is None and device_path is None:
            raise ValueError("device_path_required")
        self._session = session if session is not None else QQMusicSession(cast("str", device_path))

    async def start_qr(self, login_method: str) -> QrArtifact:
        from qqmusic_api import Credential  # type: ignore[import-untyped]
        from qqmusic_api.models.login import QRLoginType  # type: ignore[import-untyped]

        login_type = QRLoginType.QQ if login_method == "qq" else QRLoginType.WX
        client = self._session.client()
        previous_credential = client.credential
        try:
            client.credential = Credential()
            try:
                qr = await client.login.get_qrcode(login_type)
            except Exception as error:
                raise _map_upstream_error(error) from None
        finally:
            client.credential = previous_credential
        artifact = QrArtifact(data=bytes(qr.data), mime_type=str(qr.mimetype), handle=qr)
        # Polling only needs the opaque identifier and type. Drop the image from provider state.
        qr.data = b""
        return artifact

    async def check_qr(self, handle: object) -> QrCheck:
        from qqmusic_api import Credential
        from qqmusic_api.models.login import QRCodeLoginEvents

        client = self._session.client()
        previous_credential = client.credential
        try:
            client.credential = Credential()
            try:
                result = await client.login.check_qrcode(handle)
            except Exception as error:
                raise _map_upstream_error(error) from None
        finally:
            client.credential = previous_credential
        states = {
            QRCodeLoginEvents.SCAN: "waiting_scan",
            QRCodeLoginEvents.CONF: "waiting_confirmation",
            QRCodeLoginEvents.TIMEOUT: "expired",
            QRCodeLoginEvents.REFUSE: "rejected",
            QRCodeLoginEvents.DONE: "authenticated",
        }
        state = states.get(result.event)
        if state is None:
            raise AuthFailure(AuthFailureCode.UPSTREAM_SCHEMA_CHANGED)
        if result.credential is None:
            if state == "authenticated":
                raise AuthFailure(AuthFailureCode.UPSTREAM_SCHEMA_CHANGED)
            return QrCheck(state)
        if state != "authenticated":
            raise AuthFailure(AuthFailureCode.UPSTREAM_SCHEMA_CHANGED)
        self._session.client().credential = result.credential
        return QrCheck(state, _credential_payload(result.credential))

    async def restore(self, credential: Mapping[str, object]) -> None:
        from qqmusic_api import Credential

        payload = _validate_credential_payload(credential)
        try:
            self._session.client().credential = Credential.model_validate(payload)
        except Exception as error:
            raise _map_upstream_error(error, invalid_credential=True) from None

    async def check_credential(self) -> bool:
        client = self._session.client()
        if not _has_credential(client.credential):
            raise AuthFailure(AuthFailureCode.CREDENTIAL_INVALID)
        try:
            return not bool(await client.login.check_expired())
        except Exception as error:
            raise _map_upstream_error(error, invalid_credential=True) from None

    async def refresh_credential(self) -> Mapping[str, object]:
        client = self._session.client()
        if not _has_credential(client.credential):
            raise AuthFailure(AuthFailureCode.CREDENTIAL_INVALID)
        try:
            credential = await client.login.refresh_credential()
        except Exception as error:
            raise _map_upstream_error(error, invalid_credential=True) from None
        client.credential = credential
        return _credential_payload(credential)

    async def logout(self) -> None:
        from qqmusic_api import Credential

        client = self._session.client()
        try:
            if _has_credential(client.credential):
                try:
                    await client.login.logout()
                except Exception as error:
                    raise _map_upstream_error(error, invalid_credential=True) from None
        finally:
            # A local sign-out must not leave the previous account attached to
            # the long-lived client, even when QQ's revoke call fails.
            client.credential = Credential()

    async def close(self) -> None:
        if self._owns_session:
            await self._session.close()


@dataclass(slots=True)
class _ActiveQr:
    session_id: str
    login_method: str
    handle: object
    started_monotonic: float
    expires_monotonic: float
    expires_at_ms: int
    terminal_state: str | None = None
    terminal_count: int = 0
    confirmation_seen: bool = False
    outcome_unknown: bool = False


@dataclass(slots=True)
class _CompletedQr:
    session_id: str
    credential: dict[str, object]
    account: dict[str, object]
    expires_monotonic: float


class AuthService:
    def __init__(self, source: AuthSource | None = None) -> None:
        self._source = source or QQMusicAuthSource()
        self._active: _ActiveQr | None = None
        self._completed: _CompletedQr | None = None

    async def execute(self, operation: str, raw_params: Mapping[str, object]) -> dict[str, object]:
        if operation == "auth.qr.start":
            return await self._start(raw_params)
        if operation == "auth.qr.poll":
            return await self._poll(raw_params)
        if operation == "auth.qr.cancel":
            return self._cancel(raw_params)
        if operation == "auth.credential.restore":
            restored_credential = _validate_credential_payload(
                _only_mapping_param(raw_params, "credential")
            )
            await self._source.restore(restored_credential)
            return {"status": "restored"}
        if operation == "auth.credential.check":
            _require_no_params(raw_params)
            valid = await self._source.check_credential()
            return {"status": "authenticated" if valid else "expired"}
        if operation == "auth.credential.refresh":
            _require_no_params(raw_params)
            refreshed_credential = await self._source.refresh_credential()
            return {"status": "authenticated", "credential": dict(refreshed_credential)}
        if operation == "auth.logout":
            _require_no_params(raw_params)
            self._active = None
            self._completed = None
            await self._source.logout()
            return {"status": "signed_out"}
        raise AuthFailure(AuthFailureCode.INVALID_PARAMS)

    async def _start(self, raw_params: Mapping[str, object]) -> dict[str, object]:
        if set(raw_params) != {"loginMethod"} or raw_params.get("loginMethod") not in {"qq", "wx"}:
            raise AuthFailure(AuthFailureCode.INVALID_PARAMS)
        login_method = cast("str", raw_params["loginMethod"])
        self._active = None
        self._completed = None
        artifact = await self._source.start_qr(login_method)
        if (
            not artifact.data
            or len(artifact.data) > MAX_QR_IMAGE_BYTES
            or artifact.mime_type not in {"image/png", "image/jpeg"}
        ):
            artifact.data = b""
            raise AuthFailure(AuthFailureCode.UPSTREAM_SCHEMA_CHANGED)
        now = time.monotonic()
        session_id = str(uuid.uuid4())
        expires_at_ms = int(time.time() * 1_000) + QR_TTL_SECONDS * 1_000
        self._active = _ActiveQr(
            session_id=session_id,
            login_method=login_method,
            handle=artifact.handle,
            started_monotonic=now,
            expires_monotonic=now + QR_TTL_SECONDS,
            expires_at_ms=expires_at_ms,
        )
        encoded = base64.b64encode(artifact.data).decode("ascii")
        artifact.data = b""
        return {
            "sessionId": session_id,
            "loginMethod": login_method,
            "mimeType": artifact.mime_type,
            "imageBase64": encoded,
            "expiresAtMs": expires_at_ms,
            "pollAfterMs": QR_POLL_AFTER_MS,
        }

    async def _poll(self, raw_params: Mapping[str, object]) -> dict[str, object]:
        session_id = _only_string_param(raw_params, "sessionId")
        self._prune_completed()
        if self._completed is not None and self._completed.session_id == session_id:
            return self._completed_result(self._completed)
        active = self._require_active(session_id)
        if active.outcome_unknown:
            raise AuthFailure(AuthFailureCode.QR_OUTCOME_UNKNOWN)
        now = time.monotonic()
        if now >= active.expires_monotonic:
            return self._observe_terminal(active, "expired", now)
        try:
            check = await self._source.check_qr(active.handle)
        except AuthFailure as error:
            # Once QQ has reported a scanned QR, a failed authorization request
            # may already have reached the account security service. Retrying
            # the same QR would submit the login flow again, so fuse the session
            # until the renderer explicitly cancels it.
            if active.confirmation_seen:
                active.outcome_unknown = True
                raise AuthFailure(
                    AuthFailureCode.QR_OUTCOME_UNKNOWN,
                    cause_code=error.code,
                ) from error
            raise
        result: dict[str, object] = {"sessionId": session_id, "state": check.state}
        if check.state == "authenticated":
            if check.credential is None:
                self._active = None
                raise AuthFailure(AuthFailureCode.UPSTREAM_SCHEMA_CHANGED)
            completed = _CompletedQr(
                session_id=session_id,
                credential=dict(check.credential),
                account=_public_account(check.credential, active.login_method),
                expires_monotonic=now + QR_COMPLETED_REPLAY_SECONDS,
            )
            self._completed = completed
            self._active = None
            return self._completed_result(completed)
        elif check.state in {"expired", "rejected"}:
            return self._observe_terminal(active, check.state, now)
        elif check.state in {"waiting_scan", "waiting_confirmation"}:
            if check.state == "waiting_confirmation":
                active.confirmation_seen = True
            active.terminal_state = None
            active.terminal_count = 0
        elif check.state not in {"waiting_scan", "waiting_confirmation"}:
            self._active = None
            raise AuthFailure(AuthFailureCode.UPSTREAM_SCHEMA_CHANGED)
        return result

    def _observe_terminal(
        self, active: _ActiveQr, state: str, now: float
    ) -> dict[str, object]:
        if active.terminal_state == state:
            active.terminal_count += 1
        else:
            active.terminal_state = state
            active.terminal_count = 1
        if (
            now - active.started_monotonic >= QR_MIN_DISPLAY_SECONDS
            and active.terminal_count >= 2
        ):
            self._active = None
        return {"sessionId": active.session_id, "state": state}

    def _cancel(self, raw_params: Mapping[str, object]) -> dict[str, object]:
        session_id = _only_string_param(raw_params, "sessionId")
        self._prune_completed()
        if self._completed is not None and self._completed.session_id == session_id:
            self._completed = None
            return {"sessionId": session_id, "state": "cancelled"}
        self._require_active(session_id)
        self._active = None
        return {"sessionId": session_id, "state": "cancelled"}

    def _require_active(self, session_id: str) -> _ActiveQr:
        if self._active is None or self._active.session_id != session_id:
            raise AuthFailure(AuthFailureCode.SESSION_NOT_FOUND)
        return self._active

    def _prune_completed(self) -> None:
        if self._completed is not None and time.monotonic() >= self._completed.expires_monotonic:
            self._completed = None

    @staticmethod
    def _completed_result(completed: _CompletedQr) -> dict[str, object]:
        return {
            "sessionId": completed.session_id,
            "state": "authenticated",
            "credential": dict(completed.credential),
            "account": dict(completed.account),
        }

    async def close(self) -> None:
        self._active = None
        self._completed = None
        await self._source.close()


def _require_no_params(raw: Mapping[str, object]) -> None:
    if raw:
        raise AuthFailure(AuthFailureCode.INVALID_PARAMS)


def _only_string_param(raw: Mapping[str, object], name: str) -> str:
    if set(raw) != {name}:
        raise AuthFailure(AuthFailureCode.INVALID_PARAMS)
    value = raw.get(name)
    if not isinstance(value, str) or not value or len(value) > 128:
        raise AuthFailure(AuthFailureCode.INVALID_PARAMS)
    return value


def _only_mapping_param(raw: Mapping[str, object], name: str) -> Mapping[str, object]:
    if set(raw) != {name}:
        raise AuthFailure(AuthFailureCode.INVALID_PARAMS)
    value = raw.get(name)
    if not isinstance(value, Mapping):
        raise AuthFailure(AuthFailureCode.INVALID_PARAMS)
    return cast("Mapping[str, object]", value)


def _validate_credential_payload(raw: Mapping[str, object]) -> dict[str, object]:
    if set(raw) != _CREDENTIAL_FIELDS:
        raise AuthFailure(AuthFailureCode.CREDENTIAL_INVALID)
    payload: dict[str, object] = {}
    for key in _CREDENTIAL_STRING_FIELDS:
        value = raw.get(key)
        if not isinstance(value, str) or len(value) > 512:
            raise AuthFailure(AuthFailureCode.CREDENTIAL_INVALID)
        payload[key] = value
    for key in _CREDENTIAL_INTEGER_FIELDS:
        value = raw.get(key)
        if type(value) is not int or not 0 <= value <= 2**63 - 1:
            raise AuthFailure(AuthFailureCode.CREDENTIAL_INVALID)
        payload[key] = value
    if len(json.dumps(payload, separators=(",", ":")).encode("utf-8")) > MAX_CREDENTIAL_JSON_BYTES:
        raise AuthFailure(AuthFailureCode.CREDENTIAL_INVALID)
    if not _has_credential(payload):
        raise AuthFailure(AuthFailureCode.CREDENTIAL_INVALID)
    return payload


def _credential_payload(credential: object) -> dict[str, object]:
    try:
        raw = cast("Any", credential).model_dump(mode="json")
    except Exception as error:
        raise AuthFailure(AuthFailureCode.UPSTREAM_SCHEMA_CHANGED) from error
    if not isinstance(raw, Mapping):
        raise AuthFailure(AuthFailureCode.UPSTREAM_SCHEMA_CHANGED)
    try:
        return _validate_credential_payload(cast("Mapping[str, object]", raw))
    except AuthFailure as error:
        raise AuthFailure(AuthFailureCode.UPSTREAM_SCHEMA_CHANGED) from error


def _has_credential(credential: object) -> bool:
    if isinstance(credential, Mapping):
        musicid = credential.get("musicid")
        musickey = credential.get("musickey")
    else:
        musicid = getattr(credential, "musicid", 0)
        musickey = getattr(credential, "musickey", "")
    return type(musicid) is int and musicid > 0 and isinstance(musickey, str) and bool(musickey)


def _public_account(credential: Mapping[str, object], login_method: str) -> dict[str, object]:
    return {"musicId": str(credential["musicid"]), "loginMethod": login_method}


def _map_upstream_error(error: Exception, *, invalid_credential: bool = False) -> AuthFailure:
    from pydantic import ValidationError
    from qqmusic_api import (
        ApiDataError,
        BaseApiException,
        CredentialExpiredError,
        CredentialInvalidError,
        CredentialRefreshError,
        HTTPError,
        LoginAccountRestrictedError,
        LoginAuthExpiredError,
        LoginDeviceLimitError,
        LoginRateLimitError,
        NetworkError,
        RatelimitedError,
    )

    if isinstance(error, NetworkError | HTTPError):
        return AuthFailure(AuthFailureCode.NETWORK_UNAVAILABLE, retryable=True)
    if isinstance(error, LoginRateLimitError | RatelimitedError):
        return AuthFailure(AuthFailureCode.RATE_LIMITED, retryable=True)
    if isinstance(error, LoginAccountRestrictedError):
        return AuthFailure(AuthFailureCode.ACCOUNT_RESTRICTED)
    if isinstance(error, LoginDeviceLimitError):
        return AuthFailure(AuthFailureCode.DEVICE_LIMIT)
    if isinstance(
        error,
        CredentialExpiredError
        | CredentialInvalidError
        | CredentialRefreshError
        | LoginAuthExpiredError,
    ):
        return AuthFailure(AuthFailureCode.CREDENTIAL_INVALID)
    if isinstance(error, ValidationError | KeyError | TypeError | ValueError):
        code = (
            AuthFailureCode.CREDENTIAL_INVALID
            if invalid_credential
            else AuthFailureCode.UPSTREAM_SCHEMA_CHANGED
        )
        return AuthFailure(code)
    if isinstance(error, ApiDataError):
        return AuthFailure(AuthFailureCode.UPSTREAM_SCHEMA_CHANGED)
    if isinstance(error, BaseApiException):
        return AuthFailure(AuthFailureCode.UPSTREAM_UNAVAILABLE, retryable=True)
    return AuthFailure(AuthFailureCode.UPSTREAM_UNAVAILABLE, retryable=True)
