// Passive and simple digital/analog parts.
import type { PartFactory, SimContext, DiagramPart } from '../sim/types.ts';
import { pin, attr, num, Duty } from './util.ts';

const ON = 1.5; // forward voltage threshold for LEDs

function watch(ctx: SimContext, spec: DiagramPart, pins: string[], fn: () => void) {
  for (const p of pins) ctx.net.listen(pin(spec, p), fn);
  fn();
}

const volts = (ctx: SimContext, spec: DiagramPart) => (p: string) => ctx.net.value(pin(spec, p));
const diff = (a: number, b: number) => (Number.isNaN(a) || Number.isNaN(b) ? 0 : a - b);

export const led: PartFactory = (ctx, spec) => {
  const V = volts(ctx, spec), duty = new Duty();
  let brightness = 0;
  watch(ctx, spec, ['A', 'C'], () => duty.set(diff(V('A'), V('C')) > ON, ctx.nowNs()));
  return {
    frame() { brightness = duty.take(ctx.nowNs()); },
    state: () => ({ value: brightness > 0.01, brightness: brightness > 0.99 ? 1 : brightness }),
  };
};

export const rgbLed: PartFactory = (ctx, spec) => {
  const V = volts(ctx, spec), anode = attr(spec, 'common', 'cathode') === 'anode';
  const ch = ['R', 'G', 'B'], duty = ch.map(() => new Duty()), val = [0, 0, 0];
  watch(ctx, spec, [...ch, 'COM'], () => ch.forEach((c, i) =>
    duty[i].set((anode ? diff(V('COM'), V(c)) : diff(V(c), V('COM'))) > ON, ctx.nowNs())));
  return {
    frame() { duty.forEach((d, i) => (val[i] = d.take(ctx.nowNs()))); },
    state: () => ({ ledRed: val[0], ledGreen: val[1], ledBlue: val[2] }),
  };
};

export const resistor: PartFactory = (ctx, spec) => {
  ctx.net.addResistor(pin(spec, '1'), pin(spec, '2'));
  return {};
};

export const pushbutton: PartFactory = (ctx, spec) => {
  let pressed = false;
  ctx.net.addSwitch(pin(spec, '1'), pin(spec, '2'), () => pressed);
  return {
    control(name, v) { if (name === 'pressed') { pressed = !!v; ctx.net.topologyChanged(); } },
    state: () => ({ pressed }),
  };
};

export const slideSwitch: PartFactory = (ctx, spec) => {
  let value = num(spec, 'value', 0);
  ctx.net.addSwitch(pin(spec, '2'), pin(spec, '1'), () => !value);
  ctx.net.addSwitch(pin(spec, '2'), pin(spec, '3'), () => !!value);
  return {
    control(name, v) { if (name === 'value') { value = v ? 1 : 0; ctx.net.topologyChanged(); } },
    state: () => ({ value }),
  };
};

export const tiltSwitch: PartFactory = (ctx, spec) => {
  let tilted = false;
  const update = () => ctx.net.drive(pin(spec, 'OUT'), { v: tilted ? 0 : ctx.board.vcc, strong: true });
  update();
  return { control(name, v) { if (name === 'tilted') { tilted = !!v; update(); } }, state: () => ({}) };
};

export const dipSwitch8: PartFactory = (ctx, spec) => {
  const values = Array(8).fill(0);
  for (let i = 0; i < 8; i++) ctx.net.addSwitch(pin(spec, `${i + 1}a`), pin(spec, `${i + 1}b`), () => !!values[i]);
  return {
    control(name, v) { const i = parseInt(name) - 1; if (i >= 0 && i < 8) { values[i] = v ? 1 : 0; ctx.net.topologyChanged(); } },
    state: () => ({ values: [...values] }),
  };
};

/** Potentiometer-like parts: SIG = GND + (VCC-GND) * position. */
function divider(max: number, pins = { vcc: 'VCC', gnd: 'GND', sig: 'SIG' }): PartFactory {
  return (ctx, spec) => {
    const V = volts(ctx, spec);
    let value = num(spec, 'value', 0);
    const update = () => {
      const lo = V(pins.gnd), hi = V(pins.vcc);
      ctx.net.drive(pin(spec, pins.sig), Number.isNaN(lo) || Number.isNaN(hi) ? null : { v: lo + (hi - lo) * (value / max), strong: true });
    };
    watch(ctx, spec, [pins.vcc, pins.gnd], update);
    return { control(name, v) { if (name === 'value') { value = Math.max(0, Math.min(max, v)); update(); } }, state: () => ({ value }) };
  };
}
export const potentiometer = divider(1023);
export const slidePotentiometer = divider(1023);

