import {
  type CSSProperties,
  type ReactNode,
} from "react";

import { AlbumArtwork } from "./AlbumArtwork";
import { NeedleScale } from "./NeedleScale";
import { StageLyricsPanel } from "./StageLyricsPanel";
import { ScrollingLyrics } from "./ScrollingLyrics";
import {
  getCurrentTrack,
  usePlayerSelector,
  type PlayerSnapshot,
} from "../player/playerStore";
import { PlaybackQualitySelector } from "../player/PlaybackQualitySelector";
import { MvLyricOffsetControl } from "../player/MvPlaybackSettings";
import { localMusicFormatFromId } from "../../contracts/localMusic";
import { StageSpectrum } from "../spectrum/StageSpectrum";
import { CachedGlow } from "./CachedGlow";
import { SongArtistLinks } from "../artist/SongArtistLinks";

const selectNativeMode = (snapshot: PlayerSnapshot) => snapshot.nativeMode;
const selectPosition = (snapshot: PlayerSnapshot) => snapshot.positionMs;
const selectRequestedQuality = (snapshot: PlayerSnapshot) => snapshot.requestedQuality;

export function lyricIndexAt(positionMs: number, timings: readonly { atMs: number }[]) {
  let index = 0;
  for (let candidate = 0; candidate < timings.length; candidate += 1) {
    const line = timings[candidate];
    if (!line || line.atMs > positionMs) break;
    index = candidate;
  }
  return index;
}

function StageNeedleScale({ track }: { track: NonNullable<ReturnType<typeof getCurrentTrack>> }) {
  const positionMs = usePlayerSelector(selectPosition);
  const progress = track.durationMs === 0 ? 0 : positionMs / track.durationMs;
  return <NeedleScale progress={progress} />;
}

function StageScrollingLyrics({ track }: { track: NonNullable<ReturnType<typeof getCurrentTrack>> }) {
  const activeIndex = usePlayerSelector((snapshot) => lyricIndexAt(snapshot.positionMs, track.lyrics));
  return (
    <ScrollingLyrics
      lyrics={track.lyrics}
      activeIndex={activeIndex}
    />
  );
}

export function ListeningStage({
  settings,
  liveSpectrumEnabled = false,
  spectrumRenderable = true,
  spectrumPaletteKey,
  cachedGlow = false,
  glowPaletteKey = "",
}: {
  readonly settings?: ReactNode;
  readonly liveSpectrumEnabled?: boolean;
  readonly spectrumRenderable?: boolean;
  readonly spectrumPaletteKey?: string;
  readonly cachedGlow?: boolean;
  readonly glowPaletteKey?: string;
}) {
  const track = usePlayerSelector(getCurrentTrack);
  const nativeMode = usePlayerSelector(selectNativeMode);
  const requestedQuality = usePlayerSelector(selectRequestedQuality);

  if (!track) {
    return (
      <section className={settings ? "stage stage--settings-empty" : "stage stage--empty"}>
        <div className="stage--empty">
        <p>队列是空的</p>
        <span>从曲库选择一首歌，音乐会从这里开始。</span>
        </div>
        {settings ? <><div aria-hidden="true" /><StageLyricsPanel settings={settings}>{null}</StageLyricsPanel></> : null}
      </section>
    );
  }
  const localFormat = localMusicFormatFromId(track.id);

  return (
    <main className="stage" id="main-content">
      <div
        aria-hidden="true"
        className="stage__ambient"
        style={{ "--ambient-color": track.accent } as CSSProperties}
      >
        {cachedGlow ? <>
          <CachedGlow kind="artwork-core" paletteKey={glowPaletteKey} />
        </> : <>
          <span aria-hidden="true" className="stage__glow stage__glow--field" />
          <span aria-hidden="true" className="stage__glow stage__glow--artwork-core" />
        </>}
      </div>

      <section className="stage__cover-column" aria-label="当前专辑">
        <div className="stage__edition">
          <span>{localFormat ? "LOCAL MUSIC" : nativeMode ? "QQ LIVE" : "LOCAL FIXTURE"}</span>
          <span>{nativeMode ? "NATIVE SESSION" : "SESSION 01"}</span>
        </div>
        <AlbumArtwork track={track} />
        <div className="stage__metadata">
          <p className="stage__album">{track.album}</p>
          <h1>{track.title}</h1>
          <p><SongArtistLinks track={track} /></p>
        </div>
        <div className="stage__quality" aria-label="播放质量">
          <span>实际 {track.actualQuality}</span>
          {localFormat ? <span>本地文件</span> : <PlaybackQualitySelector quality={requestedQuality} />}
        </div>
        <MvLyricOffsetControl />
      </section>

      <div className="stage__spine">
        {liveSpectrumEnabled ? <StageSpectrum renderable={spectrumRenderable} paletteKey={spectrumPaletteKey} /> : null}
        <StageNeedleScale track={track} />
      </div>

      <StageLyricsPanel settings={settings} hasLyrics={track.lyrics.some((line) => line.original.trim().length > 0)}><StageScrollingLyrics track={track} /></StageLyricsPanel>
    </main>
  );
}
