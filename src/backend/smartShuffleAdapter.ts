export interface SmartShuffleStatus {
  enabled: boolean;
  likesLoaded: boolean;
}

async function request(command: string, payload?: { enabled: boolean }): Promise<SmartShuffleStatus> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const value = await invoke<unknown>(command, payload);
    if (!value || typeof value !== "object" || !("enabled" in value) || !("likesLoaded" in value)
      || typeof value.enabled !== "boolean" || typeof value.likesLoaded !== "boolean") {
      throw new Error("invalid response");
    }
    return { enabled: value.enabled, likesLoaded: value.likesLoaded };
  } catch {
    throw new Error("智能随机设置暂时不可用");
  }
}

export const getSmartShuffleStatus = () => request("smart_shuffle_status");
export const setSmartShuffleEnabled = (enabled: boolean) => request("smart_shuffle_set_enabled", { enabled });
