import { useOutroPreview } from "./useOutroPreview";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { getCurrentTrack, playerActions, usePlayerSelector, type PlayerSnapshot } from "../player/playerStore";

const selectQueue = (snapshot: PlayerSnapshot) => snapshot.queue;

function StageSongList({ nextId, nextLabel }: { nextId?: string | null; nextLabel: string }) {
  const queue = usePlayerSelector(selectQueue);
  const current = usePlayerSelector(getCurrentTrack);
  const listRef = useRef<HTMLOListElement>(null);
  const queueKey = JSON.stringify(queue.map((track) => track.id));
  useEffect(() => {
    listRef.current?.querySelector(nextId ? '[data-up-next="true"]' : '[aria-current="true"]')?.scrollIntoView?.({ block: "center" });
  }, [current?.id, queueKey, nextId]);
  return (
    <>
      <header className="stage-song-list__header"><h2>{nextId ? nextLabel : "播放队列"}</h2><span>{queue.length} 首歌曲</span></header>
      <ol className="stage-song-list__items" ref={listRef}>
        {queue.map((track, index) => (
          <li key={track.id}>
            <button type="button" data-up-next={nextId === track.id ? "true" : undefined} aria-current={current?.id === track.id ? "true" : undefined}
              onClick={() => playerActions.playTrack(track.id)}>
              <span className="stage-song-list__number">{current?.id === track.id ? "♪" : index + 1}</span>
              <span className="stage-song-list__identity"><strong>{track.title}</strong><small>{nextId === track.id ? `${nextLabel} · ` : ""}{track.artist}</small></span>
            </button>
          </li>
        ))}
      </ol>
      {queue.length === 0 ? <p>播放队列是空的</p> : null}
    </>
  );
}

export function StageLyricsPanel({ children, hasLyrics = true, settings }: { children: ReactNode; hasLyrics?: boolean; settings?: ReactNode }) {
  const showingSettings = Boolean(settings);
  const [manuallyOpen, setOpen] = useState(false);
  const outro = useOutroPreview();
  const lyricsPending = usePlayerSelector((s) => s.nativeMode && s.lyricsReady === false);
  const pinned = !hasLyrics && !lyricsPending;
  const open = manuallyOpen || pinned || outro.active;
  const current = usePlayerSelector(getCurrentTrack);
  useEffect(() => { if (outro.active) setOpen(false); }, [outro.active]);
  const rootRef = useRef<HTMLElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const resetIdleTimer = useCallback(() => {
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    idleTimer.current = null;
    if (showingSettings || !open || pinned || outro.active) return;
    idleTimer.current = setTimeout(() => {
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      setOpen(false);
    }, 20_000);
  }, [open, pinned, outro.active, showingSettings]);
  useEffect(() => {
    resetIdleTimer();
    return () => { if (idleTimer.current !== null) clearTimeout(idleTimer.current); };
  }, [resetIdleTimer, current?.id]);
  return (
    <section ref={rootRef} onPointerMove={resetIdleTimer} onPointerDown={resetIdleTimer}
      onWheel={resetIdleTimer} onScrollCapture={resetIdleTimer} onFocusCapture={resetIdleTimer}
      className="stage-lyrics-panel" data-queue-open={open} aria-label="歌词与播放队列"
      onKeyDown={(event) => {
        resetIdleTimer();
        if (!showingSettings && event.key === "Escape" && open && hasLyrics) {
          event.stopPropagation();
          outro.dismiss();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}>
      {settings}
      <div className="stage-lyrics-panel__lyrics" hidden={showingSettings || open}>{children}</div>
      <div className="stage-song-list" id={panelId} hidden={showingSettings || !open}>
        {open ? <StageSongList nextId={outro.active ? outro.nextId : null} nextLabel={outro.label} /> : null}
      </div>
      <div className="stage-lyrics-panel__edge" hidden={showingSettings || pinned}>
        <button type="button" className="stage-lyrics-panel__toggle" ref={triggerRef}
          aria-label={open ? "返回歌词" : "展开歌曲列表"} aria-expanded={open} aria-controls={panelId}
          onClick={() => { if (open) { outro.dismiss(); setOpen(false); } else setOpen(true); }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d={open ? "m9 5 7 7-7 7" : "m15 5-7 7 7 7"} />
          </svg>
        </button>
      </div>
    </section>
  );
}
