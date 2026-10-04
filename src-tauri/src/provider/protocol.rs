use std::{
    collections::HashSet,
    error::Error,
    fmt,
    io::{self, BufRead},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::PROVIDER_PROTOCOL_VERSION;

pub const MAX_LINE_BYTES: usize = 1_048_576;
pub const MAX_JSON_DEPTH: usize = 128;
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_NAME_CHARS: usize = 128;
const MAX_WARNING_MESSAGE_CHARS: usize = 512;
const MAX_WARNINGS: usize = 128;
const MAX_WARNING_INDEX: u64 = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    Io(String),
    EmptyLine,
    LineTooLong,
    InvalidUtf8,
    Utf8BomNotAllowed,
    JsonNestingTooDeep,
    DuplicateJsonKey(String),
    InvalidJson,
    FrameNotObject,
    InvalidFrameShape,
    ProtocolVersionMismatch,
    InvalidRequestId,
    InvalidMethod,
    InvalidParams,
    InvalidWarning,
    InvalidError,
    InvalidEvent,
    UnknownResponseId(String),
    DuplicateResponseId(String),
}

impl ProtocolError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "protocol_io_failed",
            Self::EmptyLine => "empty_line",
            Self::LineTooLong => "line_too_long",
            Self::InvalidUtf8 => "invalid_utf8",
            Self::Utf8BomNotAllowed => "utf8_bom_not_allowed",
            Self::JsonNestingTooDeep => "json_nesting_too_deep",
            Self::DuplicateJsonKey(_) => "duplicate_json_key",
            Self::InvalidJson => "invalid_json",
            Self::FrameNotObject => "frame_not_object",
            Self::InvalidFrameShape => "invalid_frame_shape",
            Self::ProtocolVersionMismatch => "protocol_version_mismatch",
            Self::InvalidRequestId => "invalid_request_id",
            Self::InvalidMethod => "invalid_method",
            Self::InvalidParams => "invalid_params_shape",
            Self::InvalidWarning => "invalid_warning",
            Self::InvalidError => "invalid_error",
            Self::InvalidEvent => "invalid_event",
            Self::UnknownResponseId(_) => "unknown_response_id",
            Self::DuplicateResponseId(_) => "duplicate_response_id",
        }
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => write!(formatter, "{}: {message}", self.code()),
            Self::DuplicateJsonKey(key) => write!(formatter, "{}: {key}", self.code()),
            Self::UnknownResponseId(id) | Self::DuplicateResponseId(id) => {
                write!(formatter, "{}: {id}", self.code())
            }
            _ => formatter.write_str(self.code()),
        }
    }
}

impl Error for ProtocolError {}

impl From<io::Error> for ProtocolError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestFrame {
    #[serde(rename = "v")]
    pub(crate) version: u16,
    pub id: String,
    pub method: String,
    pub params: Map<String, Value>,
}

impl RequestFrame {
    pub fn new(
        id: impl Into<String>,
        method: impl Into<String>,
        params: Map<String, Value>,
    ) -> Result<Self, ProtocolError> {
        let frame = Self {
            version: PROVIDER_PROTOCOL_VERSION,
            id: id.into(),
            method: method.into(),
            params,
        };
        frame.validate()?;
        Ok(frame)
    }

    pub fn parse(payload: &[u8]) -> Result<Self, ProtocolError> {
        let value = parse_json_value(payload)?;
        validate_version(&value)?;
        let frame: Self =
            serde_json::from_value(value).map_err(|_| ProtocolError::InvalidFrameShape)?;
        frame.validate()?;
        Ok(frame)
    }

