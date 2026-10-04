import { useEffect, useState, type CSSProperties } from "react";
import { SongArtistLinks } from "../artist/SongArtistLinks";

type Caption = { id: string; title: string; artist: string; album?: string };
export function DeckCaption({ track, playlistTitle, direction }: {
  track: Caption | null; playlistTitle?: string; direction: () => number;
}) {
  const current = track ?? { id: "", title: "等待装载", artist: "RHINE LAB" };
  const playlist = playlistTitle || "当前播放队列";
  const [view, setView] = useState({ current, previous: null as Caption | null, serial: 0, direction: 0 });
  const [label, setLabel] = useState({ text: playlist, changed: false });
  if (view.current.id !== current.id) {
    setView({ current, previous: view.current, serial: view.serial + 1, direction: direction() });
  } else if (view.current.title !== current.title || view.current.artist !== current.artist || view.current.album !== current.album) {
    setView({ ...view, current });
  }
  if (label.text !== playlist) setLabel({ text: playlist, changed: true });
  useEffect(() => {
    if (!view.previous) return;
    const timer = window.setTimeout(() => setView(value => ({ ...value, previous: null })), 340);
    return () => window.clearTimeout(timer);
  }, [view.serial]);
  const content = (value: Caption, interactive = false) => <><h1>{value.title}</h1><p>{interactive && track ? <SongArtistLinks track={value} /> : value.artist}{value.album ? ` / ${value.album}` : ""}</p></>;
  return <div className="rhine-deck-caption" style={{ "--caption-shift": `${view.direction * 12}px` } as CSSProperties}>
    <span>ARCHIVE PLAYER / 01</span>
    <div className="rhine-caption-stack" key={view.serial}>
      {view.previous && <div className="rhine-caption-out" aria-hidden="true">{content(view.previous)}</div>}
      <div className={view.previous ? "rhine-caption-in" : undefined}>{content(current, true)}</div>
    </div>
    <small key={label.text} className={label.changed ? "rhine-caption-label" : undefined}>{playlist}</small>
  </div>;
}
