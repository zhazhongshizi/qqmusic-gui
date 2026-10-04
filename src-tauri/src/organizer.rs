use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    catalog::CatalogSong,
    library::{LibraryError, LibraryPort, PlaylistSnapshot},
    persistence::{
        OrganizerItemPhase, OrganizerOperation, OrganizerPlanBinding, OrganizerPlanItem,
        OrganizerPlanState, OrganizerPlanSummary, PersistenceError, PersistenceService,
    },
};

const PLAN_TTL_MS: u64 = 15 * 60 * 1_000;
const MAX_PLAN_ITEMS: usize = 10_000;
const WRITE_BATCH_SIZE: usize = 100;
const MAX_PREVIEW_ITEMS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganizerError {
    InvalidRequest,
    AuthenticationRequired,
    PlaylistUnavailable,
    PlanUnavailable,
    PlanExpired,
    PlanAccountChanged,
    PlanDrifted,
    WriteRejected,
    OutcomeUnknown,
    PersistenceUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OrganizerOperationWire {
    Copy,
    Move,
    Remove,
    Deduplicate,
}

impl From<OrganizerOperationWire> for OrganizerOperation {
    fn from(value: OrganizerOperationWire) -> Self {
        match value {
            OrganizerOperationWire::Copy => Self::Copy,
            OrganizerOperationWire::Move => Self::Move,
            OrganizerOperationWire::Remove => Self::Remove,
            OrganizerOperationWire::Deduplicate => Self::Deduplicate,
        }
    }
}

impl From<OrganizerOperation> for OrganizerOperationWire {
    fn from(value: OrganizerOperation) -> Self {
        match value {
            OrganizerOperation::Copy => Self::Copy,
            OrganizerOperation::Move => Self::Move,
            OrganizerOperation::Remove => Self::Remove,
            OrganizerOperation::Deduplicate => Self::Deduplicate,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OrganizerSelection {
    All,
    Duplicates,
    Intersection,
    Difference,
    Selected,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaylistPlanRef {
    pub id: String,
    pub editable_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrganizerFilter {
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub availability: Option<String>,
    #[serde(default)]
    pub minimum_quality: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrganizerPreviewRequest {
    pub operation: OrganizerOperationWire,
    pub source: PlaylistPlanRef,
    #[serde(default)]
    pub target: Option<PlaylistPlanRef>,
    pub selection: OrganizerSelection,
    #[serde(default)]
    pub selected_song_ids: Vec<String>,
    #[serde(default)]
    pub filter: Option<OrganizerFilter>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerPreviewItem {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerPreview {
    pub plan_id: String,
    pub operation: OrganizerOperationWire,
    pub source_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_title: Option<String>,
    pub item_count: usize,
    pub preview_truncated: bool,
    pub expires_at_unix_ms: u64,
    pub items: Vec<OrganizerPreviewItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerExecution {
    pub plan_id: String,
    pub state: String,
    pub item_count: u32,
    pub completed_count: u32,
    pub failed_count: u32,
    pub pending_verification_count: u32,
}

pub struct OrganizerService {
    library: Arc<dyn LibraryPort>,
    persistence: Arc<PersistenceService>,
}

impl OrganizerService {
    pub fn new(library: Arc<dyn LibraryPort>, persistence: Arc<PersistenceService>) -> Self {
        Self {
            library,
            persistence,
        }
    }

    pub fn preview(
        &self,
        account_id: &str,
        request: OrganizerPreviewRequest,
    ) -> Result<OrganizerPreview, OrganizerError> {
        validate_account_id(account_id)?;
        validate_plan_ref(&request.source)?;
        validate_filter(request.filter.as_ref())?;
        let needs_target = matches!(
            request.operation,
            OrganizerOperationWire::Copy | OrganizerOperationWire::Move
        ) || matches!(
            request.selection,
            OrganizerSelection::Intersection | OrganizerSelection::Difference
        );
        if needs_target && request.target.is_none()
            || request.target.is_some() && request.target.as_ref() == Some(&request.source)
        {
            return Err(OrganizerError::InvalidRequest);
        }
        if let Some(target) = &request.target {
            validate_plan_ref(target)?;
        }
        validate_selected_ids(&request.selected_song_ids, request.selection)?;

        let source = self
            .library
            .playlist_snapshot(&request.source.id)
            .map_err(map_library_read_error)?;
        let target = request
            .target
            .as_ref()
            .map(|target| self.library.playlist_snapshot(&target.id))
            .transpose()
            .map_err(map_library_read_error)?;
        let mut selected = select_tracks(
            &source.songs,
            target.as_ref().map(|value| value.songs.as_slice()),
            request.selection,
            &request.selected_song_ids,
        );
        if let Some(filter) = &request.filter {
            selected.retain(|song| matches_filter(song, filter));
        }
        if request.operation == OrganizerOperationWire::Deduplicate
            && request.selection != OrganizerSelection::Duplicates
        {
            return Err(OrganizerError::InvalidRequest);
        }
        if selected.is_empty() || selected.len() > MAX_PLAN_ITEMS {
            return Err(OrganizerError::InvalidRequest);
        }

        let now = now_unix_ms()?;
        let expires_at = now.saturating_add(PLAN_TTL_MS);
        let plan_id = format!("plan-{}", Uuid::new_v4().simple());
        let summary = OrganizerPlanSummary {
            plan_id: plan_id.clone(),
            operation: request.operation.into(),
            source_playlist_id: request.source.id.clone(),
            target_playlist_id: request.target.as_ref().map(|target| target.id.clone()),
            item_count: selected.len() as u32,
            completed_count: 0,
            failed_count: 0,
            expires_at_unix_ms: expires_at,
            state: OrganizerPlanState::Preview,
        };
        let binding = OrganizerPlanBinding {
            account_id: account_id.to_owned(),
            source_editable_id: request.source.editable_id,
            target_editable_id: request.target.map(|target| target.editable_id),
            source_snapshot_hash: snapshot_hash(&source),
            target_snapshot_hash: target.as_ref().map(snapshot_hash),
            created_at_unix_ms: now,
        };
        let persisted_items = selected
            .iter()
            .map(|song| OrganizerPlanItem {
                track_id: song.id.clone(),
                title: song.title.clone(),
                artist: song.artist.clone(),
                phase: OrganizerItemPhase::Pending,
            })
            .collect::<Vec<_>>();
        self.persistence
            .save_organizer_plan(&summary)
            .and_then(|_| {
                self.persistence
                    .save_organizer_plan_payload(&plan_id, &binding, &persisted_items)
            })
            .map_err(map_persistence_error)?;

        Ok(OrganizerPreview {
            plan_id,
            operation: request.operation,
            source_title: source.summary.title,
            target_title: target.map(|value| value.summary.title),
            item_count: selected.len(),
            preview_truncated: selected.len() > MAX_PREVIEW_ITEMS,
            expires_at_unix_ms: expires_at,
            items: selected
                .drain(..selected.len().min(MAX_PREVIEW_ITEMS))
                .map(|song| OrganizerPreviewItem {
                    id: song.id,
                    title: song.title,
                    artist: song.artist,
                    album: song.album,
                })
                .collect(),
        })
    }

    pub fn execute(
        &self,
        account_id: &str,
        plan_id: &str,
        confirm: bool,
    ) -> Result<OrganizerExecution, OrganizerError> {
        validate_account_id(account_id)?;
        if !confirm || !valid_stable_id(plan_id) {
            return Err(OrganizerError::InvalidRequest);
        }
        let mut plan = self
            .persistence
            .load_organizer_plan(plan_id)
            .map_err(map_persistence_error)?
            .ok_or(OrganizerError::PlanUnavailable)?;
        if plan.binding.account_id != account_id {
            return Err(OrganizerError::PlanAccountChanged);
        }
        if now_unix_ms()? >= plan.summary.expires_at_unix_ms {
            plan.summary.state = OrganizerPlanState::Expired;
            self.persistence
                .save_organizer_plan(&plan.summary)
                .map_err(map_persistence_error)?;
            return Err(OrganizerError::PlanExpired);
        }
        if plan.summary.state == OrganizerPlanState::Preview {
            self.verify_original_snapshots(&plan)?;
            plan.summary.state = OrganizerPlanState::Running;
            self.persistence
                .save_organizer_plan(&plan.summary)
                .map_err(map_persistence_error)?;
        }
        self.reconcile_pending_verification(&mut plan)?;

        match plan.summary.operation {
            OrganizerOperation::Copy | OrganizerOperation::Move => {
                self.execute_copy_or_move(&mut plan)?;
            }
            OrganizerOperation::Remove => self.execute_remove(&mut plan)?,
            OrganizerOperation::Deduplicate => self.execute_deduplicate(&mut plan)?,
        }
        self.finish_summary(&mut plan)?;
        Ok(execution_from(&plan))
    }

    fn reconcile_pending_verification(
        &self,
        plan: &mut crate::persistence::PersistedOrganizerPlan,
    ) -> Result<(), OrganizerError> {
        let positions = pending_positions(plan, OrganizerItemPhase::PendingVerification);
        if positions.is_empty() {
            return Ok(());
        }
        let source = self
            .library
            .playlist_snapshot(&plan.summary.source_playlist_id)
            .map_err(map_library_read_error)?;
        let source_counts = track_counts(&source.songs);
        let target_counts = plan
            .summary
            .target_playlist_id
            .as_ref()
            .map(|target_id| self.library.playlist_snapshot(target_id))
            .transpose()
            .map_err(map_library_read_error)?
            .map(|target| track_counts(&target.songs));
        let plan_id = plan.summary.plan_id.clone();
        for position in positions {
            let id = plan.items[position].track_id.as_str();
            let phase = match plan.summary.operation {
                OrganizerOperation::Copy => {
                    if target_counts
                        .as_ref()
                        .and_then(|counts| counts.get(id))
                        .copied()
                        .unwrap_or(0)
                        > 0
                    {
                        OrganizerItemPhase::Complete
                    } else {
                        OrganizerItemPhase::Pending
                    }
                }
                OrganizerOperation::Move => {
                    let in_target = target_counts
                        .as_ref()
                        .and_then(|counts| counts.get(id))
                        .copied()
                        .unwrap_or(0)
                        > 0;
                    let in_source = source_counts.get(id).copied().unwrap_or(0) > 0;
                    if in_target && !in_source {
                        OrganizerItemPhase::Complete
                    } else if in_target {
                        OrganizerItemPhase::TargetVerified
                    } else {
                        OrganizerItemPhase::Pending
                    }
                }
                OrganizerOperation::Remove => {
                    if source_counts.get(id).copied().unwrap_or(0) == 0 {
                        OrganizerItemPhase::Complete
                    } else {
                        OrganizerItemPhase::Pending
                    }
                }
                OrganizerOperation::Deduplicate => {
                    if source_counts.get(id).copied().unwrap_or(0) == 1 {
                        OrganizerItemPhase::Complete
                    } else {
                        OrganizerItemPhase::Pending
                    }
                }
            };
            set_phase(
                &self.persistence,
                &plan_id,
                position,
                &mut plan.items[position],
                phase,
            )?;
        }
        Ok(())
    }

    fn verify_original_snapshots(
        &self,
        plan: &crate::persistence::PersistedOrganizerPlan,
    ) -> Result<(), OrganizerError> {
        let source = self
            .library
            .playlist_snapshot(&plan.summary.source_playlist_id)
            .map_err(map_library_read_error)?;
        if snapshot_hash(&source) != plan.binding.source_snapshot_hash {
            return Err(OrganizerError::PlanDrifted);
        }
        if let Some(target_id) = &plan.summary.target_playlist_id {
            let target = self
                .library
                .playlist_snapshot(target_id)
                .map_err(map_library_read_error)?;
            if Some(snapshot_hash(&target)) != plan.binding.target_snapshot_hash {
                return Err(OrganizerError::PlanDrifted);
            }
        }
        Ok(())
    }

    fn execute_copy_or_move(
        &self,
        plan: &mut crate::persistence::PersistedOrganizerPlan,
    ) -> Result<(), OrganizerError> {
        let target_id = plan
            .summary
            .target_playlist_id
            .as_ref()
            .ok_or(OrganizerError::PlanUnavailable)?
            .clone();
        let target_editable = plan
            .binding
            .target_editable_id
            .as_ref()
            .ok_or(OrganizerError::PlanUnavailable)?
            .clone();
        let current_plan_id = plan.summary.plan_id.clone();
        let target_before = self
            .library
            .playlist_snapshot(&target_id)
            .map_err(map_library_read_error)?;
        let target_ids = target_before
            .songs
            .iter()
            .map(|song| song.id.as_str())
            .collect::<HashSet<_>>();
        for (position, item) in plan.items.iter_mut().enumerate() {
            if item.phase == OrganizerItemPhase::Pending
                && target_ids.contains(item.track_id.as_str())
            {
                set_phase(
                    &self.persistence,
                    &current_plan_id,
                    position,
                    item,
                    OrganizerItemPhase::TargetVerified,
                )?;
            }
        }
        let pending = pending_positions(plan, OrganizerItemPhase::Pending);
        for batch in pending.chunks(WRITE_BATCH_SIZE) {
            let ids = batch
                .iter()
                .map(|position| plan.items[*position].track_id.clone())
                .collect::<Vec<_>>();
            let outcome_unknown = match self.library.add_songs(&target_editable, &ids) {
                Ok(_) => false,
                Err(LibraryError::OutcomeUnknown) => true,
                Err(error) => {
                    mark_batch(&self.persistence, plan, batch, OrganizerItemPhase::Failed)?;
                    if matches!(error, LibraryError::AuthenticationRequired) {
                        return Err(OrganizerError::AuthenticationRequired);
                    }
                    continue;
                }
            };
            let target_after = self
                .library
                .playlist_snapshot(&target_id)
                .map_err(map_library_read_error)?;
            let present = target_after
                .songs
                .iter()
                .map(|song| song.id.as_str())
                .collect::<HashSet<_>>();
            for position in batch {
                let phase = if present.contains(plan.items[*position].track_id.as_str()) {
                    OrganizerItemPhase::TargetVerified
                } else if outcome_unknown {
                    OrganizerItemPhase::PendingVerification
                } else {
                    OrganizerItemPhase::Failed
                };
                let plan_id = plan.summary.plan_id.clone();
                set_phase(
                    &self.persistence,
                    &plan_id,
                    *position,
                    &mut plan.items[*position],
                    phase,
                )?;
            }
        }
        if plan.summary.operation == OrganizerOperation::Copy {
            let verified = pending_positions(plan, OrganizerItemPhase::TargetVerified);
            mark_batch(
                &self.persistence,
                plan,
                &verified,
                OrganizerItemPhase::Complete,
            )?;
            return Ok(());
        }

        let verified = pending_positions(plan, OrganizerItemPhase::TargetVerified);
        for batch in verified.chunks(WRITE_BATCH_SIZE) {
            let ids = batch
                .iter()
                .map(|position| plan.items[*position].track_id.clone())
                .collect::<Vec<_>>();
            let outcome_unknown = match self
                .library
                .remove_songs(&plan.binding.source_editable_id, &ids)
            {
                Ok(_) => false,
                Err(LibraryError::OutcomeUnknown) => true,
                Err(_) => {
                    mark_batch(&self.persistence, plan, batch, OrganizerItemPhase::Failed)?;
                    continue;
                }
            };
            let source_after = self
                .library
                .playlist_snapshot(&plan.summary.source_playlist_id)
                .map_err(map_library_read_error)?;
            let remaining = source_after
                .songs
                .iter()
                .map(|song| song.id.as_str())
                .collect::<HashSet<_>>();
            for position in batch {
                let phase = if !remaining.contains(plan.items[*position].track_id.as_str()) {
                    OrganizerItemPhase::Complete
                } else if outcome_unknown {
                    OrganizerItemPhase::PendingVerification
                } else {
                    OrganizerItemPhase::Failed
                };
                let plan_id = plan.summary.plan_id.clone();
                set_phase(
                    &self.persistence,
                    &plan_id,
                    *position,
                    &mut plan.items[*position],
                    phase,
                )?;
            }
        }
        Ok(())
    }

    fn execute_remove(
        &self,
        plan: &mut crate::persistence::PersistedOrganizerPlan,
    ) -> Result<(), OrganizerError> {
        let pending = pending_positions(plan, OrganizerItemPhase::Pending);
        for batch in pending.chunks(WRITE_BATCH_SIZE) {
            let ids = batch
                .iter()
                .map(|position| plan.items[*position].track_id.clone())
                .collect::<Vec<_>>();
            let unknown = match self
                .library
                .remove_songs(&plan.binding.source_editable_id, &ids)
            {
                Ok(_) => false,
                Err(LibraryError::OutcomeUnknown) => true,
                Err(_) => {
                    mark_batch(&self.persistence, plan, batch, OrganizerItemPhase::Failed)?;
                    continue;
                }
            };
            let source = self
                .library
                .playlist_snapshot(&plan.summary.source_playlist_id)
                .map_err(map_library_read_error)?;
            let remaining = source
                .songs
                .iter()
                .map(|song| song.id.as_str())
                .collect::<HashSet<_>>();
            for position in batch {
                let phase = if !remaining.contains(plan.items[*position].track_id.as_str()) {
                    OrganizerItemPhase::Complete
                } else if unknown {
                    OrganizerItemPhase::PendingVerification
                } else {
                    OrganizerItemPhase::Failed
                };
                let plan_id = plan.summary.plan_id.clone();
                set_phase(
                    &self.persistence,
                    &plan_id,
                    *position,
                    &mut plan.items[*position],
                    phase,
                )?;
            }
        }
        Ok(())
    }

    fn execute_deduplicate(
        &self,
        plan: &mut crate::persistence::PersistedOrganizerPlan,
    ) -> Result<(), OrganizerError> {
        let pending = pending_positions(plan, OrganizerItemPhase::Pending);
        for position in pending {
            let id = plan.items[position].track_id.clone();
            let before = self
                .library
                .playlist_snapshot(&plan.summary.source_playlist_id)
                .map_err(map_library_read_error)?;
            let count = before.songs.iter().filter(|song| song.id == id).count();
            if count == 1 {
                let plan_id = plan.summary.plan_id.clone();
                set_phase(
                    &self.persistence,
                    &plan_id,
                    position,
                    &mut plan.items[position],
                    OrganizerItemPhase::Complete,
                )?;
                continue;
            }
            if count < 2 {
                let plan_id = plan.summary.plan_id.clone();
                set_phase(
                    &self.persistence,
                    &plan_id,
                    position,
                    &mut plan.items[position],
                    OrganizerItemPhase::Failed,
                )?;
                continue;
            }
            let _ = self
                .library
                .remove_songs(&plan.binding.source_editable_id, std::slice::from_ref(&id));
            let removed = self
                .library
                .playlist_snapshot(&plan.summary.source_playlist_id)
                .map_err(map_library_read_error)?;
            if removed.songs.iter().any(|song| song.id == id) {
                let plan_id = plan.summary.plan_id.clone();
                set_phase(
                    &self.persistence,
                    &plan_id,
                    position,
                    &mut plan.items[position],
                    OrganizerItemPhase::PendingVerification,
                )?;
                continue;
            }
            let _ = self
                .library
                .add_songs(&plan.binding.source_editable_id, std::slice::from_ref(&id));
            let restored = self
                .library
                .playlist_snapshot(&plan.summary.source_playlist_id)
                .map_err(map_library_read_error)?;
            let final_count = restored.songs.iter().filter(|song| song.id == id).count();
            let phase = if final_count == 1 {
                OrganizerItemPhase::Complete
            } else {
                OrganizerItemPhase::PendingVerification
            };
            let plan_id = plan.summary.plan_id.clone();
            set_phase(
                &self.persistence,
                &plan_id,
                position,
                &mut plan.items[position],
                phase,
            )?;
        }
        Ok(())
    }

    fn finish_summary(
        &self,
        plan: &mut crate::persistence::PersistedOrganizerPlan,
    ) -> Result<(), OrganizerError> {
        plan.summary.completed_count = plan
            .items
            .iter()
            .filter(|item| item.phase == OrganizerItemPhase::Complete)
            .count() as u32;
        plan.summary.failed_count = plan
            .items
            .iter()
            .filter(|item| item.phase == OrganizerItemPhase::Failed)
            .count() as u32;
        plan.summary.state = if plan.summary.completed_count == plan.summary.item_count {
            OrganizerPlanState::Complete
        } else {
            OrganizerPlanState::Partial
        };
        self.persistence
            .save_organizer_plan(&plan.summary)
            .map_err(map_persistence_error)
    }
}

fn select_tracks(
    source: &[CatalogSong],
    target: Option<&[CatalogSong]>,
    selection: OrganizerSelection,
    selected_ids: &[String],
) -> Vec<CatalogSong> {
    let target_ids = target
        .unwrap_or_default()
        .iter()
        .map(|song| song.id.as_str())
        .collect::<HashSet<_>>();
    let selected = selected_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let counts = source.iter().fold(HashMap::new(), |mut counts, song| {
        *counts.entry(song.id.as_str()).or_insert(0usize) += 1;
        counts
    });
    let mut emitted = HashSet::new();
    source
        .iter()
        .filter(|song| match selection {
            OrganizerSelection::All => true,
            OrganizerSelection::Duplicates => {
                counts.get(song.id.as_str()).copied().unwrap_or(0) > 1
            }
            OrganizerSelection::Intersection => target_ids.contains(song.id.as_str()),
            OrganizerSelection::Difference => !target_ids.contains(song.id.as_str()),
            OrganizerSelection::Selected => selected.contains(song.id.as_str()),
        })
        .filter(|song| {
            selection != OrganizerSelection::Duplicates || emitted.insert(song.id.clone())
        })
        .cloned()
        .collect()
}

fn track_counts(songs: &[CatalogSong]) -> HashMap<String, usize> {
    songs.iter().fold(HashMap::new(), |mut counts, song| {
        *counts.entry(song.id.clone()).or_insert(0) += 1;
        counts
    })
}

fn matches_filter(song: &CatalogSong, filter: &OrganizerFilter) -> bool {
    filter
        .artist
        .as_ref()
        .is_none_or(|artist| song.artist == *artist)
        && filter
            .album
            .as_ref()
            .is_none_or(|album| song.album == *album)
        && filter
            .availability
            .as_ref()
            .is_none_or(|availability| song.availability.status == *availability)
        && filter.minimum_quality.as_ref().is_none_or(|quality| {
            song.quality_candidates
                .iter()
                .any(|candidate| candidate.quality == *quality && candidate.available)
        })
}

fn snapshot_hash(snapshot: &PlaylistSnapshot) -> String {
    let mut digest = Sha256::new();
    digest.update(snapshot.summary.id.as_bytes());
    digest.update([0]);
    for song in &snapshot.songs {
        digest.update(song.id.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

fn validate_plan_ref(value: &PlaylistPlanRef) -> Result<(), OrganizerError> {
    if !valid_numeric_id(&value.id) || !valid_numeric_id(&value.editable_id) {
        Err(OrganizerError::InvalidRequest)
    } else {
        Ok(())
    }
}

fn validate_account_id(value: &str) -> Result<(), OrganizerError> {
    if !valid_numeric_id(value) {
        Err(OrganizerError::AuthenticationRequired)
    } else {
        Ok(())
    }
}

fn valid_numeric_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_stable_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_selected_ids(
    values: &[String],
    selection: OrganizerSelection,
) -> Result<(), OrganizerError> {
    if selection == OrganizerSelection::Selected && values.is_empty()
        || selection != OrganizerSelection::Selected && !values.is_empty()
        || values.len() > MAX_PLAN_ITEMS
        || values.iter().any(|value| !valid_stable_id(value))
    {
        Err(OrganizerError::InvalidRequest)
    } else {
        Ok(())
    }
}

fn validate_filter(value: Option<&OrganizerFilter>) -> Result<(), OrganizerError> {
    let Some(value) = value else {
        return Ok(());
    };
    let valid_text = |value: &str| {
        !value.is_empty() && value.len() <= 512 && !value.contains(['\r', '\n', '\0'])
    };
    if value
        .artist
        .as_deref()
        .is_some_and(|value| !valid_text(value))
        || value
            .album
            .as_deref()
            .is_some_and(|value| !valid_text(value))
        || value
            .availability
            .as_deref()
            .is_some_and(|value| !matches!(value, "unknown" | "unavailable"))
        || value
            .minimum_quality
            .as_deref()
            .is_some_and(|value| !matches!(value, "flac" | "320k" | "128k"))
    {
        Err(OrganizerError::InvalidRequest)
    } else {
        Ok(())
    }
}

fn pending_positions(
    plan: &crate::persistence::PersistedOrganizerPlan,
    phase: OrganizerItemPhase,
) -> Vec<usize> {
    plan.items
        .iter()
        .enumerate()
        .filter_map(|(position, item)| (item.phase == phase).then_some(position))
        .collect()
}

fn set_phase(
    persistence: &PersistenceService,
    plan_id: &str,
    position: usize,
    item: &mut OrganizerPlanItem,
    phase: OrganizerItemPhase,
) -> Result<(), OrganizerError> {
    persistence
        .update_organizer_item_phase(plan_id, position, phase)
        .map_err(map_persistence_error)?;
    item.phase = phase;
    Ok(())
}

fn mark_batch(
    persistence: &PersistenceService,
    plan: &mut crate::persistence::PersistedOrganizerPlan,
    positions: &[usize],
    phase: OrganizerItemPhase,
) -> Result<(), OrganizerError> {
    let plan_id = plan.summary.plan_id.clone();
    for position in positions {
        set_phase(
            persistence,
            &plan_id,
            *position,
            &mut plan.items[*position],
            phase,
        )?;
    }
    Ok(())
}

fn execution_from(plan: &crate::persistence::PersistedOrganizerPlan) -> OrganizerExecution {
    OrganizerExecution {
        plan_id: plan.summary.plan_id.clone(),
        state: match plan.summary.state {
            OrganizerPlanState::Preview => "preview",
            OrganizerPlanState::Running => "running",
            OrganizerPlanState::Partial => "partial",
            OrganizerPlanState::Complete => "complete",
            OrganizerPlanState::Expired => "expired",
        }
        .to_owned(),
        item_count: plan.summary.item_count,
        completed_count: plan.summary.completed_count,
        failed_count: plan.summary.failed_count,
        pending_verification_count: plan
            .items
            .iter()
            .filter(|item| item.phase == OrganizerItemPhase::PendingVerification)
            .count() as u32,
    }
}

fn now_unix_ms() -> Result<u64, OrganizerError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| OrganizerError::PersistenceUnavailable)
}

fn map_library_read_error(error: LibraryError) -> OrganizerError {
    match error {
        LibraryError::AuthenticationRequired => OrganizerError::AuthenticationRequired,
        _ => OrganizerError::PlaylistUnavailable,
    }
}

fn map_persistence_error(_error: PersistenceError) -> OrganizerError {
    OrganizerError::PersistenceUnavailable
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, sync::Mutex};

    use crate::{
        catalog::{CatalogArtistRef, CatalogAvailability, CatalogQualityCandidate},
        library::{PlaylistSummary, WriteReceipt},
    };

    use super::*;

    struct TestDatabase {
        root: PathBuf,
        path: PathBuf,
    }

    impl TestDatabase {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("qmg-organizer-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).expect("temp root");
            Self {
                path: root.join("state.sqlite3"),
                root,
            }
        }
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct FakeLibrary {
        snapshots: Mutex<HashMap<String, PlaylistSnapshot>>,
        writes: Mutex<Vec<String>>,
        unknown_add: bool,
    }

    impl FakeLibrary {
        fn new(source: Vec<CatalogSong>, target: Vec<CatalogSong>) -> Arc<Self> {
            Arc::new(Self {
                snapshots: Mutex::new(HashMap::from([
                    ("991".to_owned(), snapshot("991", "源歌单", source)),
                    ("992".to_owned(), snapshot("992", "目标歌单", target)),
                ])),
                writes: Mutex::new(Vec::new()),
                unknown_add: false,
            })
        }
    }

    impl LibraryPort for FakeLibrary {
        fn playlist_snapshot(&self, playlist_id: &str) -> Result<PlaylistSnapshot, LibraryError> {
            self.snapshots
                .lock()
                .expect("snapshots")
                .get(playlist_id)
                .cloned()
                .ok_or(LibraryError::Unavailable)
        }

        fn add_songs(
            &self,
            editable_id: &str,
            song_ids: &[String],
        ) -> Result<WriteReceipt, LibraryError> {
            self.writes
                .lock()
                .expect("writes")
                .push(format!("add:{editable_id}:{}", song_ids.join(",")));
            let source = self.snapshots.lock().expect("snapshots")["991"].clone();
            let mut snapshots = self.snapshots.lock().expect("snapshots");
            let target = snapshots.get_mut("992").expect("target");
            for id in song_ids {
                if !target.songs.iter().any(|song| &song.id == id) {
                    target.songs.push(
                        source
                            .songs
                            .iter()
                            .find(|song| &song.id == id)
                            .expect("song")
                            .clone(),
                    );
                }
            }
            if self.unknown_add {
                Err(LibraryError::OutcomeUnknown)
            } else {
                Ok(receipt(song_ids.len()))
            }
        }

        fn remove_songs(
            &self,
            editable_id: &str,
            song_ids: &[String],
        ) -> Result<WriteReceipt, LibraryError> {
            self.writes
                .lock()
                .expect("writes")
                .push(format!("remove:{editable_id}:{}", song_ids.join(",")));
            let playlist = if editable_id == "88" { "991" } else { "992" };
            self.snapshots
                .lock()
                .expect("snapshots")
                .get_mut(playlist)
                .expect("playlist")
                .songs
                .retain(|song| !song_ids.contains(&song.id));
            Ok(receipt(song_ids.len()))
        }
    }

    fn song(id: &str) -> CatalogSong {
        CatalogSong {
            id: id.to_owned(),
            media_mid: None,
            cover_cache_key: None,
            title: format!("歌曲 {id}"),
            subtitle: String::new(),
            artists: vec![CatalogArtistRef {
                id: "artist-mid-1".to_owned(),
                name: "林间电台".to_owned(),
            }],
            artist: "林间电台".to_owned(),
            album: "温室唱片".to_owned(),
            album_id: None,
            album_publish_date: None,
            duration_ms: 200_000,
            quality_candidates: vec![
                CatalogQualityCandidate {
                    quality: "flac".to_owned(),
                    available: true,
                    requires_subscription: false,
                },
                CatalogQualityCandidate {
                    quality: "320k".to_owned(),
                    available: true,
                    requires_subscription: false,
                },
                CatalogQualityCandidate {
                    quality: "128k".to_owned(),
                    available: true,
                    requires_subscription: false,
                },
            ],
            availability: CatalogAvailability {
                status: "unknown".to_owned(),
                requires_subscription: false,
            },
        }
    }

    fn snapshot(id: &str, title: &str, songs: Vec<CatalogSong>) -> PlaylistSnapshot {
        PlaylistSnapshot {
            summary: PlaylistSummary {
                id: id.to_owned(),
                editable_id: Some(if id == "991" { "88" } else { "89" }.to_owned()),
                title: title.to_owned(),
                description: String::new(),
                song_count: songs.len() as u64,
            },
            songs,
        }
    }

    fn receipt(count: usize) -> WriteReceipt {
        WriteReceipt {
            status: "applied".to_owned(),
            affected_count: Some(count),
            playlist: None,
        }
    }

    fn request(
        operation: OrganizerOperationWire,
        selection: OrganizerSelection,
    ) -> OrganizerPreviewRequest {
        OrganizerPreviewRequest {
            operation,
            source: PlaylistPlanRef {
                id: "991".to_owned(),
                editable_id: "88".to_owned(),
            },
            target: Some(PlaylistPlanRef {
                id: "992".to_owned(),
                editable_id: "89".to_owned(),
            }),
            selection,
            selected_song_ids: Vec::new(),
            filter: None,
        }
    }

    #[test]
    fn preview_is_opaque_account_bound_and_detects_snapshot_drift() {
        let database = TestDatabase::new();
        let persistence = Arc::new(PersistenceService::open(&database.path).expect("db"));
        let library = FakeLibrary::new(vec![song("a"), song("b")], vec![]);
        let service = OrganizerService::new(library.clone(), persistence);
        let preview = service
            .preview(
                "123456",
                request(OrganizerOperationWire::Copy, OrganizerSelection::All),
            )
            .expect("preview");
        assert!(preview.plan_id.starts_with("plan-"));
        assert_eq!(
            service.execute("654321", &preview.plan_id, true),
            Err(OrganizerError::PlanAccountChanged)
        );
        library
            .snapshots
            .lock()
            .expect("snapshots")
            .get_mut("991")
            .expect("source")
            .songs
            .push(song("drift"));
        assert_eq!(
            service.execute("123456", &preview.plan_id, true),
            Err(OrganizerError::PlanDrifted)
        );
        assert!(library.writes.lock().expect("writes").is_empty());
    }

    #[test]
    fn move_adds_and_reads_target_before_source_delete() {
        let database = TestDatabase::new();
        let persistence = Arc::new(PersistenceService::open(&database.path).expect("db"));
        let library = FakeLibrary::new(vec![song("a"), song("b")], vec![]);
        let service = OrganizerService::new(library.clone(), persistence);
        let preview = service
            .preview(
                "123456",
                request(OrganizerOperationWire::Move, OrganizerSelection::All),
            )
            .expect("preview");
        let execution = service
            .execute("123456", &preview.plan_id, true)
            .expect("execute");
        assert_eq!(execution.state, "complete");
        assert_eq!(execution.completed_count, 2);
        assert_eq!(
            *library.writes.lock().expect("writes"),
            vec!["add:89:a,b", "remove:88:a,b"]
        );
    }

    #[test]
    fn copy_unknown_outcome_is_reconciled_without_replay() {
        let database = TestDatabase::new();
        let persistence = Arc::new(PersistenceService::open(&database.path).expect("db"));
        let mut library = FakeLibrary::new(vec![song("a")], vec![]);
        Arc::get_mut(&mut library).expect("unique").unknown_add = true;
        let service = OrganizerService::new(library.clone(), persistence);
        let preview = service
            .preview(
                "123456",
                request(OrganizerOperationWire::Copy, OrganizerSelection::All),
            )
            .expect("preview");
        let execution = service
            .execute("123456", &preview.plan_id, true)
            .expect("execute");
        assert_eq!(execution.state, "complete");
        assert_eq!(*library.writes.lock().expect("writes"), vec!["add:89:a"]);
    }
}
