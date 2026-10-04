mod bundle;
mod protocol;
mod supervisor;

pub use bundle::{ProviderBundleError, VerifiedProviderBundle};
pub use protocol::{
    EventFrame, FailureFrame, ProtocolError, ProviderFrame, RequestFrame, SuccessFrame,
    WarningFrame, MAX_JSON_DEPTH, MAX_LINE_BYTES,
};
pub use supervisor::{
    HandshakeInfo, ProviderError, ProviderEvent, ProviderLaunch, ProviderRecoveryHook,
    ProviderRecoveryPort, ProviderReply, ProviderRequest, ProviderSupervisor, RequestSemantics,
    SupervisorConfig,
};

use serde::Serialize;

pub const PROVIDER_PROTOCOL_VERSION: u16 = 1;

/// Non-secret provider lifecycle information safe to expose to the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    protocol_version: u16,
    state: ProviderState,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<ProviderCapabilitySummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProviderState {
    NotStarted,
    Starting,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCapabilitySummary {
    implemented_methods: Vec<String>,
    auth_methods: Vec<String>,
    search_types: Vec<String>,
    playlist_writes: Vec<String>,
}

impl ProviderSnapshot {
    pub fn not_started() -> Self {
        Self {
            protocol_version: PROVIDER_PROTOCOL_VERSION,
            state: ProviderState::NotStarted,
            provider_version: None,
            capabilities: None,
        }
    }

    fn starting() -> Self {
        Self {
            protocol_version: PROVIDER_PROTOCOL_VERSION,
            state: ProviderState::Starting,
            provider_version: None,
            capabilities: None,
        }
    }

    fn ready(handshake: &HandshakeInfo) -> Self {
        Self {
            protocol_version: PROVIDER_PROTOCOL_VERSION,
            state: ProviderState::Ready,
            provider_version: Some(handshake.provider_version.clone()),
            capabilities: Some(ProviderCapabilitySummary {
                implemented_methods: handshake.implemented_methods.clone(),
                auth_methods: handshake.capabilities.auth_methods.clone(),
                search_types: handshake.capabilities.search_types.clone(),
                playlist_writes: handshake.capabilities.playlist_writes.clone(),
            }),
        }
    }

    pub(crate) fn failed() -> Self {
        Self {
            protocol_version: PROVIDER_PROTOCOL_VERSION,
            state: ProviderState::Failed,
            provider_version: None,
            capabilities: None,
        }
    }
}

/// Secret-bearing provider responses must be normalized before crossing this boundary.
pub trait ProviderPort: Send + Sync {
    fn snapshot(&self) -> ProviderSnapshot;
}

/// Request boundary shared by secret-normalizing Rust controllers.
pub trait ProviderRequestPort: Send + Sync {
    fn request(&self, request: ProviderRequest) -> Result<ProviderReply, ProviderError>;
}

impl ProviderRequestPort for ProviderSupervisor {
    fn request(&self, request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
        self.request(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_snapshot_does_not_claim_a_handshake() {
        let value = serde_json::to_value(ProviderSnapshot::not_started())
            .expect("provider snapshot must serialize");

        assert_eq!(value["protocolVersion"], PROVIDER_PROTOCOL_VERSION);
        assert_eq!(value["state"], "notStarted");
        assert!(value.get("capabilities").is_none());
        assert!(value.get("providerVersion").is_none());
    }
}
