/** Count completed Program draw ticks, including a record of pauses that a
 * one-second FPS reading can hide. This does not measure camera or network FPS. */
export class ProgramFrameTiming {
  fps = 0;
  pauses = 0;
  longestPauseMs = 0;
  lastPauseAt: number | null = null;
  private previous: number | null = null;
  private sampledAt = 0;
  private frames = 0;

  record(now: number) {
    if (this.previous === null) {
      this.previous = this.sampledAt = now;
      return false;
    }
    const gap = now - this.previous;
    this.previous = now;
    if (gap >= 100) {
      this.pauses++;
      this.longestPauseMs = Math.max(this.longestPauseMs, Math.round(gap));
      this.lastPauseAt = Date.now();
    }
    this.frames++;
    const elapsed = now - this.sampledAt;
    if (elapsed < 1000) return false;
    this.fps = Math.round(1000 * this.frames / elapsed);
    this.frames = 0;
    this.sampledAt = now;
    return true;
  }
}
