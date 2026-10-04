"""Small stderr-only logger with defense-in-depth redaction."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import TextIO

_SENSITIVE_KEY_MARKERS = (
    "authorization",
    "cookie",
    "credential",
    "password",
    "secret",
    "session",
    "ticket",
    "token",
    "uin",
    "openid",
    "unionid",
    "musickey",
    "musicid",
    "refreshkey",
    "qrsig",
    "skey",
    "qmkeyst",
    "authst",
    "csrf",
    "qimei",
    "openudid",
)
_SENSITIVE_EXACT_KEYS = frozenset({"qq", "aid", "uid", "sid", "guid"})
_WHOLE_HEADER_SECRET = re.compile(
    r"(?i)(?P<prefix>\b(?:set[-_ ]?cookie|cookie|authorization)\s*[:=]\s*)[^\r\n]*"
)
_BEARER_SECRET = re.compile(r"(?i)\bbearer\s+[^\s,;]+")
_INLINE_SECRET_NAME = (
    r"(?:access[_-]?token|refresh[_-]?token|token|openid|unionid|musickey|"
    r"music[_-]?key|qqmusic[_-]?key|refresh[_-]?key|qrsig|p[_-]?skey|skey|"
    r"qm[_-]?keyst|authst|password|secret|session|ticket|uin|encrypt[_-]?uin|"
    r"qimei(?:36)?|open[_-]?udid2?|guid|g[_-]?tk(?:[_-]?new(?:[_-]?20200303)?)?)"
)
_INLINE_SECRET_ASSIGNMENT = re.compile(
    rf"(?i)(?P<prefix>[\"']?{_INLINE_SECRET_NAME}[\"']?\s*[:=]\s*[\"']?)"
    r"[^\s,;&\"']+"
)
_MAX_STRING_LENGTH = 256


def _is_sensitive_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", key.casefold())
    return normalized in _SENSITIVE_EXACT_KEYS or any(
        marker in normalized for marker in _SENSITIVE_KEY_MARKERS
    )


def _sanitize_text(value: str) -> str:
    sanitized = _WHOLE_HEADER_SECRET.sub(r"\g<prefix>[REDACTED]", value)
    sanitized = _BEARER_SECRET.sub("Bearer [REDACTED]", sanitized)
    sanitized = _INLINE_SECRET_ASSIGNMENT.sub(r"\g<prefix>[REDACTED]", sanitized)
    sanitized = "".join(character if character >= " " else "?" for character in sanitized)
    if len(sanitized) > _MAX_STRING_LENGTH:
        return f"{sanitized[:_MAX_STRING_LENGTH]}…"
    return sanitized


def _redact(value: object, *, key: str = "") -> object:
    if key and _is_sensitive_key(key):
        return "[REDACTED]"
    if isinstance(value, str):
        return _sanitize_text(value)
    if isinstance(value, Mapping):
        return {str(item_key): _redact(item, key=str(item_key)) for item_key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, bytes | bytearray):
        return [_redact(item) for item in value]
    if isinstance(value, bool | int | float) or value is None:
        return value
    return "[UNSERIALIZABLE]"


class SafeLogger:
    """Emit structured diagnostics without ever writing to protocol stdout."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream

    def log(self, level: str, code: str, **fields: object) -> None:
        record: dict[str, object] = {
            "level": level,
            "code": code,
        }
        record.update({field: _redact(value, key=field) for field, value in fields.items()})
        self._stream.write(
            json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
        )
        self._stream.flush()


class RedactingStdout:
    """Line-buffer ordinary stdout and emit it as redacted stderr diagnostics."""

    encoding = "utf-8"

    def __init__(self, stream: TextIO) -> None:
        self._logger = SafeLogger(stream)
        self._pending = ""

    def write(self, value: str) -> int:
        if not isinstance(value, str):
            raise TypeError("stdout writes must be text")
        self._pending += value
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            self._emit(line.removesuffix("\r"))
        return len(value)

    def flush(self) -> None:
        if self._pending:
            pending = self._pending
            self._pending = ""
            self._emit(pending)

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def _emit(self, message: str) -> None:
        if message:
            self._logger.log("warning", "redirected_stdout", message=message)
