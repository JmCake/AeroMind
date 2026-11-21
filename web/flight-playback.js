// Presentation only. The spectator plays a short history of completed physics
// ticks. A delayed vision response can slow playback, but cannot invent a pose.
const lerp = (a, b, t) => a + (b - a) * t;
const angle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

export class FlightPlayback {
  constructor(bodies, time) {
    this.time = time;
    this.frames = [];
    this.record(bodies, time);
  }

  record(bodies, time) {
    const poses = bodies.map(({pos, vel, yaw, pitch, look, airborne, cargo}) => ({
      pos: [...pos], vel: [...vel], yaw, pitch, look, airborne, cargo
    }));
    this.frames.push({time, poses});
    if (this.frames.length > 32) this.frames.shift();
  }

  sample(elapsed, speed, paused) {
    this.time = Math.max(this.time, this.frames[0].time);
    const latest = this.frames.at(-1).time;
    if (!paused) {
      // Keep roughly 100 ms of real flight in reserve at any rehearsal speed.
      // Ease toward the last known pose when the next measurement takes longer.
      const remaining = latest - this.time;
      const seconds = Math.max(0, elapsed);
      this.time += Math.min(speed * 1.15 * seconds, remaining * -Math.expm1(-seconds / .10));
      if (latest - this.time < 1e-6) this.time = latest;
    }
    while (this.frames.length > 1 && this.frames[1].time <= this.time) this.frames.shift();
    const [before, after] = this.frames;
    if (!after) return before.poses;
    const t = (this.time - before.time) / (after.time - before.time);
    return before.poses.map((a, i) => {
      const b = after.poses[i];
      return {pos: a.pos.map((x, j) => lerp(x, b.pos[j], t)), vel: a.vel.map((x, j) => lerp(x, b.vel[j], t)),
        yaw: angle(a.yaw, b.yaw, t), pitch: lerp(a.pitch, b.pitch, t), look: angle(a.look, b.look, t),
        airborne: a.airborne, cargo: a.cargo};
    });
  }
}
