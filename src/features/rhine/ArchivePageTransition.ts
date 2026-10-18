import { createContext } from "react";

/** Shared by the main, local and history canvases. */
export type ArchivePageTransition = {
  id: number;
  phase: "leaving" | "entering";
  onExited: () => void;
  onEntered: () => void;
};
export const ArchivePageTransitionContext = createContext<ArchivePageTransition | null>(null);
