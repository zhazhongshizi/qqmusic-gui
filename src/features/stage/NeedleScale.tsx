import type { CSSProperties } from "react";

interface NeedleScaleProps {
  progress: number;
}

const TICKS = Array.from({ length: 19 }, (_, index) => ({
  id: `tick-${index}`,
  major: index % 3 === 0,
}));

export function NeedleScale({ progress }: NeedleScaleProps) {
  const boundedProgress = Math.max(0, Math.min(progress, 1));

  return (
    <div
      aria-label={`唱针刻度，当前进度 ${Math.round(boundedProgress * 100)}%`}
      className="needle-scale"
      role="img"
      style={{ "--needle-progress": boundedProgress } as CSSProperties}
    >
      <span aria-hidden="true" className="needle-scale__rail" />
      <div aria-hidden="true" className="needle-scale__ticks">
        {TICKS.map((tick) => (
          <span
            className={tick.major ? "needle-scale__tick needle-scale__tick--major" : "needle-scale__tick"}
            key={tick.id}
          />
        ))}
      </div>
      <span aria-hidden="true" className="needle-scale__marker">
        <span className="needle-scale__point" />
        <span className="needle-scale__arm" />
      </span>
      <span className="needle-scale__label">唱针刻度</span>
    </div>
  );
}
