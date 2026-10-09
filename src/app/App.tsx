import { UpdateNotice } from "../features/player/UpdateSettings";
import {
  lazy, Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { authRecover } from "../backend/authAdapter";
import {
  nativeSetLiveSpectrumEnabled,
  nativeSettingsSnapshot,
} from "../backend/settingsAdapter";
import type { PlaybackQuality } from "../contracts/settings";
import { setSmtcDynamicLyricsEnabled } from "../backend/smtcDynamicLyricsAdapter";
import {
  listenWindowRenderable,
  windowEnterMiniMode,
  windowRestoreNormal,
  type WindowSnapshot,
} from "../backend/windowAdapter";
import type { AuthSnapshot } from "../contracts/auth";
import { LoginDialog } from "../features/auth/LoginDialog";
import { NativePlayerBridge } from "../features/player/NativePlayerBridge";
import { SpectrumBridge } from "../features/spectrum/SpectrumBridge";
import {
  getCurrentTrack,
  playerActions,
  usePlayerSelector,
  type PlayerSnapshot,
} from "../features/player/playerStore";
import {
  useCoverPalette,
  type GlowIntensityLevel,
} from "../features/stage/coverPalette";
import type { FixtureStatus } from "../features/status/PublicState";
import { TerminalMiniMode } from "../features/terminal/TerminalMiniMode";
import { ModeLoadBoundary } from "./ModeLoadBoundary";
import { NormalMode } from "./NormalMode";
import type { AppView, LibrarySection, UiMode } from "./uiModes";
import "../styles/app.css";

const RhineMode = lazy(() => import("../features/rhine/RhineMode"));

export const UI_MODE_STORAGE_KEY = "qqmusic_ui_mode";

function readUiMode(): UiMode {
  try {
    const saved = window.localStorage.getItem(UI_MODE_STORAGE_KEY);
    return saved === "terminal" || saved === "rhine" ? saved : "normal";
  } catch {
    return "normal";
  }
}

function waitForViewportPaint(): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

export const WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY = "qqmusic_windows_dynamic_lyrics" as const;
const WINDOWS_DYNAMIC_LYRICS_STORAGE_VALUE = "enabled" as const;

const selectNativeMode = (snapshot: PlayerSnapshot) => snapshot.nativeMode;
const selectIsPlaying = (snapshot: PlayerSnapshot) => snapshot.isPlaying;

function readDynamicLyricsPreference(): boolean {
  try {
    return typeof window !== "undefined" &&
      window.localStorage.getItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY) === WINDOWS_DYNAMIC_LYRICS_STORAGE_VALUE;
  } catch {
    return false;
  }
}