export const joystick: PartFactory = (ctx, spec) => {
  const V = volts(ctx, spec);
  let x = 0, y = 0, pressed = false;
  ctx.net.addSwitch(pin(spec, 'SEL'), pin(spec, 'GND'), () => pressed);
  const update = () => {
    const hi = V('VCC'), lo = V('GND');
    if (Number.isNaN(hi) || Number.isNaN(lo)) return;
    ctx.net.drive(pin(spec, 'HORZ'), { v: lo + (hi - lo) * (0.5 - x / 2), strong: true });
    ctx.net.drive(pin(spec, 'VERT'), { v: lo + (hi - lo) * (0.5 + y / 2), strong: true });
  };
  watch(ctx, spec, ['VCC', 'GND'], update);
  return {
    control(name, v) {
      if (name === 'x') x = Math.max(-1, Math.min(1, v));
      if (name === 'y') y = Math.max(-1, Math.min(1, v));
      if (name === 'pressed') { pressed = !!v; ctx.net.topologyChanged(); }
      update();
    },
    state: () => ({ xValue: x, yValue: y, pressed }),
  };
};

/** Analog sensor module with AOUT and a comparator DOUT (active low above threshold). */
function analogModule(opts: { control: string; def: number; toVolts: (value: number, vcc: number) => number; ao: string; do?: string; threshold?: number }): PartFactory {
  return (ctx, spec) => {
    let value = num(spec, opts.control, opts.def);
    const update = () => {
      const vcc = ctx.board.vcc, ao = opts.toVolts(value, vcc);
      ctx.net.drive(pin(spec, opts.ao), { v: ao, strong: true });
      if (opts.do) ctx.net.drive(pin(spec, opts.do), { v: ao > (opts.threshold ?? 0.5) * vcc ? 0 : vcc, strong: true });
    };
    update();
    return { control(name, v) { if (name === opts.control) { value = v; update(); } }, state: () => ({}) };
  };
}

// LDR module: 10k fixed resistor, LDR R = RL10 * (10/lux)^gamma (gamma 0.7, RL10 50k) — standard LDR model.
export const photoresistor = analogModule({
  control: 'lux', def: 500, ao: 'AO', do: 'DO',
  toVolts: (lux, vcc) => { const r = 50e3 * Math.pow(10 / Math.max(lux, 0.01), 0.7); return vcc * r / (r + 10e3); },
});

// NTC (B=3950, R0=10k @25°C) in series with 10k: OUT = VCC * Rntc/(Rntc+10k)
export const ntc = analogModule({
  control: 'temperature', def: 24, ao: 'OUT',
  toVolts: (t, vcc) => { const r = 10e3 * Math.exp(3950 * (1 / (t + 273.15) - 1 / 298.15)); return vcc * r / (r + 10e3); },
});

export const gasSensor = analogModule({ control: 'ppm', def: 400, ao: 'AOUT', do: 'DOUT', toVolts: (p, vcc) => vcc * Math.min(1, p / 10000) });
export const flameSensor = analogModule({ control: 'intensity', def: 0, ao: 'AOUT', do: 'DOUT', toVolts: (i, vcc) => vcc * (1 - Math.min(1, i / 100)), threshold: 0.5 });
export const soundSensor = analogModule({ control: 'level', def: 0, ao: 'AOUT', do: 'DOUT', toVolts: (l, vcc) => vcc * Math.min(1, l / 100) });
export const heartBeat = analogModule({ control: 'level', def: 50, ao: 'OUT', toVolts: (l, vcc) => vcc * Math.min(1, l / 100) });

export const pir: PartFactory = (ctx, spec) => {
  let cancel: (() => void) | undefined;
  const set = (v: boolean) => ctx.net.drive(pin(spec, 'OUT'), { v: v ? ctx.board.vcc : 0, strong: true });
  set(false);
  return {
    control(name, v) {
      if (name !== 'motion') return;
      set(!!v); cancel?.();
      if (v) cancel = ctx.schedule(() => set(false), num(spec, 'delayTime', 5) * 1e9);
    },
    state: () => ({}),
  };
};

