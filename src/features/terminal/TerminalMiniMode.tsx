import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
} from "react";

import {
  getCurrentTrack,
  playerActions,
  usePlayerSelector,
  type PlaybackMode,
  type PlayerSnapshot,
} from "../player/playerStore";
import type { Track } from "../player/fixtures";
import { lyricIndexAt } from "../stage/ListeningStage";
import {
  deriveTerminalUpNext,
  type TerminalUpNext,
} from "./nextTrackPreview";
import { TerminalUpNextRunway } from "./TerminalUpNextRunway";
import { TerminalVinyl } from "./TerminalVinyl";

type TerminalPanel = "now-playing" | "lyrics" | "queue";

const MANUAL_LYRIC_SCROLL_RESUME_MS = 4_000;
const PROGRAMMATIC_LYRIC_SCROLL_SETTLE_MS = 600;

const selectQueue = (snapshot: PlayerSnapshot) => snapshot.queue;
const selectIsPlaying = (snapshot: PlayerSnapshot) => snapshot.isPlaying;
const selectVolume = (snapshot: PlayerSnapshot) => snapshot.volume;
const selectMuted = (snapshot: PlayerSnapshot) => snapshot.muted;
const selectMode = (snapshot: PlayerSnapshot) => snapshot.mode;
const selectLikedIds = (snapshot: PlayerSnapshot) => snapshot.likedIds;
const selectPlaybackError = (snapshot: PlayerSnapshot) => snapshot.playbackError;
const selectPosition = (snapshot: PlayerSnapshot) => snapshot.positionMs;

const MODE_LABELS: Record<PlaybackMode, string> = {
  sequence: "SEQUENCE",
  "repeat-all": "REPEAT ALL",
  "repeat-one": "REPEAT ONE",
  shuffle: "SHUFFLE",
};

