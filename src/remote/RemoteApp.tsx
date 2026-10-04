import { useEffect, useState, useSyncExternalStore } from "react";
import LibraryWorkspace from "../features/library/LibraryWorkspace";
import { Icon } from "../components/Icon";
import type { AuthSnapshot } from "../contracts/auth";
import type { LibrarySection } from "../app/uiModes";
import { ListeningStage } from "../features/stage/ListeningStage";
import { PlayerBar } from "../features/player/PlayerBar";
import { QueueDrawer } from "../features/player/QueueDrawer";
import { NativePlayerBridge } from "../features/player/NativePlayerBridge";
import { getCurrentTrack, playerActions, usePlayerSelector } from "../features/player/playerStore";
import { useCoverPalette } from "../features/stage/coverPalette";
import { connectRemote, disconnectRemote, invokeRemote, remoteStatus, subscribeRemote } from "./remoteTransport";
import { ArtistNavigationContext, ArtistNavigationContent, useArtistNavigation } from "../features/artist/ArtistNavigation";

export function RemoteApp() {
  const artistNavigation = useArtistNavigation();
  const connection = useSyncExternalStore(subscribeRemote, remoteStatus);
  const [ready, setReady] = useState(false);
  const [code, setCode] = useState(() => {
    const linkCode = new URLSearchParams(location.hash.slice(1)).get("code");
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    return linkCode ?? sessionStorage.getItem("qmg-remote-code") ?? "";
  });
  const [error, setError] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [section, setSection] = useState<LibrarySection | null>(null);
  const [auth, setAuth] = useState<AuthSnapshot>({ state: "unavailable" });
  const track = usePlayerSelector(getCurrentTrack);
  const { palette, style } = useCoverPalette(ready ? track : null, "standard");
  const paired = ready && connection !== "disconnected" && connection !== "connecting";
  useEffect(() => {
    if (!paired || connection !== "online") return;
    let active = true;
    let reading = false;
    const refresh = async () => {
      if (reading || document.visibilityState !== "visible") return;
      reading = true;
      try {
        const value = await invokeRemote("auth_status") as { state?: string };
        if (active && ["authenticated", "signedOut", "unavailable"].includes(value.state ?? "")) {
          setAuth(previous => previous.state === value.state ? previous : { state: value.state } as AuthSnapshot);
        }
      } catch { /* Existing page errors remain visible; playback polling handles reconnect. */ }
      finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [paired, connection]);
  async function connect() {
    setError(""); setReady(false);
    try {
      playerActions.applyAuthoritativeSession(await connectRemote(code));
      setReady(true);
    } catch { setError("无法连接，请检查电脑遥控开关、连接码和网络。"); }
  }
  if (!paired) return <main className="remote-pair">
    <span className="section-label">QQ MUSIC · REMOTE</span>
    <h1>连接你的音乐</h1><p>在电脑的「更多 → 局域网遥控」中查看连接码。</p>
    <form onSubmit={(event) => { event.preventDefault(); void connect(); }}>
      <label htmlFor="pair-code">连接码</label>
      <input id="pair-code" type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} required />
      <button type="submit" disabled={connection === "connecting"}>{connection === "connecting" ? "正在连接…" : "连接电脑"}</button>
    </form><p role="alert">{error}</p><small>声音由电脑播放。</small>
  </main>;
  return <ArtistNavigationContext.Provider value={artist => { setQueueOpen(false); artistNavigation.openArtist(artist); }}>
    <NativePlayerBridge />
    <div className="app-shell app-shell--normal remote-shell" data-cover-tone={palette.tone} data-glow-intensity="standard" data-glow-renderer="original" style={style}>
      <header className="remote-header"><span>QQ MUSIC <small>遥控 · 声音在电脑</small></span>
        <nav className="top-bar__nav remote-nav" aria-label="音乐导航">
          {([['discover', 'library', '曲库'], ['search', 'search', '搜索'], ['liked', 'heart', '喜欢']] as const).map(([id, icon, label]) =>
            <button key={id} type="button" aria-pressed={section === id} onClick={() => { artistNavigation.closeArtist(false); setSection(id); }}><Icon name={icon} size={18} />{label}</button>)}
        </nav>
        <span role="status">{connection === "online" ? "已连接" : "连接中断，正在重连…"}</span>
        <button onClick={() => { artistNavigation.closeArtist(false); setQueueOpen(false); disconnectRemote(); }}>断开</button>
      </header>
      <div className="app-shell__content" inert={connection !== "online"}>
        <ArtistNavigationContent artist={artistNavigation.artist} onBack={artistNavigation.closeArtist}>
        <div className="remote-stage" hidden={section !== null}><ListeningStage /></div>
        {section !== null && <LibraryWorkspace remote authRecovering={false} authSnapshot={auth} initialSection={section} onSectionChange={setSection} onBack={() => setSection(null)} />}
        </ArtistNavigationContent>
      </div>
      <div className="remote-player" inert={connection !== "online"}><PlayerBar queueOpen={queueOpen} onOpenQueue={() => setQueueOpen(true)} /></div>
    </div>
    <QueueDrawer open={queueOpen && connection === "online"} onClose={() => setQueueOpen(false)} editable={false} />
  </ArtistNavigationContext.Provider>;
}

