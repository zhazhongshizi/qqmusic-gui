import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentTrack, playerActions, usePlayerSelector } from "../player/playerStore";
import type { Track } from "../player/fixtures";
import { useOutroPreview } from "../stage/useOutroPreview";

interface PreviewContent {
  items: readonly Track[];
  start: number;
  total: number;
  label: string;
  nextId: string | null;
  currentId?: string;
}

export function DeckOutroPreview() {
  const outro = useOutroPreview();
  const queue = usePlayerSelector(s => s.queue);
  const current = usePlayerSelector(getCurrentTrack);
  const panelRef = useRef<HTMLElement>(null);
  const nextIndex = queue.findIndex(track => track.id === outro.nextId);
  const live = useMemo<PreviewContent | null>(() => {
    if (!outro.active || nextIndex < 0) return null;
    const start = Math.max(0, Math.min(nextIndex - 2, queue.length - 5));
    return { items: queue.slice(start, start + 5), start, total: queue.length,
      label: outro.label, nextId: outro.nextId, currentId: current?.id };
  }, [outro.active, nextIndex, queue, outro.label, outro.nextId, current?.id]);
  const [retained, setRetained] = useState<PreviewContent | null>(null);
  const content = live ?? retained;
  useEffect(() => {
    if (live) {
      setRetained(live);
      return;
    }
    if (!retained) return;
    if (panelRef.current?.contains(document.activeElement)) focusPlayback();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setRetained(null), reduced ? 0 : 300);
    return () => clearTimeout(timer);
  }, [live, retained]);
  useEffect(() => {
    if (outro.active) panelRef.current?.querySelector('[data-up-next="true"]')?.scrollIntoView?.({ block: "center" });
  }, [outro.active, outro.nextId, nextIndex]);
  if (!content) return null;

  function focusPlayback() {
    panelRef.current?.closest(".rhine-deck")?.querySelector<HTMLButtonElement>(".rhine-deck-play")?.focus();
  }

  function dismiss() {
    focusPlayback();
    outro.dismiss();
  }

  return <aside className="rhine-deck-preview" aria-label="下一首预告" ref={panelRef}
    data-exiting={!live} inert={!live} aria-hidden={!live || undefined}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); dismiss(); } }}>
    <header>
      <h2>{content.label}</h2>
      <span>{content.total} 首歌曲</span>
      <button type="button" aria-label="关闭下一首预告" onClick={dismiss}>×</button>
    </header>
    <ol start={content.start + 1}>
      {content.items.map((track, index) => <li key={track.id}>
        <button type="button" data-up-next={track.id === content.nextId ? "true" : undefined}
          aria-current={track.id === content.currentId ? "true" : undefined}
          onClick={() => playerActions.playTrack(track.id)}>
          <span className="rhine-deck-preview-number">{track.id === content.currentId ? "♪" : String(content.start + index + 1).padStart(2, "0")}</span>
          <span className="rhine-deck-preview-identity"><strong>{track.title}</strong><small>{track.id === content.nextId ? `${content.label} · ` : ""}{track.artist}</small></span>
        </button>
      </li>)}
    </ol>
  </aside>;
}
