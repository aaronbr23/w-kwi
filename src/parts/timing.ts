// Parts with timing-based protocols, implemented from their datasheets.
import type { PartFactory } from '../sim/types.ts';
import { pin, num, waveform } from './util.ts';

const US = 1000; // ns

/** Hobby servo: pulse width 544..2400µs maps to 0..180° (Arduino Servo library defaults). */
export const servo: PartFactory = (ctx, spec) => {
  const minUs = num(spec, 'minPulse', 544), maxUs = num(spec, 'maxPulse', 2400);
  let rise = -1, angle = 0;
  ctx.net.listen(pin(spec, 'PWM'), (v) => {
    const now = ctx.nowNs();
    if (v > 1.5) rise = now;
    else if (rise >= 0) {
      const w = (now - rise) / US;
      if (w > 300 && w < 3000) angle = Math.max(0, Math.min(180, ((w - minUs) / (maxUs - minUs)) * 180));
      rise = -1;
    }
  });
  return { state: () => ({ angle: Math.round(angle) }) };
};

/** DHT22 / AM2302 single-wire protocol. */
export const dht22: PartFactory = (ctx, spec) => {
  let temperature = num(spec, 'temperature', 24), humidity = num(spec, 'humidity', 40);
  const sda = pin(spec, 'SDA');
  let fall = -1, busy = false;
  const vcc = () => ctx.board.vcc;
  ctx.net.drive(sda, { v: vcc(), strong: false }); // module pull-up
  ctx.net.listen(sda, (v) => {
    if (busy) return;
    const now = ctx.nowNs();
    if (v < 1) { fall = now; return; }
    if (fall >= 0 && now - fall > 500 * US) {
      busy = true;
      const h = Math.round(humidity * 10), t = Math.round(Math.abs(temperature) * 10) | (temperature < 0 ? 0x8000 : 0);
      const bytes = [h >> 8, h & 0xff, t >> 8, t & 0xff];
      bytes.push(bytes.reduce((a, b) => a + b, 0) & 0xff);
      const steps: [number | null, number][] = [[null, 30 * US], [0, 80 * US], [null, 80 * US]];
      for (const b of bytes) for (let i = 7; i >= 0; i--) steps.push([0, 50 * US], [null, (b >> i) & 1 ? 70 * US : 27 * US]);
      steps.push([0, 50 * US]);
      waveform(ctx, sda, steps, vcc(), () => { busy = false; fall = -1; });
    }
    fall = -1;
  });
  return {
    control(name, v) { if (name === 'temperature') temperature = v; if (name === 'humidity') humidity = v; },
    state: () => ({}),
  };
};

/** HC-SR04 ultrasonic: 10µs TRIG pulse → ECHO high for distance(cm) * 58µs. */
export const hcsr04: PartFactory = (ctx, spec) => {
  let distance = num(spec, 'distance', 400), rise = -1;
  const echo = pin(spec, 'ECHO');
  ctx.net.drive(echo, { v: 0, strong: true });
  ctx.net.listen(pin(spec, 'TRIG'), (v) => {
    const now = ctx.nowNs();
    if (v > 1.5) { rise = now; return; }
    if (rise >= 0 && now - rise >= 8 * US) {
      const vcc = ctx.board.vcc;
      ctx.schedule(() => {
        ctx.net.drive(echo, { v: vcc, strong: true });
        ctx.schedule(() => ctx.net.drive(echo, { v: 0, strong: true }), Math.max(2, Math.min(400, distance)) * 58 * US);
      }, 250 * US);
    }
    rise = -1;
  });
  return { control(name, v) { if (name === 'distance') distance = v; }, state: () => ({ distance }) };
};

/**
 * WS2812 chain decoder. Bits: high time > 0.55µs = 1. Low > 50µs = latch.
 * The first `count` pixels are consumed, the rest of the bit stream is forwarded to DOUT.
 */
