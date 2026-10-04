import { useCallback, useEffect, useRef } from "react";

import { setSpectrumStageActive } from "./spectrumStore";

export interface SpectrumBridgeProps {
  readonly active: boolean;
}

/**
 * Serializes the renderer's stage/visibility intent into the bounded native
 * spectrum lifecycle. It renders nothing and never subscribes to frame data.
 */
export function SpectrumBridge({ active }: SpectrumBridgeProps) {
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback((next: boolean) => {
    const synchronize = () => setSpectrumStageActive(next);
    const pending = commandQueueRef.current.then(synchronize, synchronize);
    commandQueueRef.current = pending.catch(() => undefined);
  }, []);

  useEffect(() => {
    enqueue(active);
  }, [active, enqueue]);

  useEffect(() => {
    return () => {
      enqueue(false);
    };
  }, [enqueue]);

  return null;
}
