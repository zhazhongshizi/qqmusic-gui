import type { CatalogSong } from "./catalog";

export type PlaylistKind = "created" | "favorite";

export interface PlaylistSummary {
  readonly id: string;
  readonly editableId?: string;
  readonly title: string;
  readonly description: string;
  readonly songCount: number;
}

export interface PlaylistPage {
  readonly kind: PlaylistKind;
  readonly page: number;
  readonly hasMore: boolean;
  readonly total: number;
  readonly warningCount: number;
  readonly items: readonly PlaylistSummary[];
}

export type OrganizerOperation = "copy" | "move" | "remove" | "deduplicate";
export type OrganizerSelection = "all" | "duplicates" | "intersection" | "difference";

export interface PlaylistPlanRef {
  readonly id: string;
  readonly editableId: string;
}

export interface OrganizerPreviewRequest {
  readonly operation: OrganizerOperation;
  readonly source: PlaylistPlanRef;
  readonly target?: PlaylistPlanRef;
  readonly selection: OrganizerSelection;
  readonly selectedSongIds: readonly string[];
  readonly filter?: {
    readonly artist?: string;
    readonly album?: string;
    readonly availability?: "unknown" | "unavailable";
    readonly minimumQuality?: "flac" | "320k" | "128k";
  };
}

export interface OrganizerPreviewItem extends Pick<CatalogSong, "id" | "title" | "artist" | "album"> {}

export interface OrganizerPreview {
  readonly planId: string;
  readonly operation: OrganizerOperation;
  readonly sourceTitle: string;
  readonly targetTitle?: string;
  readonly itemCount: number;
  readonly previewTruncated: boolean;
  readonly expiresAtUnixMs: number;
  readonly items: readonly OrganizerPreviewItem[];
}

export interface OrganizerExecution {
  readonly planId: string;
  readonly state: "preview" | "running" | "partial" | "complete" | "expired";
  readonly itemCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly pendingVerificationCount: number;
}

export interface WriteReceipt {
  readonly status: "applied";
  readonly affectedCount?: number;
  readonly playlist?: { readonly id: string; readonly editableId: string; readonly title: string };
}
