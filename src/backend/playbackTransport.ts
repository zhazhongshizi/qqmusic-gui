/** One typed adapter surface, with desktop IPC as the default transport. */
export type PlaybackTransport = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
let remoteTransport: PlaybackTransport | null = null;
let revision = 0;
let sessionIdentity = 0;
export const playbackSessionIdentity = () => sessionIdentity;
export function beginPlaybackSession() { sessionIdentity++; }
const listeners = new Set<() => void>();
export function installPlaybackTransport(transport: PlaybackTransport | null) { remoteTransport = transport; }
export function hasPlaybackTransport() {
  return remoteTransport !== null || (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);
}
export function notifyPlaybackReconnected() { revision++; listeners.forEach((listener) => listener()); }
export const playbackConnectionRevision = () => revision;
export function subscribePlaybackConnection(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export async function invokePlayback(command: string, payload?: Record<string, unknown>): Promise<unknown> {
  if (remoteTransport) return remoteTransport(command, payload);
  if (!hasPlaybackTransport()) throw new Error("Playback transport unavailable");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, payload);
}
