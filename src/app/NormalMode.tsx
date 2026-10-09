import {
  lazy, Suspense, useEffect, useRef, useState,
  type Dispatch, type SetStateAction, type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Icon } from "../components/Icon";
import { WindowControls } from "../components/WindowControls";
import { PlayerBar } from "../features/player/PlayerBar";
import { ArtistNavigationContext, ArtistNavigationContent, useArtistNavigation } from "../features/artist/ArtistNavigation";
import { SmartShuffleToggle } from "../features/player/SmartShuffleToggle";
import { MvFallbackSetting } from "../features/player/MvPlaybackSettings";
import { RemoteControlSettings } from "../features/player/RemoteControlSettings";
import { LoggingSettings } from "../features/player/LoggingSettings";
import UpdateSettings from "../features/player/UpdateSettings";
import { QueueDrawer } from "../features/player/QueueDrawer";
import { ListeningStage } from "../features/stage/ListeningStage";
import { CachedGlow } from "../features/stage/CachedGlow";
import { BackendStatus } from "../features/status/BackendStatus";
import { PLAYBACK_QUALITY_OPTIONS, type PlaybackQuality } from "../contracts/settings";
import type { AuthSnapshot } from "../contracts/auth";
import { getCurrentTrack, playerActions, usePlayerSelector, type PlayerSnapshot } from "../features/player/playerStore";
import type { GlowIntensityLevel } from "../features/stage/coverPalette";
import { PublicState, type FixtureStatus } from "../features/status/PublicState";
import type { AppView, LibrarySection } from "./uiModes";
const LibraryWorkspace = lazy(() => import("../features/library/LibraryWorkspace"));
const selectLikedIds = (snapshot: PlayerSnapshot) => snapshot.likedIds;
const selectNativeMode = (snapshot: PlayerSnapshot) => snapshot.nativeMode;

const STATUS_OPTIONS: readonly { id: FixtureStatus; label: string }[] = [
  { id: "normal", label: "正常" },
  { id: "loading", label: "载入中" },
  { id: "empty", label: "空内容" },
  { id: "partial", label: "部分内容" },
  { id: "error", label: "读取失败" },
  { id: "unauthenticated", label: "未登录" },
];

const GLOW_OPTIONS: readonly { id: GlowIntensityLevel; label: string }[] = [
  { id: "off", label: "光晕：关闭" },
  { id: "subtle", label: "光晕：柔和" },
  { id: "standard", label: "光晕：标准" },
  { id: "enhanced", label: "光晕：增强" },
];

interface TopBarProps {
  view: AppView;
  onNavigate: (section: LibrarySection) => void;
  onBack: () => void;
  onAccount: () => void;
  accountLabel: string;
  settingsOpen: boolean;
  onSettingsToggle: () => void;
  onEnterTerminal: () => void;
}

function TopBar({
  view,
  onNavigate,
  onBack,
  onAccount,
  accountLabel,
  settingsOpen,
  onSettingsToggle,
  onEnterTerminal,
}: TopBarProps) {
  const currentTrack = usePlayerSelector(getCurrentTrack);
  const likedIds = usePlayerSelector(selectLikedIds);
  const nativeMode = usePlayerSelector(selectNativeMode);
  const liked = currentTrack ? likedIds.includes(currentTrack.id) : false;

  return (
    <header className="top-bar" data-tauri-drag-region>
      <div className="top-bar__brand" data-tauri-drag-region>
        <span aria-hidden="true" className="brand-mark"><i /><i /><i /></span>
        <div>
          <strong>QQ Music GUI</strong>
          <span>VINYL GREENHOUSE</span>
        </div>
      </div>

      {view === "stage" ? (
        <nav aria-label="主要导航" className="top-bar__nav">
          <button onClick={() => onNavigate("discover")} type="button"><Icon name="library" size={17} />曲库</button>
          <button onClick={() => onNavigate("search")} type="button"><Icon name="search" size={17} />搜索</button>
          <button onClick={() => onNavigate("liked")} type="button"><Icon name="heart" size={17} />喜欢</button>
        </nav>
      ) : (
        <button className="back-button" onClick={onBack} type="button"><Icon name="back" size={18} />返回舞台</button>
      )}

      <div className="top-bar__actions">
        <BackendStatus />
        {view === "stage" && currentTrack && !nativeMode ? (
          <button
            aria-label={liked ? `取消喜欢《${currentTrack.title}》` : `喜欢《${currentTrack.title}》`}
            aria-pressed={liked}
            className={liked ? "icon-button top-bar__liked" : "icon-button icon-button--quiet"}
            onClick={() => playerActions.toggleLike(currentTrack.id)}
            type="button"
          >
            <Icon name="heart" size={18} />
          </button>
        ) : null}
        <button aria-label="账号" className="account-button" onClick={onAccount} type="button"><Icon name="user" size={17} /><span>{accountLabel}</span></button>
        <button
          aria-label="进入终端模式"
          className="account-button"
          data-tauri-drag-region="false"
          onClick={onEnterTerminal}
          type="button"
        >
          MINI
        </button>
        <button
          aria-expanded={settingsOpen}
          aria-controls="stage-settings"
          aria-label="更多"
          id="settings-trigger"
          className="icon-button icon-button--quiet"
          onClick={onSettingsToggle}
          type="button"
        ><Icon name="more" /></button>
        <span aria-orientation="vertical" className="top-bar__divider" role="separator" />
        <WindowControls />
      </div>
    </header>
  );
}

