import type { ReactNode } from "react";

export type IconName =
  | "back"
  | "close"
  | "cassette-add"
  | "cassette-heart"
  | "down"
  | "heart"
  | "folder-music"
  | "history"
  | "library"
  | "maximize"
  | "minimize"
  | "more"
  | "mute"
  | "next"
  | "pause"
  | "play"
  | "play-next"
  | "previous"
  | "queue"
  | "repeat"
  | "restore"
  | "search"
  | "settings"
  | "statistics"
  | "shuffle"
  | "trash"
  | "up"
  | "user"
  | "volume";

interface IconProps {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 20 }: IconProps) {
  const paths: Record<IconName, ReactNode> = {
    back: <path d="m15 18-6-6 6-6M9 12h11" />,
    close: <path d="M6 6l12 12M18 6 6 18" />,
    "cassette-add": <><path d="M12 18H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M9 10h4M18 15v7M14.5 18.5h7" /><circle cx="7" cy="10" r="2" /><circle cx="15" cy="10" r="2" /></>,
    "cassette-heart": <><path d="M10 18H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5M9 10h4" /><circle cx="7" cy="10" r="2" /><circle cx="15" cy="10" r="2" /><path d="m17.5 21-4.1-4a2.6 2.6 0 0 1 3.7-3.7l.4.4.4-.4a2.6 2.6 0 0 1 3.7 3.7Z" fill="currentColor" strokeWidth="1.2" /></>,
    down: <path d="m8 10 4 4 4-4" />,
    heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />,
    "folder-music": <><path d="M21 18V8a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM11 15v-5l6-1v5M11 10l6-1" /><ellipse cx="9.5" cy="15.5" rx="1.5" ry="1" /><ellipse cx="15.5" cy="14.5" rx="1.5" ry="1" /></>,
    history: <path d="M3 3v6h6M3.6 8.5a9 9 0 1 1-.2 7M12 7v5l4 2.5" />,
    library: <path d="M4 4h4v16H4zM10 4h4v16h-4zM16.5 5.5l3-1 4.2 14.2-3 1z" />,
    maximize: <path d="M6 6h12v12H6z" />,
    minimize: <path d="M5 12h14" />,
    more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
    mute: <path d="M11 5 6 9H2v6h4l5 4V5ZM19 9l-6 6M13 9l6 6" />,
    next: <path d="m6 5 10 7L6 19V5ZM18 5v14" />,
    pause: <path d="M8 5v14M16 5v14" strokeWidth="3" />,
    play: <path d="m7 5 11 7-11 7V5Z" />,
    "play-next": <path d="M7 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 3-1.7l14 8a2 2 0 0 1 0 3.4l-2 1.1M12 13.5v8M8 17.5h8" />,
    previous: <path d="m18 5-10 7 10 7V5ZM6 5v14" />,
    queue: <path d="M4 6h11M4 11h11M4 16h7M19 14v6M16 17h6" />,
    repeat: <path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />,
    restore: <path d="M9 5h10v10M5 9h10v10H5z" />,
    search: <path d="m21 21-4.4-4.4M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />,
    settings: <><path d="m9.5 3-.6 2.3-1.5.9L5 5.6 2.5 10l1.8 1.7v1.6L2.5 15 5 19.4l2.4-.6 1.5.9.6 2.3h5l.6-2.3 1.5-.9 2.4.6 2.5-4.4-1.8-1.7v-1.6l1.8-1.7L19 5.6l-2.4.6-1.5-.9-.6-2.3Z" /><circle cx="12" cy="12.5" r="3.2" /></>,
    statistics: <path d="M5 20V12M12 20V4M19 20V8" strokeWidth="2.2" />,
    shuffle: <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />,
    trash: <path d="M4 7h16M9 11v6M15 11v6M6 7l1 14h10l1-14M9 7V4h6v3" />,
    up: <path d="m8 14 4-4 4 4" />,
    user: <path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" />,
    volume: <path d="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" />,
  };

  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        {paths[name]}
      </g>
    </svg>
  );
}
