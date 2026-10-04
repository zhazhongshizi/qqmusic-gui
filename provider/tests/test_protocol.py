from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from qqmusic_provider import (
    FIRST_METHOD,
    MAX_JSON_DEPTH,
    MAX_LINE_BYTES,
    PROTOCOL_VERSION,
    REQUEST_ID_PATTERN,
    VERSION_ENCODING,
)
from qqmusic_provider.protocol import (
    ProtocolViolation,
    error_frame,
    parse_request,
    read_request_line,
    success_frame,
)

_ROOT = Path(__file__).resolve().parents[2]
_CONTRACTS = _ROOT / "contracts"
_FIXTURES = _ROOT / "tests" / "fixtures" / "provider-v1"


def _protocol_validator() -> Draft202012Validator:
    schema = json.loads((_CONTRACTS / "protocol-v1.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def test_parse_valid_request() -> None:
    request = parse_request(
        b'{"v":1,"id":"search-1","method":"search.songs","params":{"keyword":"sunny"}}'
    )

    assert request.request_id == "search-1"
    assert request.method == "search.songs"
    assert request.params == {"keyword": "sunny"}


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        (
            b'{"v":2,"id":"a","method":"system.ping","params":{}}',
            "protocol_version_mismatch",
        ),
        (b'{"v":1,"id":"a","id":"b","method":"system.ping","params":{}}', "duplicate_json_key"),
        (b'{"v":1,"id":"a","method":"system.ping"}', "invalid_request_shape"),
        (b'{"v":1,"id":"a","method":"system.ping","params":{},"extra":1}', "invalid_request_shape"),
        (b'{"v":1,"id":"bad id","method":"system.ping","params":{}}', "invalid_request_id"),
        (
            b'{"v":1,"id":"a","method":"system.ping","params":{},"n":NaN}',
            "invalid_json",
        ),
        (b'{"v":1,"id":"a","method":"system.ping","params":{}', "invalid_json"),
        (b'{"\xff"}', "invalid_utf8"),
    ],
)
def test_rejects_invalid_requests(payload: bytes, code: str) -> None:
    with pytest.raises(ProtocolViolation, match=code):
        parse_request(payload)


def test_line_limit_counts_payload_bytes_not_newline() -> None:
    allowed = b"x" * MAX_LINE_BYTES + b"\n"
    assert len(read_request_line(io.BytesIO(allowed)) or b"") == MAX_LINE_BYTES

    with pytest.raises(ProtocolViolation, match="line_too_long"):
        read_request_line(io.BytesIO(b"x" * (MAX_LINE_BYTES + 1) + b"\n"))


def test_line_limit_supports_exact_crlf_boundary() -> None:
    allowed = b"x" * MAX_LINE_BYTES + b"\r\n"
    assert len(read_request_line(io.BytesIO(allowed)) or b"") == MAX_LINE_BYTES

    with pytest.raises(ProtocolViolation, match="line_too_long"):
        read_request_line(io.BytesIO(b"x" * (MAX_LINE_BYTES + 1) + b"\r\n"))


def test_rejects_excessive_json_nesting() -> None:
    nested = "[" * MAX_JSON_DEPTH + "0" + "]" * MAX_JSON_DEPTH
    payload = (
        '{"v":1,"id":"deep","method":"system.ping","params":{"nested":'
        + nested
        + "}}"
    ).encode()

    with pytest.raises(ProtocolViolation, match="json_nesting_too_deep"):
        parse_request(payload)


def test_shared_protocol_constants_match_implementation() -> None:
    schema = json.loads((_CONTRACTS / "protocol-v1.schema.json").read_text(encoding="utf-8"))
    assert schema["$id"] == "https://qqmusic-gui.local/contracts/protocol-v1.schema.json"
    _protocol_validator()

    constants = json.loads((_CONTRACTS / "protocol-v1.constants.json").read_text(encoding="utf-8"))
    assert constants["protocolVersion"] == PROTOCOL_VERSION
    assert constants["maxLineBytes"] == MAX_LINE_BYTES
    assert constants["maxJsonDepth"] == MAX_JSON_DEPTH
    assert constants["requestIdPattern"] == REQUEST_ID_PATTERN
    assert constants["firstMethod"] == FIRST_METHOD
    assert constants["versionEncoding"] == VERSION_ENCODING


def test_contract_examples_and_indexed_fixtures_match_schema() -> None:
    validator = _protocol_validator()
    example_paths = sorted((_CONTRACTS / "examples").glob("*.ndjson"))
    assert example_paths
    for example_path in example_paths:
        for line in example_path.read_text(encoding="utf-8").splitlines():
            validator.validate(json.loads(line))

    index = json.loads((_FIXTURES / "index.json").read_text(encoding="utf-8"))
    assert index["protocolVersion"] == PROTOCOL_VERSION
    for fixture in index["ndjson"]:
        fixture_path = _FIXTURES / fixture["file"]
        assert fixture_path.is_file()
        for line in fixture_path.read_text(encoding="utf-8").splitlines():
            errors = list(validator.iter_errors(json.loads(line)))
            assert (not errors) is (fixture["schema"] == "valid"), fixture_path
    for recipe in index["recipes"]:
        assert (_FIXTURES / recipe).is_file()


def test_runtime_frame_constructors_match_schema() -> None:
    validator = _protocol_validator()
    validator.validate(success_frame("ok-1", {"pong": True}))
    validator.validate(error_frame("error-1", "invalid_params"))


def test_schema_numeric_model_and_wire_integer_token_rule_are_explicit() -> None:
    schema_valid_but_not_wire_valid = {
        "v": 1.0,
        "id": "float-version",
        "method": FIRST_METHOD,
        "params": {"protocolVersion": 1.0},
    }
    _protocol_validator().validate(schema_valid_but_not_wire_valid)

    payload = json.dumps(schema_valid_but_not_wire_valid, separators=(",", ":")).encode()
    with pytest.raises(ProtocolViolation, match="protocol_version_mismatch"):
        parse_request(payload)