interface StageSettingsProps {
  onEnterRhine: () => void;
  fixtureStatus: FixtureStatus;
  onFixtureStatusChange: (status: FixtureStatus) => void;
  glowIntensity: GlowIntensityLevel;
  onGlowIntensityChange: (intensity: GlowIntensityLevel) => void;
  cachedGlow: boolean;
  onCachedGlowToggle: () => void;
  dynamicLyricsEnabled: boolean;
  onDynamicLyricsToggle: () => void;
  liveSpectrumEnabled: boolean;
  onLiveSpectrumToggle: () => Promise<void>;
  onDefaultQualityChange: (quality: PlaybackQuality) => Promise<void>;
  onClose: () => void;
}

function StageSettings({
  onEnterRhine,
  fixtureStatus,
  onFixtureStatusChange,
  glowIntensity,
  onGlowIntensityChange,
  cachedGlow,
  onCachedGlowToggle,
  dynamicLyricsEnabled,
  onDynamicLyricsToggle,
  liveSpectrumEnabled,
  onLiveSpectrumToggle,
  onDefaultQualityChange,
  onClose,
}: StageSettingsProps) {
  const nativeMode = usePlayerSelector(selectNativeMode);
  const defaultQuality = usePlayerSelector((snapshot) => snapshot.defaultQuality);
  const [qualitySaving, setQualitySaving] = useState(false);
  const [qualitySaveError, setQualitySaveError] = useState(false);
  const [liveSpectrumSaving, setLiveSpectrumSaving] = useState(false);
  const [liveSpectrumSaveError, setLiveSpectrumSaveError] = useState<string | null>(null);
  const menuRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRootRef.current?.querySelector<HTMLButtonElement>("button[aria-checked='true']")?.focus();
  }, []);

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRootRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    ).filter((item) => item.role === "menuitemradio" || item.role === "menuitemcheckbox" || item.role === "menuitem");
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    let nextIndex: number | null = null;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus();
    }
  }

  return (
    <section className="stage-settings" id="stage-settings" aria-label="设置"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header className="stage-song-list__header">
        <h2>设置</h2>
        <button className="stage-settings__close" type="button" onClick={onClose} aria-label="关闭设置">
          <Icon name="back" size={16} />返回
        </button>
      </header>
      <div className="fixture-menu__popover stage-settings__content" ref={menuRootRef} onKeyDown={onMenuKeyDown} role="menu" aria-label="播放设置">
        {!nativeMode ? (
          <>
            <span className="section-label" role="presentation">本地界面状态</span>
            {STATUS_OPTIONS.map((option) => (
              <button
                aria-checked={fixtureStatus === option.id}
                key={option.id}
                onClick={() => {
                  onFixtureStatusChange(option.id);
                  onClose();
                }}
                role="menuitemradio"
                type="button"
              >
                <span>{option.label}</span>
                <i aria-hidden="true" />
              </button>
            ))}
            <div className="fixture-menu__divider" role="separator" />
          </>
        ) : null}
        <span className="section-label" role="presentation">默认音质</span>
        {PLAYBACK_QUALITY_OPTIONS.map((option) => (
          <button
            aria-checked={defaultQuality === option.value}
            disabled={qualitySaving}
            key={option.value}
            onClick={() => {
              setQualitySaving(true);
              setQualitySaveError(false);
              void onDefaultQualityChange(option.value).catch(() => setQualitySaveError(true)).finally(() => setQualitySaving(false));
            }}
            role="menuitemradio"
            type="button"
          >
            <span>{option.label}</span>
            <i aria-hidden="true" />
          </button>
        ))}
        {qualitySaveError ? <span className="fixture-menu__error" role="status">默认音质保存失败</span> : null}
        <SmartShuffleToggle />
        <MvFallbackSetting />
        <RemoteControlSettings />
        <LoggingSettings />
        <UpdateSettings />
        <div className="fixture-menu__divider" role="separator" />
        <span className="section-label" role="presentation">封面氛围</span>
        <button type="button" role="menuitemcheckbox" aria-checked={cachedGlow}
          onClick={onCachedGlowToggle}>
          <span>轻量动态微光</span><i aria-hidden="true" />
        </button>
        {GLOW_OPTIONS.map((option) => (
          <button
            aria-checked={glowIntensity === option.id}
            key={option.id}
            onClick={() => onGlowIntensityChange(option.id)}
            role="menuitemradio"
            type="button"
          >
            <span>{option.label}</span>
            <i aria-hidden="true" />
          </button>
        ))}
        <div className="fixture-menu__divider" role="separator" />
        <span className="section-label" role="presentation">界面模式</span>
        <button type="button" role="menuitemradio" aria-checked={false} onClick={onEnterRhine}><span>莱茵界面</span><i aria-hidden="true" /></button>
        <div className="fixture-menu__divider" role="separator" />
        <span className="section-label" role="presentation">实验性功能</span>
        <button
          aria-checked={liveSpectrumEnabled}
          disabled={liveSpectrumSaving}
          onClick={() => {
            setLiveSpectrumSaving(true);
            setLiveSpectrumSaveError(null);
            void onLiveSpectrumToggle().catch(() => setLiveSpectrumSaveError("实时频谱设置保存失败")).finally(() => setLiveSpectrumSaving(false));
          }}
          role="menuitemcheckbox"
          type="button"
        >
          <span>实时频谱·实验</span>
          <i aria-hidden="true" />
        </button>
        {liveSpectrumSaveError ? (
          <span className="fixture-menu__error" role="status">{liveSpectrumSaveError}</span>
        ) : null}
        <button
          aria-checked={dynamicLyricsEnabled}
          onClick={onDynamicLyricsToggle}
          role="menuitemcheckbox"
          type="button"
        >
          <span>Windows 动态歌词</span>
          <i aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

interface NormalModeProps {
  onEnterRhine: () => void;
  accountLabel: string;
  setQueueOpen: Dispatch<SetStateAction<boolean>>;
  setAccountOpen: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<AppView>>;
  handleEnterTerminal: () => void;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  navigateToLibrary: (section: LibrarySection) => void;
  view: AppView;
  settingsOpen: boolean;
  fixtureStatus: FixtureStatus;
  setFixtureStatus: Dispatch<SetStateAction<FixtureStatus>>;
  glowIntensity: GlowIntensityLevel;
  cachedGlow: boolean;
  setCachedGlow: Dispatch<SetStateAction<boolean>>;
  handleGlowIntensityChange: (level: GlowIntensityLevel) => void;
  dynamicLyricsEnabled: boolean;
  handleDynamicLyricsToggle: () => void;
  liveSpectrumEnabled: boolean;
  handleLiveSpectrumToggle: () => Promise<void>;
  handleDefaultQualityChange: (quality: PlaybackQuality) => Promise<void>;
  closeSettings: () => void;
  windowRenderable: boolean;
  authRecovering: boolean;
  authSnapshot: AuthSnapshot;
  librarySection: LibrarySection;
  queueOpen: boolean;
  handlePublicStateAction: (status: Exclude<FixtureStatus, "normal" | "partial" | "loading">) => void;
  glowPaletteKey: string;
  spectrumPaletteKey: string;
}

/** Normal-mode presentation. App retains state across mode switches. */
export function NormalMode({
  onEnterRhine,
  accountLabel,
  setQueueOpen,
  setAccountOpen,
  setView,
  handleEnterTerminal,
  setSettingsOpen,
  navigateToLibrary,
  view,
  settingsOpen,
  fixtureStatus,
  setFixtureStatus,
  glowIntensity,
  cachedGlow,
  setCachedGlow,
  handleGlowIntensityChange,
  dynamicLyricsEnabled,
  handleDynamicLyricsToggle,
  liveSpectrumEnabled,
  handleLiveSpectrumToggle,
  handleDefaultQualityChange,
  closeSettings,
  windowRenderable,
  authRecovering,
  authSnapshot,
  librarySection,
  queueOpen,
  handlePublicStateAction,
  glowPaletteKey,
  spectrumPaletteKey
}: NormalModeProps) {
  const artistNavigation = useArtistNavigation();
  const blockingStatus = fixtureStatus === "normal" || fixtureStatus === "partial" ? null : fixtureStatus;
  return (
    <ArtistNavigationContext.Provider value={artist => { setQueueOpen(false); setSettingsOpen(false); artistNavigation.openArtist(artist); }}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      {cachedGlow && (
        <div className="app-shell__ambient" aria-hidden="true">
          <CachedGlow kind="field" paletteKey={glowPaletteKey} />
        </div>
      )}
      <TopBar
        accountLabel={accountLabel}
        onAccount={() => {
          setQueueOpen(false);
          setAccountOpen(true);
        }}
        onBack={() => { artistNavigation.closeArtist(false); setView("stage"); }}
        onEnterTerminal={handleEnterTerminal}
        onNavigate={(section) => { artistNavigation.closeArtist(false); setSettingsOpen(false); navigateToLibrary(section); }}
        view={view}
        settingsOpen={settingsOpen}
        onSettingsToggle={() => { artistNavigation.closeArtist(false); setView("stage"); setFixtureStatus("normal"); setSettingsOpen((open) => !open); }}
      />
      {fixtureStatus === "partial" ? <PublicState kind="partial" onAction={() => setFixtureStatus("normal")} /> : null}
      <div
        aria-hidden={blockingStatus ? "true" : undefined}
        className={blockingStatus ? "app-shell__content app-shell__content--obscured" : "app-shell__content"}
        inert={blockingStatus ? true : undefined}
      >
        <ArtistNavigationContent artist={artistNavigation.artist} onBack={artistNavigation.closeArtist}>
        {view === "stage" ? (
          <ListeningStage
            settings={settingsOpen ? <StageSettings
              onEnterRhine={onEnterRhine}
              fixtureStatus={fixtureStatus}
              glowIntensity={glowIntensity}
              cachedGlow={cachedGlow}
              onCachedGlowToggle={() => setCachedGlow((value) => !value)}
              onFixtureStatusChange={setFixtureStatus}
              onGlowIntensityChange={handleGlowIntensityChange}
              dynamicLyricsEnabled={dynamicLyricsEnabled}
              onDynamicLyricsToggle={handleDynamicLyricsToggle}
              liveSpectrumEnabled={liveSpectrumEnabled}
              onLiveSpectrumToggle={handleLiveSpectrumToggle}
              onDefaultQualityChange={handleDefaultQualityChange}
              onClose={closeSettings}
            /> : undefined}
            liveSpectrumEnabled={liveSpectrumEnabled}
            spectrumRenderable={windowRenderable && !artistNavigation.artist}
            spectrumPaletteKey={spectrumPaletteKey}
            cachedGlow={cachedGlow}
            glowPaletteKey={glowPaletteKey}
          />
        ) : (
          <Suspense fallback={<PublicState kind="loading" />}>
            <LibraryWorkspace
              authRecovering={authRecovering}
              authSnapshot={authSnapshot}
              initialSection={librarySection}
              onBack={() => setView("stage")}
            />
          </Suspense>
        )}
        </ArtistNavigationContent>
      </div>
      {blockingStatus ? (
        <PublicState
          focusOnMount
          kind={blockingStatus}
          onAction={blockingStatus === "loading" ? undefined : () => handlePublicStateAction(blockingStatus)}
        />
      ) : null}
      <PlayerBar onOpenQueue={() => setQueueOpen(true)} queueOpen={queueOpen} />
      <QueueDrawer onClose={() => setQueueOpen(false)} open={queueOpen} />
    </ArtistNavigationContext.Provider>
  );
}
