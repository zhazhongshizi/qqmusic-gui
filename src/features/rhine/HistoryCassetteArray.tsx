import type { ArchiveTrack } from "./vendor/archive-artwork";
import { ArchiveCanvas } from "./ArchiveCanvas";
import type { RenderQuality } from "./vendor/render-quality";
import type { ArchiveRenderer, RhineFrameLimit } from "./rhineSettings";

export function HistoryCassetteArray({ tracks, selected, detail, active, quality, superPerformance, renderer, frameLimit, spatialUpscaling, onSelect, onOpen }: {
  renderer?: ArchiveRenderer;
  frameLimit?: RhineFrameLimit;
  spatialUpscaling?: boolean;
  tracks: readonly ArchiveTrack[]; selected: number; detail: boolean; active: boolean; quality: RenderQuality; superPerformance: boolean;
  onSelect: (index: number) => void; onOpen: (index: number) => void;
}) {
  return <div className="rhine-history-array" data-cassette-count={tracks.length}>
    <ArchiveCanvas renderer={renderer} frameLimit={frameLimit} spatialUpscaling={spatialUpscaling} count={tracks.length} titles={tracks.map(track => track.title)}
      archiveTracks={tracks.map(({ id, title, artist, coverCacheKey }) => ({ id, title, artist, coverCacheKey }))}
      selected={selected} detail={detail} active={active} quality={quality} superPerformance={superPerformance}
      onSelect={onSelect} onOpen={onOpen} />
  </div>;
}
