import play from "../../assets/generated/playlist-actions/play-v1.png";
import queueAdd from "../../assets/generated/playlist-actions/queue-add-v1.png";
import playlistRemove from "../../assets/generated/playlist-actions/playlist-remove-v1.png";

const assets = { play, queueAdd, playlistRemove };

export function PlaylistActionIcon({ kind }: { kind: keyof typeof assets }) {
  const mask = `url("${assets[kind]}")`;
  return <span className="rhine-playlist-action-icon" aria-hidden="true"
    style={{ maskImage: mask, WebkitMaskImage: mask }} />;
}
