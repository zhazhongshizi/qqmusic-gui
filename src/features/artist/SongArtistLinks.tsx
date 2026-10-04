import { useContext, useEffect, useRef, useState } from "react";
import { getSongArtists } from "../../backend/artistAdapter";
import { playbackSessionIdentity } from "../../backend/playbackTransport";
import type { ArtistRef } from "../../contracts/artist";
import { ArtistNavigationContext } from "./ArtistNavigation";

type ArtistTrack = { id: string; artist: string; artists?: readonly ArtistRef[] };

export function SongArtistLinks({ track, onOpenArtist }: {
  track: ArtistTrack; onOpenArtist?: (artist: ArtistRef) => void;
}) {
  return <ArtistNames key={`${playbackSessionIdentity()}:${track.id}:${track.artist}`} track={track} onOpenArtist={onOpenArtist} />;
}

function ArtistNames({ track, onOpenArtist }: { track: ArtistTrack; onOpenArtist?: (artist: ArtistRef) => void }) {
  const navigate = useContext(ArtistNavigationContext);
  const open = onOpenArtist ?? navigate;
  const [resolved, setResolved] = useState<readonly ArtistRef[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<Promise<readonly ArtistRef[]> | null>(null);
  const version = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; version.current++; }; }, []);
  const artists = track.artists?.length ? track.artists : resolved;
  const names = artists?.map(artist => artist.name) ?? track.artist.split(" / ").filter(Boolean);
  const online = !track.id.startsWith("local_") && !track.id.startsWith("fixture-");
  async function visit(index: number) {
    if (!open) return;
    const request = ++version.current;
    const identity = playbackSessionIdentity();
    const current = () => alive.current && request === version.current && identity === playbackSessionIdentity();
    setError("");
    try {
      if (artists?.[index]) { open(artists[index]); return; }
      setBusy(true);
      pending.current ??= getSongArtists(track.id);
      const result = await pending.current;
      if (!current()) return;
      setResolved(result);
      // Match the clicked name against this song's artists, never a name search.
      const matches = result.filter(artist => artist.name === names[index]);
      if (matches.length === 1) open(matches[0]!);
      else if (result.length === 1) open(result[0]!);
      else setError("请选择对应的歌手。");
    } catch { if (current()) { pending.current = null; setError("歌手资料读取失败，请再点击重试。"); } }
    finally { if (current()) setBusy(false); }
  }
  if (!open || !online) return <>{track.artist}</>;
  return <span className="song-artist-links" aria-busy={busy}>
    {names.map((name, index) => <span key={`${name}:${index}`}>
      {index > 0 && <span aria-hidden="true"> / </span>}
      <button type="button" className="song-artist-link" aria-label={`查看歌手 ${name}`} aria-disabled={busy}
        onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if (!busy) void visit(index); }}>{name}</button>
    </span>)}
    {error && <span className="song-artist-error" role="status">{error}</span>}
  </span>;
}