export const buzzer: PartFactory = (ctx, spec) => {
  const V = volts(ctx, spec);
  let edges = 0, lastFrame = 0, frequency = 0, level = false;
  watch(ctx, spec, ['1', '2'], () => {
    const on = diff(V('2'), V('1')) > ON || diff(V('1'), V('2')) > ON;
    if (on !== level) { level = on; edges++; }
  });
  return {
    frame() {
      const now = ctx.nowNs(), dt = (now - lastFrame) / 1e9;
      frequency = dt > 0 && edges > 2 ? Math.round(edges / 2 / dt) : 0;
      edges = 0; lastFrame = now;
    },
    state: () => ({ hasSignal: frequency > 0, frequency }),
  };
};

const SEGMENTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];

export const sevenSegment: PartFactory = (ctx, spec) => {
  const V = volts(ctx, spec), digits = num(spec, 'digits', 1), anode = attr(spec, 'common', 'anode') === 'anode';
  const commons = digits === 1 ? ['COM'] : Array.from({ length: digits }, (_, i) => `DIG${i + 1}`);
  const duty = Array.from({ length: digits * 8 + 1 }, () => new Duty());
  let values = Array(digits * 8).fill(0), colon = 0;
  const lit = (seg: string, com: string) => (anode ? diff(V(com), V(seg)) : diff(V(seg), V(com))) > ON;
  watch(ctx, spec, [...SEGMENTS, ...commons, ...(digits === 4 ? ['CLN'] : [])], () => {
    const now = ctx.nowNs();
    commons.forEach((c, d) => SEGMENTS.forEach((s, i) => duty[d * 8 + i].set(lit(s, c), now)));
    if (digits === 4) duty[digits * 8].set(lit('CLN', 'DIG2'), now);
  });
  return {
    frame() { const now = ctx.nowNs(); values = duty.slice(0, digits * 8).map((d) => (d.take(now) > 0.05 ? 1 : 0)); colon = duty[digits * 8].take(now) > 0.05 ? 1 : 0; },
    state: () => ({ values, colonValue: !!colon }),
  };
};

export const ledBarGraph: PartFactory = (ctx, spec) => {
  const V = volts(ctx, spec), duty = Array.from({ length: 10 }, () => new Duty());
  let values = Array(10).fill(0);
  const pins = Array.from({ length: 10 }, (_, i) => [`A${i + 1}`, `C${i + 1}`]).flat();
  watch(ctx, spec, pins, () => duty.forEach((d, i) => d.set(diff(V(`A${i + 1}`), V(`C${i + 1}`)) > ON, ctx.nowNs())));
  return { frame() { values = duty.map((d) => (d.take(ctx.nowNs()) > 0.05 ? 1 : 0)); }, state: () => ({ values }) };
};

export const relay: PartFactory = (ctx, spec) => {
  const V = volts(ctx, spec);
  let on = false;
  for (const n of ['1', '2']) {
    ctx.net.addSwitch(pin(spec, `P${n}`), pin(spec, `NO${n}`), () => on);
    ctx.net.addSwitch(pin(spec, `P${n}`), pin(spec, `NC${n}`), () => !on);
  }
  watch(ctx, spec, ['COIL1', 'COIL2'], () => {
    const now = Math.abs(diff(V('COIL1'), V('COIL2'))) > 2.5;
    if (now !== on) { on = now; ctx.net.topologyChanged(); }
  });
  return { state: () => ({}) };
};

/** Relay module (single channel, IN/VCC/GND + COM/NO/NC). */
export const relayModule: PartFactory = (ctx, spec) => {
  const V = volts(ctx, spec), activeLow = attr(spec, 'trigger', 'high') === 'low';
  let on = false;
  ctx.net.addSwitch(pin(spec, 'COM'), pin(spec, 'NO'), () => on);
  ctx.net.addSwitch(pin(spec, 'COM'), pin(spec, 'NC'), () => !on);
  watch(ctx, spec, ['IN'], () => {
    const v = V('IN'), hi = !Number.isNaN(v) && v > 2;
    const now = activeLow ? !hi : hi;
    if (now !== on) { on = now; ctx.net.topologyChanged(); }
  });
  return { state: () => ({}) };
};

const KEYS4 = '123A456B789C*0#D';

