export const APP_SNAPSHOT_COMMAND = "app_snapshot" as const;
export const APP_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface AppSnapshot {
  readonly schemaVersion: typeof APP_SNAPSHOT_SCHEMA_VERSION;
  readonly appVersion: string;
  readonly target: TargetSnapshot;
  readonly provider: ProviderSnapshot;
  readonly player: PlayerSnapshot;
  readonly extensions: ExtensionCapabilities;
}

export interface TargetSnapshot {
  readonly os: "windows";
  readonly architecture: "x86_64";
}

export type ProviderSnapshot =
  | { readonly protocolVersion: 1; readonly state: "notStarted" | "starting" | "failed" }
  | {
      readonly protocolVersion: 1;
      readonly state: "ready";
      readonly providerVersion: string;
      readonly capabilities: ProviderCapabilitySummary;
    };

export interface ProviderCapabilitySummary {
  readonly implementedMethods: readonly string[];
  readonly authMethods: readonly string[];
  readonly searchTypes: readonly string[];
  readonly playlistWrites: readonly string[];
}

export interface PlayerSnapshot {
  readonly state: "idle" | "loading" | "playing" | "paused" | "ended" | "failed";
  readonly generation: number;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly volume: number;
  readonly muted: boolean;
  readonly currentTrack: TrackSummary | null;
  readonly failure: PlayerFailure | null;
}

export interface PlayerFailure {
  readonly code: "network" | "decoding" | "unsupported" | "authentication" | "unavailable";
  readonly recoverable: boolean;
  readonly generation: number;
}

export interface TrackSummary {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly source?: "qq-mv";
}

export interface ExtensionCapabilities {
  readonly playlistRename: boolean;
  readonly playlistDescriptionEdit: boolean;
}
