import type { TerminalUpNext } from "./nextTrackPreview";

export interface TerminalUpNextRunwayProps {
  model: TerminalUpNext;
}

function runwayHeading(model: TerminalUpNext) {
  if (model.status === "repeat-current") return "REPEAT CURRENT //";
  return "UP NEXT //";
}

function runwayMeta(model: TerminalUpNext) {
  if (model.status === "shuffle-pending") return "SHUFFLE MODE";
  if (model.status === "end-of-queue") return "QUEUE COMPLETE";
  return `${String(model.items.length).padStart(2, "0")} ${model.items.length === 1 ? "TRACK" : "TRACKS"}`;
}

function runwayStatus(model: TerminalUpNext) {
  if (model.status === "shuffle-pending") return "SHUFFLE PENDING";
  if (model.status === "end-of-queue") return "END OF QUEUE";
  if (model.items.length === 0) return "NO UPCOMING TRACKS";
  return null;
}

export function TerminalUpNextRunway({ model }: TerminalUpNextRunwayProps) {
  const status = runwayStatus(model);
  const className = status ? "terminal-up-next terminal-up-next--status" : "terminal-up-next";

  return (
    <section aria-label="后续播放" className={className} data-testid="terminal-up-next">
      <div className="terminal-up-next__heading">
        <span>{runwayHeading(model)}</span>
        <small>{runwayMeta(model)}</small>
      </div>

      {status ? (
        <p className="terminal-up-next__status">{status}</p>
      ) : (
        <ol className="terminal-up-next__list">
          {model.items.map((item) => (
            <li
              className={item.isFirst ? "terminal-up-next__item terminal-up-next__item--lead" : "terminal-up-next__item"}
              key={`${item.queueNumber}-${item.trackId}`}
            >
              <span>{item.queueNumber}</span>
              <strong title={item.title}>{item.title}</strong>
              <small title={item.artist}>{item.artist}</small>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
