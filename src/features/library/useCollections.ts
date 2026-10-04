import { useCallback, useEffect, useRef, useState } from "react";
import { getCollections, subscribeCollections, type Collections } from "../../backend/personalAdapter";
import { playbackSessionIdentity, subscribePlaybackConnection } from "../../backend/playbackTransport";

export function useCollections() {
  const [data, setData] = useState<Collections | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const identity = playbackSessionIdentity();
  const previousIdentity = useRef(identity);
  const refresh = useCallback(() => setRevision(r => r + 1), []);
  useEffect(() => subscribeCollections(refresh), [refresh]);
  useEffect(() => subscribePlaybackConnection(refresh), [refresh]);
  useEffect(() => {
    let alive = true;
    if (previousIdentity.current !== identity) { setData(null); previousIdentity.current = identity; }
    setError(false);
    void getCollections().then(value => {
      if (alive && identity === playbackSessionIdentity()) setData(value);
    }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [revision, identity]);
  return { data, error, refresh };
}
