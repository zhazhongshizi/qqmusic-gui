"""Strict parser and writer for provider protocol v1."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import BinaryIO, NoReturn, TextIO

from . import MAX_JSON_DEPTH, MAX_LINE_BYTES, PROTOCOL_VERSION, REQUEST_ID_PATTERN

_REQUEST_ID_PATTERN = re.compile(REQUEST_ID_PATTERN)
_REQUEST_FIELDS = frozenset({"v", "id", "method", "params"})


class ProtocolViolation(Exception):
    """A framing or state error that requires terminating this provider instance."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class DuplicateJsonKey(ValueError):
    """Raised when any JSON object repeats a key."""


@dataclass(frozen=True, slots=True)
class Request:
    request_id: str
    method: str
    params: dict[str, object]


def _reject_constant(_value: str) -> NoReturn:
    raise ValueError("non-finite JSON number")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKey(key)
        result[key] = value
    return result


def _enforce_json_depth(payload: str) -> None:
    """Reject excessive container nesting before the stdlib decoder recurses."""

    depth = 0
    in_string = False
    escaped = False
    for character in payload:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > MAX_JSON_DEPTH:
                raise ProtocolViolation("json_nesting_too_deep")
        elif character in "]}":
            depth -= 1


def read_request_line(stream: BinaryIO) -> bytes | None:
    """Read one bounded NDJSON payload, excluding CRLF/LF."""

    raw = stream.readline(MAX_LINE_BYTES + 2)
    if raw == b"":
        return None
    if raw.endswith(b"\r\n"):
        raw = raw[:-2]
    elif raw.endswith(b"\n"):
        raw = raw[:-1]
    if len(raw) > MAX_LINE_BYTES:
        raise ProtocolViolation("line_too_long")
    if not raw:
        raise ProtocolViolation("empty_line")
    return raw


def parse_request(payload: bytes) -> Request:
    """Decode and validate a single request object."""

    try:
        decoded = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ProtocolViolation("invalid_utf8") from error
    if decoded.startswith("\ufeff"):
        raise ProtocolViolation("utf8_bom_not_allowed")
    _enforce_json_depth(decoded)

    try:
        raw = json.loads(
            decoded,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except DuplicateJsonKey as error:
        raise ProtocolViolation("duplicate_json_key") from error
    except RecursionError as error:
        raise ProtocolViolation("json_nesting_too_deep") from error
    except (json.JSONDecodeError, ValueError) as error:
        raise ProtocolViolation("invalid_json") from error

    if not isinstance(raw, dict):
        raise ProtocolViolation("request_not_object")
    if set(raw) != _REQUEST_FIELDS:
        raise ProtocolViolation("invalid_request_shape")
    if type(raw["v"]) is not int or raw["v"] != PROTOCOL_VERSION:
        raise ProtocolViolation("protocol_version_mismatch")
    request_id = raw["id"]
    if not isinstance(request_id, str) or _REQUEST_ID_PATTERN.fullmatch(request_id) is None:
        raise ProtocolViolation("invalid_request_id")
    method = raw["method"]
    if not isinstance(method, str) or not method or len(method) > 128:
        raise ProtocolViolation("invalid_method")
    params = raw["params"]
    if not isinstance(params, dict):
        raise ProtocolViolation("invalid_params_shape")
    return Request(request_id=request_id, method=method, params=params)


def write_frame(stream: TextIO, frame: dict[str, object]) -> None:
    """Write exactly one compact JSON object to protocol stdout."""

    encoded = json.dumps(
        frame,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )
    if len(encoded.encode("utf-8")) > MAX_LINE_BYTES:
        raise ProtocolViolation("outbound_line_too_long")
    stream.write(encoded + "\n")
    stream.flush()


def success_frame(
    request_id: str,
    result: dict[str, object],
    warnings: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "v": PROTOCOL_VERSION,
        "id": request_id,
        "ok": True,
        "result": result,
        "warnings": warnings or [],
    }


def error_frame(
    request_id: str,
    code: str,
    *,
    retryable: bool = False,
) -> dict[str, object]:
    return {
        "v": PROTOCOL_VERSION,
        "id": request_id,
        "ok": False,
        "error": {"code": code, "retryable": retryable},
    }


def event_frame(event: str, payload: dict[str, object]) -> dict[str, object]:
    """Build an unsolicited provider event frame.

    Events are used for long-lived flows such as QR login. They deliberately do
    not carry a request id, so the caller is not tied to a renderer polling RPC.
    """

    return {
        "v": PROTOCOL_VERSION,
        "event": event,
        "payload": payload,
    }


FrameWriter = Callable[[TextIO, dict[str, object]], None]
