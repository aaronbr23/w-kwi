import type { DiagramPart, SimContext } from '../sim/types.ts';

export const pin = (spec: DiagramPart, name: string) => `${spec.id}:${name}`;

export function attr(spec: DiagramPart, name: string, def: string): string {
  return spec.attrs?.[name] ?? def;
}

export function num(spec: DiagramPart, name: string, def: number): number {
  const v = parseFloat(spec.attrs?.[name] ?? '');
  return Number.isFinite(v) ? v : def;
}

/** Tracks the fraction of time a signal was on between frames (for PWM-dimmed LEDs). */
export class Duty {
  private on = false; private since = 0; private acc = 0; private last = 0;
  set(on: boolean, now: number) {
    if (on === this.on) return;
    if (this.on) this.acc += now - this.since;
    this.on = on; this.since = now;
  }
  take(now: number): number {
    if (this.on) this.acc += now - this.since;
    this.since = now;
    const span = now - this.last, r = span > 0 ? this.acc / span : this.on ? 1 : 0;
    this.acc = 0; this.last = now;
    return Math.min(1, r);
  }
}

/** Drive a sequence of [level|null, durationNs] steps on a pin, then call done. */
export function waveform(ctx: SimContext, endpoint: string, steps: [number | null, number][], vcc: number, done?: () => void) {
  let i = 0;
  const next = () => {
    if (i >= steps.length) { ctx.net.drive(endpoint, { v: vcc, strong: false }); done?.(); return; }
    const [lv, ns] = steps[i++];
    ctx.net.drive(endpoint, lv === null ? { v: vcc, strong: false } : { v: lv ? vcc : 0, strong: true });
    ctx.schedule(next, ns);
  };
  next();
}

export const bcd = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;
export const unbcd = (b: number) => (b >> 4) * 10 + (b & 0xf);
