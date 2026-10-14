import { useEffect, useSyncExternalStore } from "react";
import { hasPlaybackTransport, playbackSessionIdentity, playbackConnectionRevision, subscribePlaybackConnection } from "../../backend/playbackTransport";
import type { AuthSnapshot } from "../../contracts/auth";
import { playerActions } from "./playerStore";

export function useAccountLikes(auth: AuthSnapshot, recovering: boolean) {
  const connection = useSyncExternalStore(subscribePlaybackConnection, playbackConnectionRevision);
  const account = auth.state === "authenticated" ? auth.account?.musicId ?? "authenticated" : auth.state;
  const identity = playbackSessionIdentity();
  useEffect(() => {
    if (!hasPlaybackTransport()) return;
    if (recovering || auth.state !== "authenticated") { playerActions.clearAccountLikes(); return; }
    void playerActions.syncAccountLikes();
    return () => playerActions.clearAccountLikes();
  }, [account, recovering, identity, connection]);
}
