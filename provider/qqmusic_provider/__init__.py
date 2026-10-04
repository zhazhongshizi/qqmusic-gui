"""QQ Music GUI's private provider process."""

from typing import Final

PROVIDER_NAME: Final = "qqmusic-provider"
PROVIDER_VERSION: Final = "0.1.0"
PROTOCOL_VERSION: Final = 1
MAX_LINE_BYTES: Final = 1_048_576
MAX_JSON_DEPTH: Final = 128
REQUEST_ID_PATTERN: Final = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
FIRST_METHOD: Final = "system.handshake"
VERSION_ENCODING: Final = "json-integer-token"

__all__ = [
    "FIRST_METHOD",
    "MAX_JSON_DEPTH",
    "MAX_LINE_BYTES",
    "PROTOCOL_VERSION",
    "PROVIDER_NAME",
    "PROVIDER_VERSION",
    "REQUEST_ID_PATTERN",
    "VERSION_ENCODING",
]
