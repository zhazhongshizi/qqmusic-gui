const smooth = (x: number) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

/** Entry sequencing is independent of track changes and playback pause. */
export class PlaybackEntry {
  phase: "inactive" | "inserting" | "rising" | "playing" = "inactive";
  shape = 1;
  rise = 0;
  waveTime = 0;
  waveStarted = false;
  private elapsed = 0;
  start() { this.phase = "inserting"; this.rise = 0; this.waveTime = 0; this.waveStarted = false; this.elapsed = 0; }
  stop() { this.phase = "inactive"; }
  update(dt: number, seated: boolean, playing: boolean, reduced: boolean, nearLanding = false) {
    if (this.phase === "inactive") {
      this.shape += (1 - this.shape) * (1 - Math.exp(-dt * 6));
      return;
    }
    if (reduced) { this.phase = "playing"; this.shape = 1; this.rise = 1; return; }
    if (this.phase === "inserting") {
      this.shape *= Math.exp(-dt * 10);
      if (this.shape < .002 && seated) {
        this.shape = 0;
        this.phase = "rising";
        this.elapsed = 0;
      }
    } else if (this.phase === "rising") {
      this.elapsed += dt;
      // Rise through the existing ripple without a hold or a phase reset.
      this.shape = this.rise = smooth(this.elapsed / .7);
      if (this.elapsed >= .7) this.phase = "playing";
    }
    if (playing && (nearLanding || this.phase !== "inserting")) this.waveStarted = true;
    if (playing && this.waveStarted) this.waveTime += dt;
  }
}

/** A smooth wavefront reaches distant slots later; nothing moves ahead of it. */
export function playbackRipple(distance: number, time: number, reducedMix = 0) {
  const age = time - distance / (4.5 / 1.7);
  if (age <= 0) return 0;
  const attenuation = (1 - Math.exp(-distance * .9)) * Math.exp(-distance * .16);
  const ripple = attenuation * Math.sin(-age * 4.5) * .42 * smooth(age / .12)
    * (1 + .55 * Math.exp(-age * 1.8))
    * (1 + .6 * (1 - smooth((age - .7) / .7)));
  const envelope = (1 - smooth((age - 1.4) / 1.4)) * (1 - smooth((time - 5) / 2));
  // After the short ripple, retain a quiet five-second wave rather than going still.
  const gentle = attenuation * .035 * Math.sin(-age * 1.2) * smooth(age / .45);
  return ripple * (1 - reducedMix + reducedMix * envelope) + gentle * reducedMix * (1 - envelope);
}