function formatTime(milliseconds: number | null | undefined) {
  const totalSeconds = Math.max(0, Math.floor((milliseconds ?? 0) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stateLabel(isPlaying: boolean, hasTrack: boolean, hasError: boolean) {
  if (hasError) return "ERROR";
  if (!hasTrack) return "IDLE";
  return isPlaying ? "PLAYING" : "PAUSED";
}

interface TerminalKeyButtonProps {
  shortcut: string;
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  active?: boolean;
  emphasis?: boolean;
}

function TerminalKeyButton({
  shortcut,
  label,
  onClick,
  active = false,
  emphasis = false,
}: TerminalKeyButtonProps) {
  const className = [
    "terminal-key",
    active ? "terminal-key--active" : "",
    emphasis ? "terminal-key--emphasis" : "",
  ].filter(Boolean).join(" ");
  return (
    <button
      aria-label={`${shortcut} ${label}`}
      aria-pressed={active}
      className={className}
      data-tauri-drag-region="false"
      onClick={onClick}
      type="button"
    >
      <strong>{shortcut}</strong>
      <span>{label}</span>
    </button>
  );
}

interface TerminalProgressProps {
  durationMs: number | null;
}

function TerminalProgress({ durationMs }: TerminalProgressProps) {
  const positionMs = usePlayerSelector(selectPosition);
  const duration = Math.max(0, durationMs ?? 0);
  const progress = duration === 0 ? 0 : Math.min(1, Math.max(0, positionMs / duration));
  return (
    <div className="terminal-progress" data-testid="terminal-progress">
      <span className="terminal-progress__time">{formatTime(positionMs)}</span>
      <div
        aria-label="播放进度"
        aria-valuemax={duration}
        aria-valuemin={0}
        aria-valuenow={Math.min(positionMs, duration)}
        className="terminal-progress__track"
        role="progressbar"
      >
        <span className="terminal-progress__fill" style={{ width: `${progress * 100}%` }} />
        <i className="terminal-progress__cursor" style={{ left: `${progress * 100}%` }} />
      </div>
      <span className="terminal-progress__time">{formatTime(duration)}</span>
    </div>
  );
}

interface TerminalLyricPreviewProps {
  track: Track | null;
}

function TerminalLyricPreview({ track }: TerminalLyricPreviewProps) {
  const positionMs = usePlayerSelector(selectPosition);
  if (!track || track.lyrics.length === 0) {
    return <p className="terminal-lyric-preview terminal-lyric-preview--empty">NO LYRICS AVAILABLE</p>;
  }
  const activeIndex = lyricIndexAt(positionMs, track.lyrics);
  const current = track.lyrics[activeIndex];
  const next = track.lyrics[activeIndex + 1];
  return (
    <div className="terminal-lyric-preview">
      <p>{current?.original ?? "等待歌词"}</p>
      <span>{next?.original ?? "—"}</span>
    </div>
  );
}

interface TerminalLyricsPanelProps {
  track: Track | null;
}

function TerminalLyricsPanel({ track }: TerminalLyricsPanelProps) {
  const positionMs = usePlayerSelector(selectPosition);
  const activeIndex = track && track.lyrics.length > 0 ? lyricIndexAt(positionMs, track.lyrics) : -1;
  const containerRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const manualScrollTimer = useRef<number | null>(null);
  const programmaticScroll = useRef(false);
  const lastActiveIndex = useRef(-1);
  const [userScrolling, setUserScrolling] = useState(false);

  useEffect(() => {
    if (userScrolling || activeIndex < 0) return;
    if (!activeRef.current || !containerRef.current) return;
    if (activeIndex === lastActiveIndex.current) return;
    lastActiveIndex.current = activeIndex;

    programmaticScroll.current = true;
    if (typeof activeRef.current.scrollIntoView === "function") {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    const timer = window.setTimeout(() => {
      programmaticScroll.current = false;
    }, PROGRAMMATIC_LYRIC_SCROLL_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [activeIndex, userScrolling]);

  const handleScroll = useCallback(() => {
    if (programmaticScroll.current) return;

    setUserScrolling(true);
    if (manualScrollTimer.current !== null) {
      window.clearTimeout(manualScrollTimer.current);
    }
    manualScrollTimer.current = window.setTimeout(() => {
      setUserScrolling(false);
      manualScrollTimer.current = null;
      lastActiveIndex.current = -1;
    }, MANUAL_LYRIC_SCROLL_RESUME_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (manualScrollTimer.current !== null) {
        window.clearTimeout(manualScrollTimer.current);
      }
    };
  }, []);

  return (
    <section
      aria-label="歌词"
      className="terminal-panel terminal-panel--lyrics"
      onScroll={handleScroll}
      ref={containerRef}
    >
      <div className="terminal-panel__heading">
        <span>LYRICS</span>
        <small>{track?.title ?? "NO TRACK"}</small>
      </div>
      {track?.lyrics.length ? (
        <div className="terminal-lyrics-list">
          {track.lyrics.map((line, index) => (
            <p
              aria-current={index === activeIndex ? "true" : undefined}
              className={index === activeIndex ? "is-active" : index < activeIndex ? "is-past" : ""}
              key={`${line.atMs}-${index}`}
              ref={index === activeIndex ? activeRef : undefined}
            >
              <span>{line.original}</span>
              {line.translation ? <small>{line.translation}</small> : null}
            </p>
          ))}
        </div>
      ) : (
        <p className="terminal-panel__empty">NO LYRICS AVAILABLE</p>
      )}
    </section>
  );
}

interface TerminalQueuePanelProps {
  currentTrack: Track | null;
  queue: readonly Track[];
}

function TerminalQueuePanel({ currentTrack, queue }: TerminalQueuePanelProps) {
  return (
    <section aria-label="播放队列" className="terminal-panel terminal-panel--queue">
      <div className="terminal-panel__heading">
        <span>QUEUE</span>
        <small>{queue.length} TRACKS</small>
      </div>
      {queue.length === 0 ? (
        <p className="terminal-panel__empty">QUEUE IS EMPTY</p>
      ) : (
        <ol className="terminal-queue-list">
          {queue.map((track, index) => {
            const active = track.id === currentTrack?.id;
            return (
              <li className={active ? "is-active" : ""} key={track.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <button onClick={() => playerActions.playTrack(track.id)} type="button">
                  <strong>{track.title}</strong>
                  <small>{track.artist}</small>
                </button>
                {active ? <i aria-label="正在播放">●</i> : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

interface TerminalNowPlayingProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  mode: PlaybackMode;
  volume: number;
  muted: boolean;
  liked: boolean;
  playbackError: string | null;
  upNext: TerminalUpNext;
  onPanelChange: (panel: TerminalPanel) => void;
  onExit: () => void;
}

function TerminalNowPlaying({
  currentTrack,
  isPlaying,
  mode,
  volume,
  muted,
  liked,
  playbackError,
  upNext,
  onPanelChange,
  onExit,
}: TerminalNowPlayingProps) {
  const status = stateLabel(isPlaying, Boolean(currentTrack), Boolean(playbackError));
  return (
    <main className="terminal-mini__body" id="main-content">
      <section className="terminal-now-playing">
        <div className="terminal-mini__vinyl-wrap">
          <TerminalVinyl hasTrack={Boolean(currentTrack)} isPlaying={isPlaying} />
          <span className="terminal-vinyl-caption">↻ 33⅓ RPM · {status}</span>
        </div>

        <section aria-label="当前歌曲" className="terminal-track-info">
          <span className="terminal-eyebrow">NOW PLAYING</span>
          <h1>{currentTrack?.title ?? "Nothing playing"}</h1>
          <p>{currentTrack?.artist ?? "从曲库选择一首歌"}</p>
          <small>{currentTrack?.album ?? "VINYL GREENHOUSE"}</small>
        </section>

        <TerminalLyricPreview track={currentTrack} />

        <TerminalProgress durationMs={currentTrack?.durationMs ?? null} />

        {playbackError ? <p className="terminal-error" role="status">{playbackError}</p> : null}

        <nav aria-label="主要播放控制" className="terminal-controls terminal-controls--primary">
          <TerminalKeyButton label="PREV" onClick={() => playerActions.previous()} shortcut="P" />
          <TerminalKeyButton
            emphasis
            label={isPlaying ? "PAUSE" : "PLAY"}
            onClick={() => playerActions.toggle()}
            shortcut="SPACE"
          />
          <TerminalKeyButton label="NEXT" onClick={() => playerActions.next()} shortcut="N" />
        </nav>

        <section aria-label="播放信息" className="terminal-track-meta">
          <div className="terminal-volume" aria-label="音量">
            <span>VOL</span>
            <div className="terminal-volume__blocks" aria-hidden="true">
              {Array.from({ length: 12 }, (_, index) => (
                <i className={index < Math.round(volume * 12) && !muted ? "is-on" : ""} key={index} />
              ))}
            </div>
            <strong>{muted ? "MUTED" : `${Math.round(volume * 100)}%`}</strong>
          </div>
          <span className="terminal-track-meta__mode">
            <i>SESSION //</i>
            <strong>{MODE_LABELS[mode]}</strong>
            <strong className={liked ? "is-active" : ""}>{liked ? "LIKED" : "NOT LIKED"}</strong>
          </span>
        </section>

        <nav aria-label="次要播放控制" className="terminal-controls terminal-controls--secondary">
          <TerminalKeyButton label="LYRICS" onClick={() => onPanelChange("lyrics")} shortcut="L" />
          <TerminalKeyButton label="QUEUE" onClick={() => onPanelChange("queue")} shortcut="Q" />
          <TerminalKeyButton label="LIKE" onClick={() => currentTrack && playerActions.toggleLike(currentTrack.id)} shortcut="F" active={liked} />
          <TerminalKeyButton label="MUTE" onClick={() => playerActions.toggleMute()} shortcut="M" active={muted} />
          <TerminalKeyButton label="MODE" onClick={() => playerActions.cycleMode()} shortcut="O" />
          <TerminalKeyButton label="GUI" onClick={onExit} shortcut="G" />
        </nav>

        <TerminalUpNextRunway model={upNext} />
      </section>
    </main>
  );
}

export interface TerminalMiniModeProps {
  onExit: () => void;
}

export function TerminalMiniMode({ onExit }: TerminalMiniModeProps) {
  const currentTrack = usePlayerSelector(getCurrentTrack);
  const queue = usePlayerSelector(selectQueue);
  const isPlaying = usePlayerSelector(selectIsPlaying);
  const volume = usePlayerSelector(selectVolume);
  const muted = usePlayerSelector(selectMuted);
  const mode = usePlayerSelector(selectMode);
  const likedIds = usePlayerSelector(selectLikedIds);
  const playbackError = usePlayerSelector(selectPlaybackError);
  const [panel, setPanel] = useState<TerminalPanel>("now-playing");
  const liked = currentTrack ? likedIds.includes(currentTrack.id) : false;
  const upNext = deriveTerminalUpNext(currentTrack, queue, mode, 5);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.isContentEditable || Boolean(target.closest("button, input, textarea, select, a[href]")))
      ) return;

      const key = event.key.toLowerCase();
      if (event.key === " ") {
        event.preventDefault();
        playerActions.toggle();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        playerActions.seekBy(-5_000);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        playerActions.seekBy(5_000);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        playerActions.setVolume(Math.min(1, volume + 0.05));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        playerActions.setVolume(Math.max(0, volume - 0.05));
      } else if (key === "p") {
        event.preventDefault();
        playerActions.previous();
      } else if (key === "n") {
        event.preventDefault();
        playerActions.next();
      } else if (key === "m") {
        event.preventDefault();
        playerActions.toggleMute();
      } else if (key === "o") {
        event.preventDefault();
        playerActions.cycleMode();
      } else if (key === "f") {
        event.preventDefault();
        if (currentTrack) playerActions.toggleLike(currentTrack.id);
      } else if (key === "l") {
        event.preventDefault();
        setPanel("lyrics");
      } else if (key === "q") {
        event.preventDefault();
        setPanel("queue");
      } else if (event.key === "Escape") {
        event.preventDefault();
        setPanel("now-playing");
      } else if (key === "g") {
        event.preventDefault();
        onExit();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentTrack, onExit, volume]);

  return (
    <div className="terminal-mini" data-testid="terminal-mini">
      <header className="terminal-mini__header" data-tauri-drag-region>
        <div className="terminal-mini__brand" data-tauri-drag-region>
          <span aria-hidden="true" className="terminal-mini__mark">◇</span>
          <div>
            <strong>QQ MUSIC</strong>
            <span>{stateLabel(isPlaying, Boolean(currentTrack), Boolean(playbackError))} · VINYL GREENHOUSE</span>
          </div>
        </div>
        <button className="terminal-mini__exit" data-tauri-drag-region="false" onClick={onExit} type="button">G GUI</button>
      </header>

      {panel === "now-playing" ? (
        <TerminalNowPlaying
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          liked={liked}
          mode={mode}
          muted={muted}
          onExit={onExit}
          onPanelChange={setPanel}
          playbackError={playbackError?.message ?? null}
          upNext={upNext}
          volume={volume}
        />
      ) : panel === "lyrics" ? (
        <main className="terminal-mini__body terminal-mini__body--panel" id="main-content">
          <TerminalLyricsPanel track={currentTrack} />
          <TerminalProgress durationMs={currentTrack?.durationMs ?? null} />
          <nav aria-label="终端面板控制" className="terminal-controls terminal-controls--panel">
            <TerminalKeyButton label="NOW PLAYING" onClick={() => setPanel("now-playing")} shortcut="ESC" />
            <TerminalKeyButton label="QUEUE" onClick={() => setPanel("queue")} shortcut="Q" />
            <TerminalKeyButton label="GUI" onClick={onExit} shortcut="G" />
          </nav>
        </main>
      ) : (
        <main className="terminal-mini__body terminal-mini__body--panel" id="main-content">
          <TerminalQueuePanel currentTrack={currentTrack} queue={queue} />
          <TerminalProgress durationMs={currentTrack?.durationMs ?? null} />
          <nav aria-label="终端面板控制" className="terminal-controls terminal-controls--panel">
            <TerminalKeyButton label="NOW PLAYING" onClick={() => setPanel("now-playing")} shortcut="ESC" />
            <TerminalKeyButton label="LYRICS" onClick={() => setPanel("lyrics")} shortcut="L" />
            <TerminalKeyButton label="GUI" onClick={onExit} shortcut="G" />
          </nav>
        </main>
      )}
    </div>
  );
}
