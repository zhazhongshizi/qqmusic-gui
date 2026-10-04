import { useCallback, useEffect, useRef, useState } from "react";

import type { LyricLine } from "../player/fixtures";

interface ScrollingLyricsProps {
  readonly lyrics: readonly LyricLine[];
  readonly activeIndex: number;
}

const MANUAL_SCROLL_RESUME_MS = 4_000;

export function ScrollingLyrics({ lyrics, activeIndex }: ScrollingLyricsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const manualScrollTimer = useRef<number | null>(null);
  const [userScrolling, setUserScrolling] = useState(false);
  const programmaticScroll = useRef(false);
  const lastActiveIndex = useRef(-1);

  // Recenter after a tablet rotation or panel resize, without resetting outro state.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined" || userScrolling) return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      const active = activeRef.current;
      if (!active) return;
      programmaticScroll.current = true;
      container.scrollTo({ top: active.offsetTop - container.clientHeight / 2 + active.clientHeight / 2, behavior: "instant" });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { programmaticScroll.current = false; }, 600);
    });
    observer.observe(container);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [userScrolling, lyrics]);

  useEffect(() => {
    if (userScrolling) return;
    if (!activeRef.current || !containerRef.current) return;
    if (activeIndex === lastActiveIndex.current) return;
    lastActiveIndex.current = activeIndex;

    programmaticScroll.current = true;
    if (typeof activeRef.current.scrollIntoView === "function") {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    const timer = window.setTimeout(() => {
      programmaticScroll.current = false;
    }, 600);
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
    }, MANUAL_SCROLL_RESUME_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (manualScrollTimer.current !== null) {
        window.clearTimeout(manualScrollTimer.current);
      }
    };
  }, []);

  if (lyrics.length === 0) {
    return (
      <section aria-label="同步歌词" className="lyrics-scroll">
        <p className="lyrics-scroll__eyebrow">正在播放 · 歌词</p>
        <div className="lyrics-scroll__empty">
          <p className="lyrics-scroll__line lyrics-scroll__line--active">暂无歌词</p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="同步歌词" className="lyrics-scroll">
      <p className="lyrics-scroll__eyebrow">正在播放 · 歌词</p>
      <div
        ref={containerRef}
        className="lyrics-scroll__container"
        onScroll={handleScroll}
      >
        <div className="lyrics-scroll__spacer" />

        {lyrics.map((line, index) => {
          const isActive = index === activeIndex;
          const isPast = index < activeIndex;
          const cls = [
            "lyrics-scroll__line",
            isActive && "lyrics-scroll__line--active",
            isPast && "lyrics-scroll__line--past",
            !isActive && !isPast && "lyrics-scroll__line--upcoming",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div
              key={line.atMs + "-" + index}
              ref={isActive ? activeRef : undefined}
              className={cls}
              aria-current={isActive ? "true" : undefined}
            >
              <p
                className="lyrics-scroll__original"
                aria-live={isActive ? "polite" : undefined}
                aria-atomic={isActive ? "true" : undefined}
              >
                {line.original}
              </p>
              {line.translation ? (
                <p className="lyrics-scroll__translation">{line.translation}</p>
              ) : null}
              {line.romanized ? (
                <p className="lyrics-scroll__romanized">{line.romanized}</p>
              ) : null}
            </div>
          );
        })}

        <div className="lyrics-scroll__spacer" />
      </div>

      {userScrolling ? (
        <button
          type="button"
          className="lyrics-scroll__back-button"
          onClick={() => {
            setUserScrolling(false);
            if (manualScrollTimer.current !== null) {
              window.clearTimeout(manualScrollTimer.current);
              manualScrollTimer.current = null;
            }
            lastActiveIndex.current = -1;
          }}
        >
          回到当前
        </button>
      ) : null}
    </section>
  );
}
