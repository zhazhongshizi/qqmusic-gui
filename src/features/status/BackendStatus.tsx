import { useEffect, useState } from "react";

import {
  APP_SNAPSHOT_ERROR_CODES,
  loadAppSnapshot,
  type AppSnapshotLoadResult,
} from "../../backend/appSnapshotAdapter";

interface BackendStatusProps {
  loadSnapshot?: () => Promise<AppSnapshotLoadResult>;
}

type BackendBootstrapState =
  | { readonly status: "loading" }
  | { readonly status: "settled"; readonly result: AppSnapshotLoadResult };

const INITIAL_STATE: BackendBootstrapState = { status: "loading" };
let defaultSnapshotPromise: Promise<AppSnapshotLoadResult> | null = null;

function loadDefaultSnapshot() {
  defaultSnapshotPromise ??= loadAppSnapshot();
  return defaultSnapshotPromise;
}

function publicPresentation(state: BackendBootstrapState) {
  if (state.status === "loading") {
    return {
      kind: "loading",
      label: "核心连接中",
      description: "正在读取本地核心公开状态",
      role: "status" as const,
    };
  }

  if (!state.result.ok) {
    return {
      kind: "error",
      label: state.result.code,
      description: `本地核心状态不可用，诊断编号 ${state.result.code}`,
      role: "alert" as const,
    };
  }

  if (state.result.source === "browserFixture") {
    return {
      kind: "fixture",
      label: "浏览器预览",
      description: "浏览器预览正在使用本地安全 fixture，未连接 Tauri 核心",
      role: "status" as const,
    };
  }

  const providerState = state.result.snapshot.provider.state;
  return {
    kind: providerState === "failed" ? "error" : "ready",
    label: `核心 ${state.result.snapshot.appVersion}`,
    description: providerState === "ready"
      ? `本地核心已连接，应用版本 ${state.result.snapshot.appVersion}，Provider 已就绪`
      : providerState === "failed"
        ? `本地核心已连接，但 Provider 启动失败，应用版本 ${state.result.snapshot.appVersion}`
        : `本地核心已连接，应用版本 ${state.result.snapshot.appVersion}，Provider ${providerState}`,
    role: "status" as const,
  };
}

export function BackendStatus({ loadSnapshot = loadDefaultSnapshot }: BackendStatusProps) {
  const [state, setState] = useState<BackendBootstrapState>(INITIAL_STATE);

  useEffect(() => {
    let active = true;

    void loadSnapshot()
      .then((result) => {
        if (active) setState({ status: "settled", result });
      })
      .catch(() => {
        if (active) {
          setState({
            status: "settled",
            result: { ok: false, code: APP_SNAPSHOT_ERROR_CODES.unavailable },
          });
        }
      });

    return () => {
      active = false;
    };
  }, [loadSnapshot]);

  const presentation = publicPresentation(state);

  return (
    <span
      aria-busy={state.status === "loading" ? "true" : undefined}
      aria-label={presentation.description}
      aria-live={presentation.role === "status" ? "polite" : undefined}
      className={`backend-status backend-status--${presentation.kind}`}
      role={presentation.role}
      title={presentation.description}
    >
      <i aria-hidden="true" />
      <span>{presentation.label}</span>
    </span>
  );
}
