use std::{
    sync::{Arc, Condvar, Mutex, RwLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use zeroize::Zeroize;

use crate::{
    credentials::{CredentialError, CredentialStore, SecretBlob},
    provider::{
        ProviderError, ProviderRecoveryHook, ProviderRecoveryPort, ProviderReply, ProviderRequest,
        ProviderRequestPort,
    },
};

const QR_POLL_TIMEOUT: Duration = Duration::from_secs(40);
const MAX_QR_IMAGE_BASE64_CHARS: usize = 700_000;
pub const AUTH_QR_PROVIDER_EVENT: &str = "auth.qr";
pub const AUTH_QR_RENDERER_EVENT: &str = "auth_qr_event";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    ProviderUnavailable,
    ProviderRejected,
    NetworkUnavailable,
    RateLimited,
    SessionNotFound,
    AccountRestricted,
    DeviceLimit,
    UpstreamSchemaChanged,
    InvalidResponse,
    CredentialUnavailable,
    CredentialInvalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum AuthQrEvent {
    WaitingScan {
        session_id: String,
    },
    WaitingConfirmation {
        session_id: String,
    },
    Authenticated {
        session_id: String,
        account: PublicAccount,
    },
    Expired {
        session_id: String,
    },
    Rejected {
        session_id: String,
    },
    Error {
        session_id: String,
        code: String,
        retryable: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthQrEventError {
    pub session_id: String,
    pub error: AuthError,
}

impl AuthError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ProviderUnavailable => "auth_provider_unavailable",
            Self::ProviderRejected => "auth_provider_rejected",
            Self::NetworkUnavailable => "auth_network_unavailable",
            Self::RateLimited => "auth_rate_limited",
            Self::SessionNotFound => "auth_session_not_found",
            Self::AccountRestricted => "auth_account_restricted",
            Self::DeviceLimit => "auth_device_limit",
            Self::UpstreamSchemaChanged => "auth_upstream_schema_changed",
            Self::InvalidResponse => "auth_invalid_response",
            Self::CredentialUnavailable => "auth_credential_store_unavailable",
            Self::CredentialInvalid => "auth_credential_invalid",
        }
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for AuthError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QrLoginStart {
    pub session_id: String,
    pub login_method: String,
    pub mime_type: String,
    pub image_base64: String,
    pub expires_at_ms: u64,
    pub poll_after_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicAccount {
    pub music_id: String,
    pub login_method: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum QrLoginState {
    WaitingScan {
        session_id: String,
    },
    WaitingConfirmation {
        session_id: String,
    },
    Authenticated {
        session_id: String,
        account: PublicAccount,
    },
    Expired {
        session_id: String,
    },
    Rejected {
        session_id: String,
    },
    Cancelled {
        session_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum RecoveryState {
    SignedOut,
    Authenticated { account: PublicAccount },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutResult {
    pub upstream_revoked: bool,
}

pub struct AuthService {
    provider: Arc<dyn ProviderRequestPort>,
    credential_store: Arc<dyn CredentialStore>,
}

pub struct AuthRecoveryCoordinator {
    credential_store: Arc<dyn CredentialStore>,
    state: RwLock<RecoveryState>,
    flight: Mutex<RecoveryFlight>,
    flight_changed: Condvar,
}

#[derive(Default)]
struct RecoveryFlight {
    current_generation: u64,
    in_progress: Option<u64>,
    completed: u64,
    last_authenticated: bool,
}

impl AuthRecoveryCoordinator {
    pub fn new(credential_store: Arc<dyn CredentialStore>) -> Self {
        Self {
            credential_store,
            state: RwLock::new(RecoveryState::SignedOut),
            flight: Mutex::new(RecoveryFlight::default()),
            flight_changed: Condvar::new(),
        }
    }

    pub fn state(&self) -> RecoveryState {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn recovery_marker(&self) -> (u64, u64) {
        let flight = self
            .flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (flight.current_generation, flight.completed)
    }

    fn recover_runtime(
        &self,
        generation: u64,
        observed_completion: u64,
        provider: &dyn ProviderRequestPort,
    ) -> Result<bool, ProviderError> {
        let mut flight = self
            .flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if flight.current_generation != generation {
                return Ok(matches!(self.state(), RecoveryState::Authenticated { .. }));
            }
            if flight.completed != observed_completion {
                return Ok(flight.last_authenticated);
            }
            if flight.in_progress == Some(generation) {
                flight = self
                    .flight_changed
                    .wait(flight)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                continue;
            }
            flight.in_progress = Some(generation);
            break;
        }
        drop(flight);

        let mut request = |request| provider.request(request);
        let recovered = recover_credential(self.credential_store.as_ref(), &mut request)
            .map_err(|_| ProviderError::Unavailable);
        let authenticated = matches!(recovered, Ok(RecoveryState::Authenticated { .. }));
        if let Ok(state) = &recovered {
            *self
                .state
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = state.clone();
        }

        let mut flight = self
            .flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if recovered.is_ok() {
            flight.completed = flight.completed.wrapping_add(1);
            flight.last_authenticated = authenticated;
        }
        if flight.in_progress == Some(generation) {
            flight.in_progress = None;
        }
        self.flight_changed.notify_all();
        recovered.map(|_| authenticated)
    }
}

impl ProviderRecoveryHook for AuthRecoveryCoordinator {
    fn recover(
        &self,
        _generation: u64,
        provider: &mut dyn ProviderRecoveryPort,
    ) -> Result<(), ProviderError> {
        let mut request = |request| provider.request(request);
        let state = recover_credential(self.credential_store.as_ref(), &mut request)
            .map_err(|_| ProviderError::Unavailable)?;
        *self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = state;
        let mut flight = self
            .flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        flight.current_generation = _generation;
        flight.completed = flight.completed.wrapping_add(1);
        flight.last_authenticated = matches!(self.state(), RecoveryState::Authenticated { .. });
        flight.in_progress = None;
        self.flight_changed.notify_all();
        Ok(())
    }
}

pub struct RecoveringProviderPort {
    raw: Arc<dyn ProviderRequestPort>,
    recovery: Arc<AuthRecoveryCoordinator>,
}

impl RecoveringProviderPort {
    pub fn new(raw: Arc<dyn ProviderRequestPort>, recovery: Arc<AuthRecoveryCoordinator>) -> Self {
        Self { raw, recovery }
    }
}

impl ProviderRequestPort for RecoveringProviderPort {
    fn request(&self, request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
        if request.semantics() == crate::provider::RequestSemantics::WriteNeverReplay {
            return self.raw.request(request);
        }
        let retry = request.clone();
        let (generation, recovery_completion) = self.recovery.recovery_marker();
        let reply = self.raw.request(request)?;
        let authentication_required = matches!(
            &reply,
            ProviderReply::Failure { code, .. } if code == "authentication_required"
        );
        if !authentication_required
            || !self
                .recovery
                .recover_runtime(generation, recovery_completion, self.raw.as_ref())?
        {
            return Ok(reply);
        }
        self.raw.request(retry)
    }
}

impl AuthService {
    pub fn new(
        provider: Arc<dyn ProviderRequestPort>,
        credential_store: Arc<dyn CredentialStore>,
    ) -> Self {
        Self {
            provider,
            credential_store,
        }
    }

    pub fn start_qr(&self, login_method: &str) -> Result<QrLoginStart, AuthError> {
        if !matches!(login_method, "qq" | "wx") {
            return Err(AuthError::ProviderRejected);
        }
        let params = Map::from_iter([(
            "loginMethod".to_owned(),
            Value::String(login_method.to_owned()),
        )]);
        let result = self.success_result(ProviderRequest::write("auth.qr.start", params))?;
        let start: QrLoginStart = serde_json::from_value(Value::Object(result))
            .map_err(|_| AuthError::InvalidResponse)?;
        if start.session_id.is_empty()
            || start.session_id.len() > 128
            || !matches!(start.login_method.as_str(), "qq" | "wx")
            || !matches!(start.mime_type.as_str(), "image/png" | "image/jpeg")
            || start.image_base64.is_empty()
            || start.image_base64.len() > MAX_QR_IMAGE_BASE64_CHARS
            || start.poll_after_ms < 250
            || start.poll_after_ms > 10_000
        {
            return Err(AuthError::InvalidResponse);
        }
        Ok(start)
    }

    pub fn poll_qr(&self, session_id: &str) -> Result<QrLoginState, AuthError> {
        let mut result = self.success_result(
            ProviderRequest::write("auth.qr.poll", session_param(session_id)?)
                .with_timeout(QR_POLL_TIMEOUT),
        )?;
        let returned_session = take_string(&mut result, "sessionId")?;
        if returned_session != session_id {
            zeroize_map(&mut result);
            return Err(AuthError::InvalidResponse);
        }
        let state = take_string(&mut result, "state")?;
        let public = match state.as_str() {
            "waiting_scan" if result.is_empty() => QrLoginState::WaitingScan {
                session_id: returned_session,
            },
            "waiting_confirmation" if result.is_empty() => QrLoginState::WaitingConfirmation {
                session_id: returned_session,
            },
            "expired" if result.is_empty() => QrLoginState::Expired {
                session_id: returned_session,
            },
            "rejected" if result.is_empty() => QrLoginState::Rejected {
                session_id: returned_session,
            },
            "authenticated" => {
                let credential = result
                    .remove("credential")
                    .ok_or(AuthError::InvalidResponse)?;
                let account = result.remove("account").ok_or(AuthError::InvalidResponse)?;
                if !result.is_empty() {
                    let mut credential = credential;
                    zeroize_value(&mut credential);
                    zeroize_map(&mut result);
                    return Err(AuthError::InvalidResponse);
                }
                let account: AccountEnvelope =
                    serde_json::from_value(account).map_err(|_| AuthError::InvalidResponse)?;
                if account.music_id.is_empty()
                    || account.music_id.len() > 32
                    || !account
                        .music_id
                        .chars()
                        .all(|character| character.is_ascii_digit())
                    || !matches!(account.login_method.as_str(), "qq" | "wx")
                {
                    let mut credential = credential;
                    zeroize_value(&mut credential);
                    return Err(AuthError::InvalidResponse);
                }
                self.replace_credential(credential)?;
                QrLoginState::Authenticated {
                    session_id: returned_session,
                    account: PublicAccount {
                        music_id: account.music_id,
                        login_method: account.login_method,
                    },
                }
            }
            _ => {
                zeroize_map(&mut result);
                return Err(AuthError::InvalidResponse);
            }
        };
        Ok(public)
    }

    pub fn apply_qr_event(
        &self,
        mut payload: Map<String, Value>,
    ) -> Result<AuthQrEvent, AuthQrEventError> {
        let session_id = match take_string(&mut payload, "sessionId") {
            Ok(value) => value,
            Err(error) => {
                zeroize_map(&mut payload);
                return Err(AuthQrEventError {
                    session_id: String::new(),
                    error,
                });
            }
        };
        let state = match take_string(&mut payload, "state") {
            Ok(value) => value,
            Err(error) => {
                zeroize_map(&mut payload);
                return Err(AuthQrEventError {
                    session_id: session_id.clone(),
                    error,
                });
            }
        };
        match state.as_str() {
            "waiting_scan" if payload.is_empty() => Ok(AuthQrEvent::WaitingScan { session_id }),
            "waiting_confirmation" if payload.is_empty() => {
                Ok(AuthQrEvent::WaitingConfirmation { session_id })
            }
            "expired" if payload.is_empty() => Ok(AuthQrEvent::Expired { session_id }),
            "rejected" if payload.is_empty() => Ok(AuthQrEvent::Rejected { session_id }),
            "error" => {
                let code = take_string(&mut payload, "code").map_err(|error| AuthQrEventError {
                    session_id: session_id.clone(),
                    error,
                })?;
                let retryable = match payload.remove("retryable") {
                    Some(Value::Bool(value)) => value,
                    Some(mut value) => {
                        zeroize_value(&mut value);
                        return Err(AuthQrEventError {
                            session_id,
                            error: AuthError::InvalidResponse,
                        });
                    }
                    None => {
                        return Err(AuthQrEventError {
                            session_id,
                            error: AuthError::InvalidResponse,
                        });
                    }
                };
                if !is_safe_auth_event_code(&code) || !payload.is_empty() {
                    zeroize_map(&mut payload);
                    return Err(AuthQrEventError {
                        session_id,
                        error: AuthError::InvalidResponse,
                    });
                }
                Ok(AuthQrEvent::Error {
                    session_id,
                    code,
                    retryable,
                })
            }
            "authenticated" => {
                let credential = payload.remove("credential").ok_or(AuthQrEventError {
                    session_id: session_id.clone(),
                    error: AuthError::InvalidResponse,
                })?;
                let account = match payload.remove("account") {
                    Some(account) => account,
                    None => {
                        let mut credential = credential;
                        zeroize_value(&mut credential);
                        return Err(AuthQrEventError {
                            session_id: session_id.clone(),
                            error: AuthError::InvalidResponse,
                        });
                    }
                };
                if !payload.is_empty() {
                    let mut credential = credential;
                    zeroize_value(&mut credential);
                    zeroize_map(&mut payload);
                    return Err(AuthQrEventError {
                        session_id,
                        error: AuthError::InvalidResponse,
                    });
                }
                let account: AccountEnvelope = match serde_json::from_value(account) {
                    Ok(account) => account,
                    Err(_) => {
                        let mut credential = credential;
                        zeroize_value(&mut credential);
                        return Err(AuthQrEventError {
                            session_id,
                            error: AuthError::InvalidResponse,
                        });
                    }
                };
                if account.music_id.is_empty()
                    || account.music_id.len() > 32
                    || !account
                        .music_id
                        .chars()
                        .all(|character| character.is_ascii_digit())
                    || !matches!(account.login_method.as_str(), "qq" | "wx")
                {
                    let mut credential = credential;
                    zeroize_value(&mut credential);
                    return Err(AuthQrEventError {
                        session_id,
                        error: AuthError::InvalidResponse,
                    });
                }
                self.replace_credential(credential)
                    .map_err(|error| AuthQrEventError {
                        session_id: session_id.clone(),
                        error,
                    })?;
                Ok(AuthQrEvent::Authenticated {
                    session_id,
                    account: PublicAccount {
                        music_id: account.music_id,
                        login_method: account.login_method,
                    },
                })
            }
            _ => {
                zeroize_map(&mut payload);
                Err(AuthQrEventError {
                    session_id,
                    error: AuthError::InvalidResponse,
                })
            }
        }
    }

    pub fn cancel_qr(&self, session_id: &str) -> Result<QrLoginState, AuthError> {
        let mut result = self.success_result(ProviderRequest::write(
            "auth.qr.cancel",
            session_param(session_id)?,
        ))?;
        let returned_session = take_string(&mut result, "sessionId")?;
        let state = take_string(&mut result, "state")?;
        if returned_session != session_id || state != "cancelled" || !result.is_empty() {
            zeroize_map(&mut result);
            return Err(AuthError::InvalidResponse);
        }
        Ok(QrLoginState::Cancelled {
            session_id: returned_session,
        })
    }

    pub fn recover(&self) -> Result<RecoveryState, AuthError> {
        let mut request = |request| self.provider.request(request);
        recover_credential(self.credential_store.as_ref(), &mut request)
    }

    pub fn refresh(&self) -> Result<RecoveryState, AuthError> {
        let mut request = |request| self.provider.request(request);
        refresh_credential(self.credential_store.as_ref(), &mut request)
    }

    pub fn logout(&self) -> Result<LogoutResult, AuthError> {
        let upstream_revoked =
            match self.success_result(ProviderRequest::write("auth.logout", Map::new())) {
                Ok(result) if is_status(&result, "signed_out") => true,
                Ok(mut result) => {
                    zeroize_map(&mut result);
                    false
                }
                Err(_) => false,
            };
        self.credential_store
            .delete()
            .map_err(map_credential_error)?;
        Ok(LogoutResult { upstream_revoked })
    }

    fn replace_credential(&self, credential: Value) -> Result<(), AuthError> {
        replace_stored_credential(self.credential_store.as_ref(), credential)
    }

    fn success_result(&self, request: ProviderRequest) -> Result<Map<String, Value>, AuthError> {
        normalize_provider_reply(self.provider.request(request).map_err(map_provider_error)?)
    }
}

type AuthRequest<'a> = dyn FnMut(ProviderRequest) -> Result<ProviderReply, ProviderError> + 'a;

fn recover_credential(
    credential_store: &dyn CredentialStore,
    request: &mut AuthRequest<'_>,
) -> Result<RecoveryState, AuthError> {
    let Some(secret) = credential_store.read().map_err(map_credential_error)? else {
        return Ok(RecoveryState::SignedOut);
    };
    let credential: Value = match serde_json::from_slice(secret.payload()) {
        Ok(credential) => credential,
        Err(_) => {
            credential_store.delete().map_err(map_credential_error)?;
            return Ok(RecoveryState::SignedOut);
        }
    };
    if !credential.is_object() {
        credential_store.delete().map_err(map_credential_error)?;
        return Ok(RecoveryState::SignedOut);
    }
    let account = match public_account_from_credential(&credential) {
        Ok(account) => account,
        Err(error) => {
            credential_store.delete().map_err(map_credential_error)?;
            return Err(error);
        }
    };
    let params = Map::from_iter([("credential".to_owned(), credential)]);
    match request_success(
        request,
        ProviderRequest::write("auth.credential.restore", params),
    ) {
        Ok(result) if is_status(&result, "restored") => {}
        Ok(mut result) => {
            zeroize_map(&mut result);
            return Err(AuthError::InvalidResponse);
        }
        Err(AuthError::CredentialInvalid) => {
            credential_store.delete().map_err(map_credential_error)?;
            return Ok(RecoveryState::SignedOut);
        }
        Err(error) => return Err(error),
    }

    match request_success(
        request,
        ProviderRequest::read_only("auth.credential.check", Map::new()),
    ) {
        Ok(result) if is_status(&result, "authenticated") => {
            Ok(RecoveryState::Authenticated { account })
        }
        Ok(result) if is_status(&result, "expired") => {
            refresh_credential(credential_store, request)
        }
        Ok(mut result) => {
            zeroize_map(&mut result);
            Err(AuthError::InvalidResponse)
        }
        Err(AuthError::CredentialInvalid) => {
            credential_store.delete().map_err(map_credential_error)?;
            Ok(RecoveryState::SignedOut)
        }
        Err(error) => Err(error),
    }
}

fn refresh_credential(
    credential_store: &dyn CredentialStore,
    request: &mut AuthRequest<'_>,
) -> Result<RecoveryState, AuthError> {
    let mut result = request_success(
        request,
        ProviderRequest::write("auth.credential.refresh", Map::new()),
    )?;
    let status = take_string(&mut result, "status")?;
    let credential = result
        .remove("credential")
        .ok_or(AuthError::InvalidResponse)?;
    if status != "authenticated" || !result.is_empty() {
        let mut credential = credential;
        zeroize_value(&mut credential);
        return Err(AuthError::InvalidResponse);
    }
    let account = public_account_from_credential(&credential)?;
    replace_stored_credential(credential_store, credential)?;
    Ok(RecoveryState::Authenticated { account })
}

fn replace_stored_credential(
    credential_store: &dyn CredentialStore,
    mut credential: Value,
) -> Result<(), AuthError> {
    let serialized = serde_json::to_vec(&credential).map_err(|_| AuthError::InvalidResponse);
    zeroize_value(&mut credential);
    let secret = SecretBlob::new(serialized?).map_err(map_credential_error)?;
    credential_store
        .replace(&secret)
        .map_err(map_credential_error)
}

fn request_success(
    request: &mut AuthRequest<'_>,
    provider_request: ProviderRequest,
) -> Result<Map<String, Value>, AuthError> {
    normalize_provider_reply(request(provider_request).map_err(map_provider_error)?)
}

fn normalize_provider_reply(reply: ProviderReply) -> Result<Map<String, Value>, AuthError> {
    match reply {
        ProviderReply::Success { result, warnings } if warnings.is_empty() => Ok(result),
        ProviderReply::Success {
            mut result,
            warnings: _,
        } => {
            zeroize_map(&mut result);
            Err(AuthError::InvalidResponse)
        }
        ProviderReply::Failure { code, .. } => Err(map_provider_failure(&code)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountEnvelope {
    music_id: String,
    login_method: String,
}

fn public_account_from_credential(credential: &Value) -> Result<PublicAccount, AuthError> {
    let value = credential.as_object().ok_or(AuthError::CredentialInvalid)?;
    let music_id = value
        .get("musicid")
        .and_then(Value::as_u64)
        .filter(|music_id| *music_id > 0)
        .map(|music_id| music_id.to_string())
        .ok_or(AuthError::CredentialInvalid)?;
    let login_method = match value.get("login_type").and_then(Value::as_u64) {
        Some(1) => "wx",
        Some(2) => "qq",
        _ => return Err(AuthError::CredentialInvalid),
    };
    Ok(PublicAccount {
        music_id,
        login_method: login_method.to_owned(),
    })
}

fn session_param(session_id: &str) -> Result<Map<String, Value>, AuthError> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err(AuthError::ProviderRejected);
    }
    Ok(Map::from_iter([(
        "sessionId".to_owned(),
        Value::String(session_id.to_owned()),
    )]))
}

fn take_string(result: &mut Map<String, Value>, key: &str) -> Result<String, AuthError> {
    match result.remove(key) {
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 128 => Ok(value),
        Some(mut value) => {
            zeroize_value(&mut value);
            Err(AuthError::InvalidResponse)
        }
        None => Err(AuthError::InvalidResponse),
    }
}

fn is_safe_auth_event_code(code: &str) -> bool {
    let mut characters = code.chars();
    matches!(characters.next(), Some(character) if character.is_ascii_lowercase())
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

fn is_status(result: &Map<String, Value>, expected: &str) -> bool {
    result.len() == 1 && result.get("status").and_then(Value::as_str) == Some(expected)
}

fn map_provider_error(_error: ProviderError) -> AuthError {
    AuthError::ProviderUnavailable
}

fn map_provider_failure(code: &str) -> AuthError {
    match code {
        "credential_invalid" => AuthError::CredentialInvalid,
        "auth_network_unavailable" => AuthError::NetworkUnavailable,
        "auth_rate_limited" => AuthError::RateLimited,
        "auth_session_not_found" => AuthError::SessionNotFound,
        "auth_account_restricted" => AuthError::AccountRestricted,
        "auth_device_limit" => AuthError::DeviceLimit,
        "upstream_schema_changed" => AuthError::UpstreamSchemaChanged,
        // Unknown Provider failures are never evidence that the saved credential is invalid.
        // Preserve the secret and let the caller surface a recoverable availability failure.
        _ => AuthError::ProviderUnavailable,
    }
}

fn map_credential_error(error: CredentialError) -> AuthError {
    match error {
        CredentialError::InvalidSecret | CredentialError::UnsupportedVersion => {
            AuthError::CredentialInvalid
        }
        CredentialError::TooLarge => AuthError::CredentialInvalid,
        CredentialError::Unavailable => AuthError::CredentialUnavailable,
    }
}

fn zeroize_map(map: &mut Map<String, Value>) {
    for value in map.values_mut() {
        zeroize_value(value);
    }
    map.clear();
}

fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(secret) => secret.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_value),
        Value::Object(map) => zeroize_map(map),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicU64, Ordering},
            Barrier, Mutex,
        },
        thread,
    };

    use serde_json::json;

    use super::*;
    use crate::credentials::MemoryCredentialStore;

    struct FakeProvider {
        replies: Mutex<VecDeque<Result<ProviderReply, ProviderError>>>,
        requests: AtomicU64,
    }

    struct FakeRecoveryPort {
        replies: VecDeque<Result<ProviderReply, ProviderError>>,
        requests: usize,
    }

    impl ProviderRecoveryPort for FakeRecoveryPort {
        fn request(&mut self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.requests += 1;
            self.replies.pop_front().expect("expected recovery reply")
        }
    }

    impl FakeProvider {
        fn new(replies: impl IntoIterator<Item = ProviderReply>) -> Self {
            Self {
                replies: Mutex::new(replies.into_iter().map(Ok).collect()),
                requests: AtomicU64::new(0),
            }
        }
    }

    impl ProviderRequestPort for FakeProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            self.replies
                .lock()
                .expect("fake replies")
                .pop_front()
                .expect("expected fake reply")
        }
    }

    fn success(value: Value) -> ProviderReply {
        ProviderReply::Success {
            result: value.as_object().expect("object").clone(),
            warnings: Vec::new(),
        }
    }

    fn credential() -> Value {
        json!({
            "openid": "SENTINEL_OPENID",
            "refresh_token": "SENTINEL_REFRESH",
            "access_token": "SENTINEL_ACCESS",
            "expired_at": 1900000000,
            "musicid": 123456,
            "musickey": "SENTINEL_MUSICKEY",
            "unionid": "SENTINEL_UNION",
            "str_musicid": "123456",
            "refresh_key": "SENTINEL_REFRESH_KEY",
            "musickey_create_time": 1800000000,
            "key_expires_in": 86400,
            "first_login": 0,
            "bind_account_type": 0,
            "need_refresh_key_in": 0,
            "encrypt_uin": "SENTINEL_UIN",
            "login_type": 2
        })
    }

    fn service(
        replies: impl IntoIterator<Item = ProviderReply>,
    ) -> (AuthService, Arc<MemoryCredentialStore>) {
        let store = Arc::new(MemoryCredentialStore::default());
        let provider = Arc::new(FakeProvider::new(replies));
        (AuthService::new(provider, store.clone()), store)
    }

    fn recovery_port(
        replies: impl IntoIterator<Item = Result<ProviderReply, ProviderError>>,
    ) -> FakeRecoveryPort {
        FakeRecoveryPort {
            replies: replies.into_iter().collect(),
            requests: 0,
        }
    }

    fn seed_credential(store: &MemoryCredentialStore) {
        let initial = SecretBlob::new(serde_json::to_vec(&credential()).expect("credential JSON"))
            .expect("secret blob");
        store.replace(&initial).expect("seed credential");
    }

    #[test]
    fn qr_success_persists_secret_and_returns_only_public_account() {
        let reply = success(json!({
            "sessionId": "session-1",
            "state": "authenticated",
            "credential": credential(),
            "account": {"musicId": "123456", "loginMethod": "qq"}
        }));
        let (service, store) = service([reply]);

        let result = service.poll_qr("session-1").expect("poll success");

        assert_eq!(
            result,
            QrLoginState::Authenticated {
                session_id: "session-1".to_owned(),
                account: PublicAccount {
                    music_id: "123456".to_owned(),
                    login_method: "qq".to_owned(),
                },
            }
        );
        let stored = store
            .read()
            .expect("store read")
            .expect("stored credential");
        assert!(stored
            .payload()
            .windows(17)
            .any(|part| part == b"SENTINEL_MUSICKEY"));
        assert!(!serde_json::to_string(&result)
            .expect("public result")
            .contains("SENTINEL"));
    }

    #[test]
    fn provider_qr_event_persists_credential_and_projects_public_account() {
        let (service, store) = service([]);
        let payload = json!({
            "sessionId": "session-event",
            "state": "authenticated",
            "credential": credential(),
            "account": {"musicId": "123456", "loginMethod": "qq"}
        })
        .as_object()
        .expect("event payload")
        .clone();

        let event = service
            .apply_qr_event(payload)
            .expect("provider event must be accepted");

        assert_eq!(
            event,
            AuthQrEvent::Authenticated {
                session_id: "session-event".to_owned(),
                account: PublicAccount {
                    music_id: "123456".to_owned(),
                    login_method: "qq".to_owned(),
                },
            }
        );
        assert!(store.read().expect("credential store read").is_some());
        assert!(!serde_json::to_string(&event)
            .expect("public event")
            .contains("SENTINEL"));
    }

    #[test]
    fn recovery_restores_checks_and_refreshes_expired_secret() {
        let replies = [
            success(json!({"status": "restored"})),
            success(json!({"status": "expired"})),
            success(json!({"status": "authenticated", "credential": credential()})),
        ];
        let (service, store) = service(replies);
        let initial = SecretBlob::new(serde_json::to_vec(&credential()).expect("credential JSON"))
            .expect("secret blob");
        store.replace(&initial).expect("seed credential");

        assert_eq!(
            service.recover(),
            Ok(RecoveryState::Authenticated {
                account: PublicAccount {
                    music_id: "123456".to_owned(),
                    login_method: "qq".to_owned(),
                }
            })
        );
        assert!(store.read().expect("read").is_some());
    }

    #[test]
    fn ready_recovery_without_a_stored_credential_is_anonymous_and_sends_nothing() {
        let store = Arc::new(MemoryCredentialStore::default());
        let coordinator = AuthRecoveryCoordinator::new(store);
        let mut provider = recovery_port([]);

        assert_eq!(coordinator.recover(1, &mut provider), Ok(()));
        assert_eq!(coordinator.state(), RecoveryState::SignedOut);
        assert_eq!(provider.requests, 0);
    }

    #[test]
    fn ready_recovery_restores_and_checks_a_valid_credential() {
        let store = Arc::new(MemoryCredentialStore::default());
        seed_credential(store.as_ref());
        let coordinator = AuthRecoveryCoordinator::new(store);
        let mut provider = recovery_port([
            Ok(success(json!({"status": "restored"}))),
            Ok(success(json!({"status": "authenticated"}))),
        ]);

        assert_eq!(coordinator.recover(7, &mut provider), Ok(()));
        assert!(matches!(
            coordinator.state(),
            RecoveryState::Authenticated { .. }
        ));
        assert_eq!(provider.requests, 2);
    }

    #[test]
    fn ready_recovery_refreshes_an_expired_credential() {
        let store = Arc::new(MemoryCredentialStore::default());
        seed_credential(store.as_ref());
        let coordinator = AuthRecoveryCoordinator::new(store.clone());
        let mut provider = recovery_port([
            Ok(success(json!({"status": "restored"}))),
            Ok(success(json!({"status": "expired"}))),
            Ok(success(
                json!({"status": "authenticated", "credential": credential()}),
            )),
        ]);

        assert_eq!(coordinator.recover(8, &mut provider), Ok(()));
        assert!(matches!(
            coordinator.state(),
            RecoveryState::Authenticated { .. }
        ));
        assert!(store.read().expect("read refreshed credential").is_some());
        assert_eq!(provider.requests, 3);
    }

    #[test]
    fn ready_recovery_transport_failure_preserves_the_stored_credential() {
        let store = Arc::new(MemoryCredentialStore::default());
        seed_credential(store.as_ref());
        let coordinator = AuthRecoveryCoordinator::new(store.clone());
        let mut provider = recovery_port([Err(ProviderError::Unavailable)]);

        assert_eq!(
            coordinator.recover(9, &mut provider),
            Err(ProviderError::Unavailable)
        );
        assert!(store.read().expect("read preserved credential").is_some());
    }

    #[test]
    fn rejected_restore_deletes_invalid_stored_credential() {
        let reply = ProviderReply::Failure {
            code: "credential_invalid".to_owned(),
            retryable: false,
        };
        let (service, store) = service([reply]);
        let initial = SecretBlob::new(serde_json::to_vec(&credential()).expect("credential JSON"))
            .expect("secret blob");
        store.replace(&initial).expect("seed credential");

        assert_eq!(service.recover(), Ok(RecoveryState::SignedOut));
        assert!(store.read().expect("read").is_none());
    }

    #[test]
    fn temporary_or_unknown_restore_failures_preserve_stored_credential() {
        for code in [
            "upstream_timeout",
            "outcome_unknown",
            "future_provider_failure",
        ] {
            let reply = ProviderReply::Failure {
                code: code.to_owned(),
                retryable: true,
            };
            let (service, store) = service([reply]);
            seed_credential(store.as_ref());

            assert_eq!(service.recover(), Err(AuthError::ProviderUnavailable));
            assert!(
                store.read().expect("read preserved credential").is_some(),
                "{code} must not delete the credential"
            );
        }
    }

    #[test]
    fn temporary_or_unknown_check_failures_preserve_stored_credential() {
        for code in [
            "upstream_timeout",
            "outcome_unknown",
            "future_provider_failure",
        ] {
            let replies = [
                success(json!({"status": "restored"})),
                ProviderReply::Failure {
                    code: code.to_owned(),
                    retryable: true,
                },
            ];
            let (service, store) = service(replies);
            seed_credential(store.as_ref());

            assert_eq!(service.recover(), Err(AuthError::ProviderUnavailable));
            assert!(
                store.read().expect("read preserved credential").is_some(),
                "{code} must not delete the credential"
            );
        }
    }

    #[test]
    fn malformed_stored_credential_is_deleted_without_reaching_provider() {
        let (service, store) = service([]);
        store
            .replace(&SecretBlob::new(b"not-json".to_vec()).expect("secret blob"))
            .expect("seed malformed credential");

        assert_eq!(service.recover(), Ok(RecoveryState::SignedOut));
        assert!(store.read().expect("read").is_none());
    }

    #[test]
    fn logout_always_deletes_local_secret_when_upstream_is_unavailable() {
        let store = Arc::new(MemoryCredentialStore::default());
        store
            .replace(&SecretBlob::new(b"local-secret".to_vec()).expect("secret"))
            .expect("seed");
        let provider = Arc::new(FakeProvider {
            replies: Mutex::new(VecDeque::from([Err(ProviderError::Unavailable)])),
            requests: AtomicU64::new(0),
        });
        let service = AuthService::new(provider, store.clone());

        assert_eq!(
            service.logout(),
            Ok(LogoutResult {
                upstream_revoked: false
            })
        );
        assert!(store.read().expect("read").is_none());
    }

    #[test]
    fn extra_fields_in_secret_bearing_reply_are_rejected_without_persisting() {
        let reply = success(json!({
            "sessionId": "session-1",
            "state": "authenticated",
            "credential": credential(),
            "account": {"musicId": "123456", "loginMethod": "qq"},
            "unexpected": "SENTINEL_EXTRA"
        }));
        let (service, store) = service([reply]);

        assert_eq!(
            service.poll_qr("session-1"),
            Err(AuthError::InvalidResponse)
        );
        assert!(store.read().expect("read").is_none());
    }

    #[test]
    fn recovering_port_retries_one_read_after_authentication_recovery() {
        let store = Arc::new(MemoryCredentialStore::default());
        seed_credential(store.as_ref());
        let coordinator = Arc::new(AuthRecoveryCoordinator::new(store));
        let mut startup = recovery_port([
            Ok(success(json!({"status": "restored"}))),
            Ok(success(json!({"status": "authenticated"}))),
        ]);
        coordinator
            .recover(12, &mut startup)
            .expect("startup state");
        let raw = Arc::new(FakeProvider::new([
            ProviderReply::Failure {
                code: "authentication_required".to_owned(),
                retryable: true,
            },
            success(json!({"status": "restored"})),
            success(json!({"status": "authenticated"})),
            success(json!({"songs": []})),
        ]));
        let wrapped = RecoveringProviderPort::new(raw.clone(), coordinator);

        assert!(matches!(
            wrapped.request(ProviderRequest::read_only("search.songs", Map::new())),
            Ok(ProviderReply::Success { .. })
        ));
        assert_eq!(raw.requests.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn recovering_port_never_replays_a_write() {
        let store = Arc::new(MemoryCredentialStore::default());
        seed_credential(store.as_ref());
        let coordinator = Arc::new(AuthRecoveryCoordinator::new(store));
        let raw = Arc::new(FakeProvider::new([ProviderReply::Failure {
            code: "authentication_required".to_owned(),
            retryable: true,
        }]));
        let wrapped = RecoveringProviderPort::new(raw.clone(), coordinator);

        assert!(matches!(
            wrapped.request(ProviderRequest::write("playlist.add", Map::new())),
            Ok(ProviderReply::Failure { .. })
        ));
        assert_eq!(raw.requests.load(Ordering::SeqCst), 1);
    }

    struct ConcurrentProvider {
        initial: Barrier,
        initial_requests: AtomicU64,
        recovery_requests: AtomicU64,
    }

    impl ProviderRequestPort for ConcurrentProvider {
        fn request(&self, request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            let text = format!("{request:?}");
            if text.contains("search.songs") {
                if self.initial_requests.fetch_add(1, Ordering::SeqCst) < 2 {
                    self.initial.wait();
                    return Ok(ProviderReply::Failure {
                        code: "authentication_required".to_owned(),
                        retryable: true,
                    });
                }
                return Ok(success(json!({"songs": []})));
            }
            let sequence = self.recovery_requests.fetch_add(1, Ordering::SeqCst);
            Ok(if sequence == 0 {
                success(json!({"status": "restored"}))
            } else {
                success(json!({"status": "authenticated"}))
            })
        }
    }

    #[test]
    fn concurrent_authentication_failures_share_one_recovery_flight() {
        let store = Arc::new(MemoryCredentialStore::default());
        seed_credential(store.as_ref());
        let coordinator = Arc::new(AuthRecoveryCoordinator::new(store));
        let mut startup = recovery_port([
            Ok(success(json!({"status": "restored"}))),
            Ok(success(json!({"status": "authenticated"}))),
        ]);
        coordinator
            .recover(14, &mut startup)
            .expect("startup state");
        let raw = Arc::new(ConcurrentProvider {
            initial: Barrier::new(2),
            initial_requests: AtomicU64::new(0),
            recovery_requests: AtomicU64::new(0),
        });
        let wrapped = Arc::new(RecoveringProviderPort::new(raw.clone(), coordinator));

        let workers = (0..2)
            .map(|_| {
                let wrapped = wrapped.clone();
                thread::spawn(move || {
                    wrapped.request(ProviderRequest::read_only("search.songs", Map::new()))
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            let _ = worker.join().expect("worker");
        }
        assert_eq!(raw.recovery_requests.load(Ordering::SeqCst), 2);
    }
}