    pub fn encoded_line(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        let mut encoded = serde_json::to_vec(self).map_err(|_| ProtocolError::InvalidFrameShape)?;
        if encoded.len() > MAX_LINE_BYTES {
            return Err(ProtocolError::LineTooLong);
        }
        let encoded_text = std::str::from_utf8(&encoded).map_err(|_| ProtocolError::InvalidUtf8)?;
        JsonScanner::new(encoded_text).validate()?;
        encoded.push(b'\n');
        Ok(encoded)
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        if self.version != PROVIDER_PROTOCOL_VERSION {
            return Err(ProtocolError::ProtocolVersionMismatch);
        }
        validate_request_id(&self.id)?;
        validate_name(&self.method).map_err(|_| ProtocolError::InvalidMethod)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WarningFrame {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuccessFrame {
    #[serde(rename = "v")]
    pub(crate) version: u16,
    pub id: String,
    pub(crate) ok: bool,
    pub result: Map<String, Value>,
    pub warnings: Vec<WarningFrame>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderFailure {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FailureFrame {
    #[serde(rename = "v")]
    pub(crate) version: u16,
    pub id: String,
    pub(crate) ok: bool,
    pub error: ProviderFailure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventFrame {
    #[serde(rename = "v")]
    pub(crate) version: u16,
    pub event: String,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProviderFrame {
    Success(SuccessFrame),
    Failure(FailureFrame),
    Event(EventFrame),
}

impl ProviderFrame {
    pub fn parse(payload: &[u8]) -> Result<Self, ProtocolError> {
        let value = parse_json_value(payload)?;
        validate_version(&value)?;
        let object = value.as_object().ok_or(ProtocolError::FrameNotObject)?;

        if object.contains_key("event") {
            let frame: EventFrame =
                serde_json::from_value(value).map_err(|_| ProtocolError::InvalidFrameShape)?;
            validate_name(&frame.event).map_err(|_| ProtocolError::InvalidEvent)?;
            return Ok(Self::Event(frame));
        }

        let ok = object
            .get("ok")
            .and_then(Value::as_bool)
            .ok_or(ProtocolError::InvalidFrameShape)?;
        if ok {
            let frame: SuccessFrame =
                serde_json::from_value(value).map_err(|_| ProtocolError::InvalidFrameShape)?;
            frame.validate()?;
            Ok(Self::Success(frame))
        } else {
            let frame: FailureFrame =
                serde_json::from_value(value).map_err(|_| ProtocolError::InvalidFrameShape)?;
            frame.validate()?;
            Ok(Self::Failure(frame))
        }
    }

    pub fn response_id(&self) -> Option<&str> {
        match self {
            Self::Success(frame) => Some(&frame.id),
            Self::Failure(frame) => Some(&frame.id),
            Self::Event(_) => None,
        }
    }
}

impl SuccessFrame {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.version != PROVIDER_PROTOCOL_VERSION {
            return Err(ProtocolError::ProtocolVersionMismatch);
        }
        if !self.ok {
            return Err(ProtocolError::InvalidFrameShape);
        }
        validate_request_id(&self.id)?;
        if self.warnings.len() > MAX_WARNINGS {
            return Err(ProtocolError::InvalidWarning);
        }
        for warning in &self.warnings {
            validate_name(&warning.code).map_err(|_| ProtocolError::InvalidWarning)?;
            if warning.count == Some(0)
                || warning
                    .message
                    .as_ref()
                    .is_some_and(|message| message.chars().count() > MAX_WARNING_MESSAGE_CHARS)
                || warning
                    .entity
                    .as_ref()
                    .is_some_and(|entity| validate_name(entity).is_err())
                || warning.index.is_some_and(|index| index > MAX_WARNING_INDEX)
            {
                return Err(ProtocolError::InvalidWarning);
            }
        }
        Ok(())
    }
}

impl FailureFrame {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.version != PROVIDER_PROTOCOL_VERSION {
            return Err(ProtocolError::ProtocolVersionMismatch);
        }
        if self.ok {
            return Err(ProtocolError::InvalidFrameShape);
        }
        validate_request_id(&self.id)?;
        validate_name(&self.error.code).map_err(|_| ProtocolError::InvalidError)
    }
}

pub(crate) fn read_provider_frame<R: BufRead>(
    reader: &mut R,
) -> Result<Option<ProviderFrame>, ProtocolError> {
    let Some(payload) = read_bounded_payload(reader)? else {
        return Ok(None);
    };
    ProviderFrame::parse(&payload).map(Some)
}

pub(crate) fn read_bounded_payload<R: BufRead>(
    reader: &mut R,
) -> Result<Option<Vec<u8>>, ProtocolError> {
    let mut payload = Vec::new();
    let mut read_anything = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if !read_anything {
                return Ok(None);
            }
            break;
        }

        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if payload.len() + newline > MAX_LINE_BYTES + 1 {
                return Err(ProtocolError::LineTooLong);
            }
            payload.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            break;
        }

        if payload.len() + available.len() > MAX_LINE_BYTES + 1 {
            return Err(ProtocolError::LineTooLong);
        }
        let consumed = available.len();
        payload.extend_from_slice(available);
        reader.consume(consumed);
        read_anything = true;
    }

    if payload.last() == Some(&b'\r') {
        payload.pop();
    }
    if payload.len() > MAX_LINE_BYTES {
        return Err(ProtocolError::LineTooLong);
    }
    if payload.is_empty() {
        return Err(ProtocolError::EmptyLine);
    }
    Ok(Some(payload))
}

fn validate_version(value: &Value) -> Result<(), ProtocolError> {
    let object = value.as_object().ok_or(ProtocolError::FrameNotObject)?;
    let version = object
        .get("v")
        .and_then(Value::as_u64)
        .ok_or(ProtocolError::ProtocolVersionMismatch)?;
    if version != u64::from(PROVIDER_PROTOCOL_VERSION) {
        return Err(ProtocolError::ProtocolVersionMismatch);
    }
    Ok(())
}

fn validate_request_id(id: &str) -> Result<(), ProtocolError> {
    let bytes = id.as_bytes();
    let valid_first = bytes.first().is_some_and(u8::is_ascii_alphanumeric);
    let valid_rest = bytes
        .iter()
        .skip(1)
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-'));
    if bytes.is_empty() || bytes.len() > MAX_REQUEST_ID_BYTES || !valid_first || !valid_rest {
        return Err(ProtocolError::InvalidRequestId);
    }
    Ok(())
}

fn validate_name(value: &str) -> Result<(), ()> {
    if value.is_empty() || value.chars().count() > MAX_NAME_CHARS {
        Err(())
    } else {
        Ok(())
    }
}

fn parse_json_value(payload: &[u8]) -> Result<Value, ProtocolError> {
    let decoded = std::str::from_utf8(payload).map_err(|_| ProtocolError::InvalidUtf8)?;
    if decoded.starts_with('\u{feff}') {
        return Err(ProtocolError::Utf8BomNotAllowed);
    }
    JsonScanner::new(decoded).validate()?;

    let mut deserializer = serde_json::Deserializer::from_str(decoded);
    deserializer.disable_recursion_limit();
    let value = Value::deserialize(&mut deserializer).map_err(|_| ProtocolError::InvalidJson)?;
    deserializer.end().map_err(|_| ProtocolError::InvalidJson)?;
    Ok(value)
}

struct JsonScanner<'a> {
    input: &'a str,
    bytes: &'a [u8],
    position: usize,
}

impl<'a> JsonScanner<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            input,
            bytes: input.as_bytes(),
            position: 0,
        }
    }

    fn validate(mut self) -> Result<(), ProtocolError> {
        self.skip_whitespace();
        self.scan_value(0)?;
        self.skip_whitespace();
        if self.position != self.bytes.len() {
            return Err(ProtocolError::InvalidJson);
        }
        Ok(())
    }

    fn scan_value(&mut self, depth: usize) -> Result<(), ProtocolError> {
        self.skip_whitespace();
        match self.bytes.get(self.position) {
            Some(b'{') => self.scan_object(depth + 1),
            Some(b'[') => self.scan_array(depth + 1),
            Some(b'"') => self.scan_string().map(|_| ()),
            Some(_) => self.scan_scalar(),
            None => Err(ProtocolError::InvalidJson),
        }
    }

    fn scan_object(&mut self, depth: usize) -> Result<(), ProtocolError> {
        self.check_depth(depth)?;
        self.position += 1;
        self.skip_whitespace();
        if self.consume_if(b'}') {
            return Ok(());
        }

        let mut keys = HashSet::new();
        loop {
            self.skip_whitespace();
            if self.bytes.get(self.position) != Some(&b'"') {
                return Err(ProtocolError::InvalidJson);
            }
            let key = self.scan_string()?;
            if !keys.insert(key.clone()) {
                return Err(ProtocolError::DuplicateJsonKey(key));
            }
            self.skip_whitespace();
            if !self.consume_if(b':') {
                return Err(ProtocolError::InvalidJson);
            }
            self.scan_value(depth)?;
            self.skip_whitespace();
            if self.consume_if(b'}') {
                return Ok(());
            }
            if !self.consume_if(b',') {
                return Err(ProtocolError::InvalidJson);
            }
        }
    }

    fn scan_array(&mut self, depth: usize) -> Result<(), ProtocolError> {
        self.check_depth(depth)?;
        self.position += 1;
        self.skip_whitespace();
        if self.consume_if(b']') {
            return Ok(());
        }

        loop {
            self.scan_value(depth)?;
            self.skip_whitespace();
            if self.consume_if(b']') {
                return Ok(());
            }
            if !self.consume_if(b',') {
                return Err(ProtocolError::InvalidJson);
            }
        }
    }

    fn scan_string(&mut self) -> Result<String, ProtocolError> {
        let start = self.position;
        self.position += 1;
        let mut escaped = false;
        while let Some(byte) = self.bytes.get(self.position).copied() {
            self.position += 1;
            if escaped {
                escaped = false;
                continue;
            }
            match byte {
                b'\\' => escaped = true,
                b'"' => {
                    let slice = &self.input[start..self.position];
                    return serde_json::from_str(slice).map_err(|_| ProtocolError::InvalidJson);
                }
                0x00..=0x1f => return Err(ProtocolError::InvalidJson),
                _ => {}
            }
        }
        Err(ProtocolError::InvalidJson)
    }

    fn scan_scalar(&mut self) -> Result<(), ProtocolError> {
        let start = self.position;
        while let Some(byte) = self.bytes.get(self.position) {
            if byte.is_ascii_whitespace() || matches!(*byte, b',' | b']' | b'}') {
                break;
            }
            self.position += 1;
        }
        if self.position == start {
            Err(ProtocolError::InvalidJson)
        } else {
            Ok(())
        }
    }

    fn check_depth(&self, depth: usize) -> Result<(), ProtocolError> {
        if depth > MAX_JSON_DEPTH {
            Err(ProtocolError::JsonNestingTooDeep)
        } else {
            Ok(())
        }
    }

    fn skip_whitespace(&mut self) {
        while self
            .bytes
            .get(self.position)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.position += 1;
        }
    }

    fn consume_if(&mut self, expected: u8) -> bool {
        if self.bytes.get(self.position) == Some(&expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Cursor, path::PathBuf};

    use super::*;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("provider-v1")
            .join(name)
    }

    #[test]
    fn valid_request_fixture_round_trips_as_strict_typed_frames() {
        let fixture = fs::read_to_string(fixture("valid-requests.ndjson"))
            .expect("valid request fixture must be readable");
        let frames = fixture
            .lines()
            .map(|line| RequestFrame::parse(line.as_bytes()).expect("request fixture must parse"))
            .collect::<Vec<_>>();

        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].method, "system.handshake");
        assert_eq!(frames[2].params["keyword"], "晴天");
        for frame in frames {
            let encoded = frame.encoded_line().expect("request must serialize");
            assert!(encoded.len() <= MAX_LINE_BYTES + 1);
            assert_eq!(
                RequestFrame::parse(&encoded[..encoded.len() - 1]),
                Ok(frame)
            );
        }
    }

    #[test]
    fn provider_response_fixtures_parse_in_wire_order() {
        let fixture = fs::read_to_string(fixture("out-of-order-responses.ndjson"))
            .expect("response fixture must be readable");
        let ids = fixture
            .lines()
            .map(|line| {
                ProviderFrame::parse(line.as_bytes())
                    .expect("response must parse")
                    .response_id()
                    .expect("terminal response has an id")
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(ids, ["search-2", "search-1"]);
    }

    #[test]
    fn parser_rejects_duplicate_keys_at_any_depth() {
        let duplicate = br#"{"v":1,"id":"a","ok":true,"result":{"same":1,"same":2},"warnings":[]}"#;
        assert!(matches!(
            ProviderFrame::parse(duplicate),
            Err(ProtocolError::DuplicateJsonKey(key)) if key == "same"
        ));
    }

    #[test]
    fn item_warning_context_is_wire_compatible_and_bounded() {
        let warning = ProviderFrame::parse(
            br#"{"v":1,"id":"playlist-1","ok":true,"result":{},"warnings":[{"code":"item_invalid","entity":"song","index":4}]}"#,
        )
        .expect("item warning must parse");
        match warning {
            ProviderFrame::Success(frame) => {
                assert_eq!(frame.warnings[0].entity.as_deref(), Some("song"));
                assert_eq!(frame.warnings[0].index, Some(4));
            }
            _ => panic!("expected success frame"),
        }

        let oversized_index =
            br#"{"v":1,"id":"playlist-1","ok":true,"result":{},"warnings":[{"code":"item_invalid","entity":"song","index":1000001}]}"#;
        assert_eq!(
            ProviderFrame::parse(oversized_index),
            Err(ProtocolError::InvalidWarning)
        );
    }

    #[test]
    fn version_invalid_utf8_and_oversized_recipes_are_enforced() {
        let version =
            fs::read(fixture("version-mismatch.ndjson")).expect("version fixture must be readable");
        assert_eq!(
            ProviderFrame::parse(version.strip_suffix(b"\n").unwrap_or(&version)),
            Err(ProtocolError::ProtocolVersionMismatch)
        );

        let hex = fs::read_to_string(fixture("invalid-utf8.hex"))
            .expect("invalid UTF-8 fixture must be readable");
        let compact = hex
            .lines()
            .map(|line| line.split('#').next().unwrap_or_default())
            .collect::<String>();
        let bytes = (0..compact.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&compact[index..index + 2], 16).expect("valid hex"))
            .collect::<Vec<_>>();
        assert_eq!(
            ProviderFrame::parse(&bytes),
            Err(ProtocolError::InvalidUtf8)
        );

        let recipe: Value = serde_json::from_str(
            &fs::read_to_string(fixture("oversized-line.json"))
                .expect("oversized recipe must be readable"),
        )
        .expect("oversized recipe must be JSON");
        let extra = recipe["extraBytes"].as_u64().expect("extraBytes") as usize;
        let oversized = vec![b'x'; MAX_LINE_BYTES + extra];
        assert_eq!(
            read_bounded_payload(&mut Cursor::new([oversized, vec![b'\n']].concat())),
            Err(ProtocolError::LineTooLong)
        );
    }

    #[test]
    fn exact_crlf_boundary_and_typed_failure_event_are_supported() {
        let payload = vec![b'x'; MAX_LINE_BYTES];
        let mut framed = payload.clone();
        framed.extend_from_slice(b"\r\n");
        assert_eq!(
            read_bounded_payload(&mut Cursor::new(framed)),
            Ok(Some(payload))
        );

        let failure = ProviderFrame::parse(
            br#"{"v":1,"id":"ping-1","ok":false,"error":{"code":"unavailable","retryable":true}}"#,
        )
        .expect("failure frame must parse");
        assert!(matches!(failure, ProviderFrame::Failure(_)));

        let event = ProviderFrame::parse(
            br#"{"v":1,"event":"auth.expired","payload":{"reason":"fixture"}}"#,
        )
        .expect("event frame must parse");
        assert!(matches!(event, ProviderFrame::Event(_)));
    }

    #[test]
    fn outbound_request_enforces_the_same_depth_limit_as_inbound_frames() {
        let mut nested = Value::Object(Map::new());
        for _ in 0..MAX_JSON_DEPTH {
            nested = Value::Array(vec![nested]);
        }
        let request = RequestFrame::new(
            "deep-1",
            "fixture.deep",
            Map::from_iter([("nested".to_owned(), nested)]),
        )
        .expect("shape is valid before encoding");
        assert_eq!(
            request.encoded_line(),
            Err(ProtocolError::JsonNestingTooDeep)
        );
    }
}
