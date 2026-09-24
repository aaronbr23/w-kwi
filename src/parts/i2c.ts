// I2C peripherals with register maps implemented from datasheets.
import type { PartFactory, I2CDevice } from '../sim/types.ts';
import { attr, num, bcd, unbcd } from './util.ts';

/** Register-file I2C device: first written byte selects the register, auto-increment. */
function registers(address: number, size: number, read: (r: number) => number, write: (r: number, v: number) => void): I2CDevice {
  let ptr = 0, first = true;
  return {
    address,
    connect(w) { if (w) first = true; return true; },
    write(b) { if (first) { ptr = b % size; first = false; } else { write(ptr, b); ptr = (ptr + 1) % size; } return true; },
    read() { const v = read(ptr); ptr = (ptr + 1) % size; return v & 0xff; },
    stop() {},
  };
}

/** DS1307 real-time clock. Time = initial wall clock (or attr "initTime") + simulated time. */
export const ds1307: PartFactory = (ctx, spec) => {
  const ram = new Uint8Array(64);
  const init = attr(spec, 'initTime', 'now');
  let baseMs = init === 'now' ? Date.now() : Date.parse(init), baseSim = ctx.nowNs();
  let halted = false;
  // Day-of-week is a free-running register on real DS1307 hardware, not derived from the date -
  // the host sets it explicitly and it must read back whatever was last written.
  let dow = new Date(baseMs).getUTCDay() + 1;
  const now = () => new Date(baseMs + (ctx.nowNs() - baseSim) / 1e6);
  const dev = registers(0x68, 64, (r) => {
    if (r > 6) return ram[r];
    const d = now();
    return [bcd(d.getUTCSeconds()) | (halted ? 0x80 : 0), bcd(d.getUTCMinutes()), bcd(d.getUTCHours()),
      dow, bcd(d.getUTCDate()), bcd(d.getUTCMonth() + 1), bcd(d.getUTCFullYear() % 100)][r];
  }, (r, v) => {
    if (r > 6) { ram[r] = v; return; }
    if (r === 3) { dow = unbcd(v); return; }
    const d = now();
    const parts = [d.getUTCSeconds(), d.getUTCMinutes(), d.getUTCHours(), 0, d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear() % 100];
    if (r === 0) halted = !!(v & 0x80);
    parts[r] = unbcd(r === 0 ? v & 0x7f : r === 2 ? v & 0x3f : v);
    baseMs = Date.UTC(2000 + parts[6], parts[5] - 1, parts[4], parts[2], parts[1], parts[0]);
    baseSim = ctx.nowNs();
  });
  return { i2c: dev, state: () => ({}) };
};

/** MPU-6050 accelerometer/gyroscope. */
export const mpu6050: PartFactory = (ctx, spec) => {
  const regs = new Uint8Array(128);
  regs[0x75] = 0x68; regs[0x6b] = 0x40;
  const v = { accelX: 0, accelY: 0, accelZ: 1, rotationX: 0, rotationY: 0, rotationZ: 0, temperature: num(spec, 'temperature', 24) };
  const s16 = (x: number) => { const n = Math.max(-32768, Math.min(32767, Math.round(x))); return [(n >> 8) & 0xff, n & 0xff]; };
  const sample = () => {
    const aScale = 16384 >> ((regs[0x1c] >> 3) & 3), gScale = 131 / (1 << ((regs[0x1b] >> 3) & 3));
    const out = [...s16(v.accelX * aScale), ...s16(v.accelY * aScale), ...s16(v.accelZ * aScale),
      ...s16((v.temperature - 36.53) * 340), ...s16(v.rotationX * gScale), ...s16(v.rotationY * gScale), ...s16(v.rotationZ * gScale)];
    regs.set(out, 0x3b);
  };
  const dev = registers(attr(spec, 'address', '0x68') === '0x69' ? 0x69 : 0x68, 128, (r) => {
    if (r >= 0x3b && r <= 0x48) sample();
    return regs[r];
  }, (r, b) => { regs[r] = r === 0x6b && b & 0x80 ? 0x40 : b; });
  return {
    i2c: dev,
    control(name, val) { if (name in v) (v as Record<string, number>)[name] = val; },
    state: () => ({}),
  };
};