function ws2812(count: number, dout?: string): (ctx: Parameters<PartFactory>[0], spec: Parameters<PartFactory>[1]) => { pixels: number[][]; dirty: () => boolean } {
  return (ctx, spec) => {
    const pixels = Array.from({ length: count }, () => [0, 0, 0]);
    const fresh = Array.from({ length: count }, () => [0, 0, 0]);
    let rise = -1, fall = -1, bits = 0, cur = 0, n = 0, dirty = true;
    const total = count * 24, out = dout && pin(spec, dout);
    const latch = () => { for (let i = 0; i < count; i++) pixels[i] = [...fresh[i]]; dirty = true; n = 0; bits = 0; cur = 0; };
    if (out) ctx.net.drive(out, { v: 0, strong: true });
    ctx.net.listen(pin(spec, 'DIN'), (v) => {
      const now = ctx.nowNs(), high = v > 1.5;
      if (high && fall >= 0 && now - fall > 50 * US && n > 0) latch();
      if (n >= total) {
        // our pixels are full: forward the rest of the stream down the chain
        if (out) ctx.net.drive(out, { v: high ? ctx.board.vcc : 0, strong: true });
        if (!high) fall = now;
        return;
      }
      if (high) { rise = now; return; }
      if (rise >= 0) {
        cur = (cur << 1) | (now - rise > 550 ? 1 : 0);
        if (++bits === 8) { const px = Math.floor(n / 24), c = Math.floor((n % 24) / 8); fresh[px][[1, 0, 2][c]] = cur; bits = 0; cur = 0; }
        n++;
      }
      fall = now;
    });
    // latch detection when the line stays low (no further rising edge)
    const check = () => { if (fall >= 0 && ctx.nowNs() - fall > 50 * US && n > 0) latch(); };
    return { pixels, dirty: () => { check(); const d = dirty; dirty = false; return d; } };
  };
}

export const neopixel: PartFactory = (ctx, spec) => {
  const s = ws2812(1, 'DOUT')(ctx, spec);
  let st = { r: 0, g: 0, b: 0 };
  return {
    frame() { if (s.dirty()) { const [r, g, b] = s.pixels[0]; st = { r: r / 255, g: g / 255, b: b / 255 }; } },
    state: () => st,
  };
};

/** NeoPixel matrix / ring: state.pixels = flat [r,g,b,...] 0..255, applied via setPixel in the UI. */
function pixelStrip(countOf: (spec: Parameters<PartFactory>[1]) => number): PartFactory {
  return (ctx, spec) => {
    const s = ws2812(countOf(spec), 'DOUT')(ctx, spec);
    let flat: number[] = [];
    return { frame() { if (s.dirty()) flat = s.pixels.flat(); }, state: () => ({ pixels: flat }) };
  };
}
export const neopixelMatrix = pixelStrip((spec) => num(spec, 'rows', 8) * num(spec, 'cols', 8));
export const ledRing = pixelStrip((spec) => num(spec, 'pixels', 16));

/** HX711 load cell ADC: 24-bit two's complement, clocked out on SCK, gain via extra pulses. */
export const hx711: PartFactory = (ctx, spec) => {
  let weight = num(spec, 'weight', 0), shift = 0, word = 0, sckHigh = false;
  const dt = pin(spec, 'DT'), vcc = () => ctx.board.vcc;
  const ready = () => { word = Math.round(weight * 420) & 0xffffff; shift = 0; ctx.net.drive(dt, { v: 0, strong: true }); };
  ready();
  ctx.net.listen(pin(spec, 'SCK'), (v) => {
    const hi = v > 1.5;
    if (hi === sckHigh) return;
    sckHigh = hi;
    if (!hi) return;
    if (shift < 24) ctx.net.drive(dt, { v: (word >> (23 - shift)) & 1 ? vcc() : 0, strong: true });
    else ctx.net.drive(dt, { v: vcc(), strong: true });
    shift++;
    if (shift >= 25) ctx.schedule(ready, 100 * US); // ponytail: gain/channel pulses (25-27) all treated as gain 128
  });
  return { control(name, v) { if (name === 'weight') weight = v; }, state: () => ({}) };
};

/** IR receiver (TSOP style, active low output). control("nec", code) sends an NEC frame (addr<<8|cmd). */
export const irReceiver: PartFactory = (ctx, spec) => {
  const dat = pin(spec, 'DAT');
  ctx.net.drive(dat, { v: ctx.board.vcc, strong: true });
  return {
    control(name, v) {
      if (name !== 'nec') return;
      const addr = (v >> 8) & 0xff, cmd = v & 0xff;
      const bytes = [addr, ~addr & 0xff, cmd, ~cmd & 0xff];
      const steps: [number | null, number][] = [[0, 9000 * US], [1, 4500 * US]];
      for (const b of bytes) for (let i = 0; i < 8; i++) steps.push([0, 562 * US], [1, (b >> i) & 1 ? 1687 * US : 562 * US]);
      steps.push([0, 562 * US]);
      const vcc = ctx.board.vcc;
      let i = 0;
      const next = () => {
        if (i >= steps.length) { ctx.net.drive(dat, { v: vcc, strong: true }); return; }
        const [lv, ns] = steps[i++];
        ctx.net.drive(dat, { v: lv ? vcc : 0, strong: true });
        ctx.schedule(next, ns);
      };
      next();
    },
    state: () => ({}),
  };
};