function persistDynamicLyricsPreference(enabled: boolean): void {
  try {
    if (typeof window === "undefined") return;
    if (enabled) {
      window.localStorage.setItem(
        WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY,
        WINDOWS_DYNAMIC_LYRICS_STORAGE_VALUE,
      );
    } else {
      window.localStorage.removeItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY);
    }
  } catch {
    // Storage errors must not affect the confirmed native state.
  }
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = () => {
    setSettingsOpen(false);
    document.getElementById("settings-trigger")?.focus();
  };
  const [cachedGlow, setCachedGlow] = useState(true);
  const [view, setView] = useState<AppView>("stage");
  const [librarySection, setLibrarySection] = useState<LibrarySection>("discover");
  const [queueOpen, setQueueOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [authSnapshot, setAuthSnapshot] = useState<AuthSnapshot>({ state: "signedOut" });
  const [authRecovering, setAuthRecovering] = useState(true);
  const [uiMode, setUiMode] = useState<UiMode>(readUiMode);
  const [fixtureStatus, setFixtureStatus] = useState<FixtureStatus>("normal");
  const [dynamicLyricsEnabled, setDynamicLyricsEnabled] = useState(false);
  const [liveSpectrumEnabled, setLiveSpectrumEnabled] = useState(false);
  const [windowRenderable, setWindowRenderable] = useState(() => (
    typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)
      ? typeof document === "undefined" || document.visibilityState === "visible"
      : false
  ));
  const miniWindowSnapshotRef = useRef<WindowSnapshot | null>(null);
  const initialUiModeRef = useRef(uiMode);
  const uiModeStartupAppliedRef = useRef(false);
  const uiModeIntentRef = useRef<UiMode>(uiMode === "terminal" ? "normal" : uiMode);
  const windowTransitionRef = useRef<Promise<void>>(Promise.resolve());
  const dynamicLyricsRequestEpochRef = useRef(0);
  const dynamicLyricsCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const dynamicLyricsIntentRef = useRef(false);
  const dynamicLyricsConfirmedRef = useRef(false);
  const dynamicLyricsMountedRef = useRef(true);
  const dynamicLyricsStartupSyncRef = useRef(false);
  const liveSpectrumRequestEpochRef = useRef(0);
  const liveSpectrumIntentRef = useRef(false);
  const liveSpectrumConfirmedRef = useRef(false);
  const liveSpectrumMountedRef = useRef(true);
  const [glowIntensity, setGlowIntensity] = useState<GlowIntensityLevel>(() => {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem("qqmusic_glow_intensity");
      if (stored === "off" || stored === "subtle" || stored === "standard" || stored === "enhanced") {
        return stored;
      }
    }
    return "standard";
  });

  const currentTrack = usePlayerSelector(getCurrentTrack);
  const isPlaying = usePlayerSelector(selectIsPlaying);
  const nativeMode = usePlayerSelector(selectNativeMode);
  const { palette, style: coverPaletteStyle } = useCoverPalette(currentTrack, glowIntensity);
  const coverTone = uiMode === "normal" && view === "stage" && currentTrack
    ? palette.tone
    : "dark";

  const enqueueWindowTransition = useCallback((transition: () => Promise<void>) => {
    const next = windowTransitionRef.current.then(transition, transition);
    windowTransitionRef.current = next.catch(() => undefined);
  }, []);

  const handleEnterTerminal = useCallback(() => {
    if (uiModeIntentRef.current === "terminal") return;
    uiModeIntentRef.current = "terminal";
    enqueueWindowTransition(async () => {
      const transition = await windowEnterMiniMode();
      if (transition.snapshot && miniWindowSnapshotRef.current === null) {
        miniWindowSnapshotRef.current = transition.snapshot;
      }
      if (uiModeIntentRef.current === "terminal") {
        setUiMode("terminal");
      }
    });
  }, [enqueueWindowTransition]);

  const handleExitTerminal = useCallback(() => {
    if (uiModeIntentRef.current === "normal" && uiMode === "normal") return;
    uiModeIntentRef.current = "normal";
    enqueueWindowTransition(async () => {
      const snapshot = miniWindowSnapshotRef.current;
      miniWindowSnapshotRef.current = null;
      try {
        await windowRestoreNormal(snapshot);
      } finally {
        await waitForViewportPaint();
        if (uiModeIntentRef.current === "normal") {
          setUiMode("normal");
        }
      }
    });
  }, [enqueueWindowTransition, uiMode]);

  const handleEnterRhine = () => {
    uiModeIntentRef.current = "rhine";
    setQueueOpen(false); setSettingsOpen(false); setUiMode("rhine");
  };

  useEffect(() => {
    if (uiModeStartupAppliedRef.current) return;
    uiModeStartupAppliedRef.current = true;
    if (initialUiModeRef.current === "terminal") handleEnterTerminal();
  }, [handleEnterTerminal]);

  useEffect(() => {
    try {
      window.localStorage.setItem(UI_MODE_STORAGE_KEY, uiMode);
    } catch {
      // Preference storage must not prevent playback or mode switching.
    }
  }, [uiMode]);

  function handleGlowIntensityChange(nextLevel: GlowIntensityLevel) {
    setGlowIntensity(nextLevel);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("qqmusic_glow_intensity", nextLevel);
      }
    } catch {
      // Storage error ignored
    }
  }

  const requestDynamicLyricsState = useCallback((enabled: boolean) => {
    dynamicLyricsIntentRef.current = enabled;
    const requestEpoch = ++dynamicLyricsRequestEpochRef.current;
    const synchronize = async () => {
      if (!dynamicLyricsMountedRef.current) return;
      try {
        const result = await setSmtcDynamicLyricsEnabled(enabled);
        if (
          !dynamicLyricsMountedRef.current ||
          requestEpoch !== dynamicLyricsRequestEpochRef.current
        ) return;
        dynamicLyricsIntentRef.current = result.enabled;
        dynamicLyricsConfirmedRef.current = result.enabled;
        setDynamicLyricsEnabled(result.enabled);
        persistDynamicLyricsPreference(result.enabled);
      } catch {
        if (
          !dynamicLyricsMountedRef.current ||
          requestEpoch !== dynamicLyricsRequestEpochRef.current
        ) return;
        dynamicLyricsIntentRef.current = dynamicLyricsConfirmedRef.current;
        // Keep the last confirmed state. The first failed sync therefore stays off
        // and does not create an enabled preference.
      }
    };
    const next = dynamicLyricsCommandQueueRef.current.then(synchronize, synchronize);
    dynamicLyricsCommandQueueRef.current = next.catch(() => undefined);
  }, []);

  const handleDynamicLyricsToggle = useCallback(() => {
    requestDynamicLyricsState(!dynamicLyricsIntentRef.current);
  }, [requestDynamicLyricsState]);

  const requestLiveSpectrumState = useCallback(async (enabled: boolean): Promise<void> => {
    liveSpectrumIntentRef.current = enabled;
    const requestEpoch = ++liveSpectrumRequestEpochRef.current;
    try {
      const result = await nativeSetLiveSpectrumEnabled(enabled);
      if (
        !liveSpectrumMountedRef.current ||
        requestEpoch !== liveSpectrumRequestEpochRef.current
      ) return;
      liveSpectrumIntentRef.current = result.liveSpectrumEnabled;
      liveSpectrumConfirmedRef.current = result.liveSpectrumEnabled;
      setLiveSpectrumEnabled(result.liveSpectrumEnabled);
    } catch (error) {
      if (
        liveSpectrumMountedRef.current &&
        requestEpoch === liveSpectrumRequestEpochRef.current
      ) {
        liveSpectrumIntentRef.current = liveSpectrumConfirmedRef.current;
      }
      throw error;
    }
  }, []);

  const handleLiveSpectrumToggle = useCallback(() => {
    return requestLiveSpectrumState(!liveSpectrumIntentRef.current);
  }, [requestLiveSpectrumState]);

  const handleDefaultQualityChange = useCallback(
    (quality: PlaybackQuality) => playerActions.setDefaultQuality(quality),
    [],
  );

  useEffect(() => {
    void playerActions.hydrateDefaultQuality().catch(() => undefined);
  }, []);

  useEffect(() => {
    dynamicLyricsMountedRef.current = true;
    if (!dynamicLyricsStartupSyncRef.current) {
      dynamicLyricsStartupSyncRef.current = true;
      requestDynamicLyricsState(readDynamicLyricsPreference());
    }
    return () => {
      dynamicLyricsMountedRef.current = false;
    };
  }, [requestDynamicLyricsState]);

  useEffect(() => {
    liveSpectrumMountedRef.current = true;
    let current = true;
    const requestEpochAtStart = liveSpectrumRequestEpochRef.current;
    void nativeSettingsSnapshot().then(
      (settings) => {
        if (
          !current ||
          !liveSpectrumMountedRef.current ||
          requestEpochAtStart !== liveSpectrumRequestEpochRef.current
        ) return;
        liveSpectrumIntentRef.current = settings.liveSpectrumEnabled;
        liveSpectrumConfirmedRef.current = settings.liveSpectrumEnabled;
        setLiveSpectrumEnabled(settings.liveSpectrumEnabled);
      },
      () => undefined,
    );
    return () => {
      current = false;
      liveSpectrumMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void authRecover().then(
      (snapshot) => {
        if (mounted) {
          setAuthSnapshot(snapshot);
          setAuthRecovering(false);
        }
      },
      () => {
        if (mounted) {
          setAuthSnapshot({ state: "unavailable" });
          setAuthRecovering(false);
        }
      },
    );
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: () => void = () => undefined;
    void listenWindowRenderable((renderable) => {
      if (!disposed) setWindowRenderable(renderable);
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  useEffect(() => {
    if (uiMode !== "normal") return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setQueueOpen(false);
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (
          target.isContentEditable ||
          Boolean(target.closest("button, input, textarea, select, a[href], [role='button'], [role='menuitem']"))
        )
      ) return;

      if (event.key === " ") {
        event.preventDefault();
        playerActions.toggle();
      } else if (event.key === "ArrowLeft") {
        playerActions.seekBy(-5_000);
      } else if (event.key === "ArrowRight") {
        playerActions.seekBy(5_000);
      } else if (event.key.toLowerCase() === "q") {
        setQueueOpen((open) => !open);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [uiMode]);

  function navigateToLibrary(section: LibrarySection) {
    setLibrarySection(section);
    setView("library");
  }


  function handlePublicStateAction(status: Exclude<FixtureStatus, "normal" | "partial" | "loading">) {
    setFixtureStatus("normal");
    if (status === "empty") navigateToLibrary("search");
  }

  const accountLabel = authSnapshot.state === "authenticated"
    ? authSnapshot.account?.musicId ?? "已登录"
    : authSnapshot.state === "unavailable"
      ? "账号不可用"
      : "未登录";
  const spectrumStageActive = liveSpectrumEnabled &&
    windowRenderable &&
    uiMode === "normal" &&
    view === "stage" &&
    currentTrack !== null &&
    nativeMode &&
    fixtureStatus === "normal" &&
    !accountOpen;

  return (
    <>
    <NativePlayerBridge />
    <SpectrumBridge active={spectrumStageActive} />
    <UpdateNotice />
    <div
      aria-hidden={accountOpen ? "true" : undefined}
      className={uiMode === "terminal" ? "app-shell app-shell--terminal" : uiMode === "rhine" ? "app-shell app-shell--rhine" : "app-shell app-shell--normal"}
      data-cover-tone={coverTone}
      data-glow-intensity={glowIntensity}
      data-glow-renderer={cachedGlow ? "cached" : "original"}
      data-glow-motion={uiMode === "normal" && isPlaying && windowRenderable ? "playing" : "still"}
      inert={accountOpen ? true : undefined}
      style={coverPaletteStyle}
    >
      {uiMode === "terminal" ? (
        <TerminalMiniMode onExit={handleExitTerminal} />
      ) : uiMode === "rhine" ? (
        <ModeLoadBoundary onExit={handleExitTerminal}><Suspense fallback={<div role="status">正在载入莱茵界面…<button onClick={handleExitTerminal}>返回主界面</button></div>}>
          <RhineMode auth={authSnapshot} authRecovering={authRecovering} active={windowRenderable && !accountOpen} onExit={handleExitTerminal} onAccount={() => setAccountOpen(true)} />
        </Suspense></ModeLoadBoundary>
      ) : (
        <NormalMode
          onEnterRhine={handleEnterRhine}
          accountLabel={accountLabel}
          setQueueOpen={setQueueOpen}
          setAccountOpen={setAccountOpen}
          setView={setView}
          handleEnterTerminal={handleEnterTerminal}
          setSettingsOpen={setSettingsOpen}
          navigateToLibrary={navigateToLibrary}
          view={view}
          settingsOpen={settingsOpen}
          fixtureStatus={fixtureStatus}
          setFixtureStatus={setFixtureStatus}
          glowIntensity={glowIntensity}
          cachedGlow={cachedGlow}
          setCachedGlow={setCachedGlow}
          handleGlowIntensityChange={handleGlowIntensityChange}
          dynamicLyricsEnabled={dynamicLyricsEnabled}
          handleDynamicLyricsToggle={handleDynamicLyricsToggle}
          liveSpectrumEnabled={liveSpectrumEnabled}
          handleLiveSpectrumToggle={handleLiveSpectrumToggle}
          handleDefaultQualityChange={handleDefaultQualityChange}
          closeSettings={closeSettings}
          windowRenderable={windowRenderable}
          authRecovering={authRecovering}
          authSnapshot={authSnapshot}
          librarySection={librarySection}
          queueOpen={queueOpen}
          handlePublicStateAction={handlePublicStateAction}
          glowPaletteKey={JSON.stringify(coverPaletteStyle)}
          spectrumPaletteKey={`${palette.primary}:${palette.surface.onSurface}`}
        />
      )}
    </div>
    {accountOpen ? (
      <LoginDialog
        auth={authSnapshot}
        onAuthChange={setAuthSnapshot}
        onClose={() => setAccountOpen(false)}
      />
    ) : null}
    </>
  );
}