export const keypad: PartFactory = (ctx, spec) => {
  const cols = attr(spec, 'columns', '4') === '3' ? 3 : 4;
  const pressed = new Set<number>();
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < cols; c++) {
      const idx = r * 4 + c;
      ctx.net.addSwitch(pin(spec, `R${r + 1}`), pin(spec, `C${c + 1}`), () => pressed.has(idx));
    }
  return {
    control(name, v) {
      // name: "key:<label>" (e.g. "key:5", "key:#"), value 1 = down, 0 = up
      const idx = name.startsWith('key:') ? KEYS4.indexOf(name.slice(4)) : -1;
      if (idx < 0) return;
      if (v) pressed.add(idx); else pressed.delete(idx);
      ctx.net.topologyChanged();
    },
    state: () => ({}),
  };
};

export const rotaryEncoder: PartFactory = (ctx, spec) => {
  let pressed = false, angle = 0;
  ctx.net.addSwitch(pin(spec, 'SW'), pin(spec, 'GND'), () => pressed);
  const vcc = ctx.board.vcc;
  ctx.net.drive(pin(spec, 'CLK'), { v: vcc, strong: true });
  ctx.net.drive(pin(spec, 'DT'), { v: vcc, strong: true });
  const set = (p: string, v: number) => ctx.net.drive(pin(spec, p), { v: v * vcc, strong: true });
  const step = (cw: boolean) => {
    const [a, b] = cw ? ['CLK', 'DT'] : ['DT', 'CLK'];
    const seq: [string, number][] = [[a, 0], [b, 0], [a, 1], [b, 1]];
    let i = 0;
    const next = () => { if (i < seq.length) { set(...seq[i++]); ctx.schedule(next, 1e6); } };
    next();
    angle += cw ? 18 : -18;
  };
  return {
    control(name, v) {
      if (name === 'pressed') { pressed = !!v; ctx.net.topologyChanged(); }
      if (name === 'rotate') { const n = Math.abs(v); for (let i = 0; i < n; i++) ctx.schedule(() => step(v > 0), i * 5e6); }
    },
    state: () => ({ angle, pressed }),
  };
};

// 8 half-step phases around the circle, from two coils' polarity signs.
const PHASE_TABLE: Record<string, number> = { '1,0': 0, '1,1': 1, '0,1': 2, '-1,1': 3, '-1,0': 4, '-1,-1': 5, '0,-1': 6, '1,-1': 7 };

/** Tracks one bipolar coil pair's half-step phase and accumulates an angle from it. */
function coilAngle(ctx: SimContext, spec: DiagramPart, pins: [string, string, string, string]) {
  const V = volts(ctx, spec);
  let pos = 0, last = -1;
  const [aPos, aNeg, bPos, bNeg] = pins;
  watch(ctx, spec, pins, () => {
    const a = Math.sign(diff(V(aPos), V(aNeg))), b = Math.sign(diff(V(bPos), V(bNeg)));
    const p = PHASE_TABLE[`${a},${b}`] ?? -1;
    if (p < 0) return;
    if (last >= 0) { let d = p - last; if (d > 4) d -= 8; if (d < -4) d += 8; pos += d; }
    last = p;
  });
  return () => ((pos * 0.9) % 360 + 360) % 360;
}

/** Bipolar stepper motor (4 wires: A+/A-/B+/B-, one coil pair - matches @wokwi/elements' stepper-motor-element). */
export const stepper: PartFactory = (ctx, spec) => {
  const angle = coilAngle(ctx, spec, ['A+', 'A-', 'B+', 'B-']);
  return { state: () => ({ angle: angle() }) };
};

/** Biaxial stepper (8 wires: two independent bipolar coil pairs driving two clock hands - real
 *  @wokwi/elements pin names are A1+/A1-/B1+/B1- for the outer hand and A2+/A2-/B2+/B2- for the
 *  inner hand, NOT the plain A+/A-/B+/B- that `stepper` above uses for the single-coil motor). */
export const biaxialStepper: PartFactory = (ctx, spec) => {
  const outer = coilAngle(ctx, spec, ['A1+', 'A1-', 'B1+', 'B1-']);
  const inner = coilAngle(ctx, spec, ['A2+', 'A2-', 'B2+', 'B2-']);
  return { state: () => ({ outerHandAngle: outer(), innerHandAngle: inner() }) };
};

/** wokwi-text: a cosmetic diagram annotation label. No pins, no electrical behavior - real Wokwi
 *  projects use it purely for on-canvas notes (see src/web/main.ts's renderAll() for the rendering). */
export const text: PartFactory = () => ({});

