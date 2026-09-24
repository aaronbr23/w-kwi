// Ties board + netlist + part instances together into one running simulation.
import { PNG } from 'pngjs';
import { Netlist } from './netlist.ts';
import { createBoard } from './boards/index.ts';
import { CATALOG } from '../parts/catalog.ts';
import type { Board, Diagram, Part, Firmware, SimContext } from './types.ts';

const FRAME_MS = 50; // ~20Hz, matches Part.frame() contract

export interface LogicSample { tNs: number; values: number[] }

export class Session {
  readonly net = new Netlist();
  readonly board: Board;
  readonly parts = new Map<string, Part>();
  private timer?: NodeJS.Timeout;
  private serial: number[] = [];
  onSerial?: (data: Uint8Array) => void;
  onState?: (states: Record<string, Record<string, unknown>>) => void;
  private capture?: { pins: string[]; samples: LogicSample[]; endNs: number; resolve: (s: LogicSample[]) => void };

  constructor(readonly diagram: Diagram, boardId: string, fw: Firmware) {
    const boardSpec = diagram.parts.find((p) => p.id === boardId);
    if (!boardSpec) throw new Error(`Board part "${boardId}" not found in diagram`);
    this.board = createBoard(boardSpec.type, boardId, fw);
    this.board.onSerial = (data) => { this.serial.push(...data); this.onSerial?.(data); };
    this.board.attach(this.net);

    const ctx: SimContext = {
      net: this.net,
      board: this.board,
      nowNs: () => this.board.nowNs(),
      schedule: (fn, delayNs) => this.board.schedule(fn, delayNs),
      log: (msg) => console.log(`[${boardId}]`, msg),
    };

    this.net.batch(() => {
      for (const spec of diagram.parts) {
        if (spec.id === boardId || spec.hide) continue;
        const factory = CATALOG[spec.type];
        if (!factory) throw new Error(`Unknown part type "${spec.type}" (id "${spec.id}")`);
        const part = factory(ctx, spec);
        this.parts.set(spec.id, part);
        if (part.i2c) this.board.addI2C(part.i2c);
        if (part.spi) this.board.addSPI(part.spi);
      }
      for (const [from, to] of diagram.connections) this.net.connect(from, to);
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), FRAME_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get running() { return this.timer !== undefined; }

  private tick() {
    this.board.run(FRAME_MS);
    const states: Record<string, Record<string, unknown>> = {};
    for (const [id, part] of this.parts) {
      part.frame?.();
      if (part.state) states[id] = part.state();
    }
    this.onState?.(states);
    if (this.capture && this.board.nowNs() >= this.capture.endNs) this.finishCapture();
  }

  destroy() { this.stop(); this.board.stop(); }

  /** Digital/analog read in volts, or a 0/1/NaN digital reading via the `digital` flag. */
  readPin(endpoint: string): number { return this.net.value(endpoint); }

  writeSerial(data: Uint8Array) { this.board.serialWrite(data); }

  /** Bytes received from the firmware since `sinceIndex`; returns [bytes, newIndex]. */
  readSerial(sinceIndex: number): [Uint8Array, number] {
    return [Uint8Array.from(this.serial.slice(sinceIndex)), this.serial.length];
  }

  control(partId: string, name: string, value: number) {
    const part = this.parts.get(partId);
    if (!part) throw new Error(`Unknown part "${partId}"`);
    part.control?.(name, value);
  }

  state(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, part] of this.parts) if (part.state) out[id] = part.state();
    return out;
  }

  screenshot(partId: string): Buffer {
    const part = this.parts.get(partId);
    const fb = part?.framebuffer?.();
    if (!fb) throw new Error(`Part "${partId}" has no framebuffer`);
    const png = new PNG({ width: fb.width, height: fb.height });
    png.data.set(fb.rgba);
    return PNG.sync.write(png);
  }

  /** Records digital transitions on `pins` for durationNs of simulated time. Resolves with one sample per change (any pin). */
  captureLogic(pins: string[], durationNs: number): Promise<LogicSample[]> {
    if (this.capture) throw new Error('A logic capture is already running');
    return new Promise((resolve) => {
      const start = this.board.nowNs();
      const values = pins.map((p) => this.net.value(p));
      const samples: LogicSample[] = [{ tNs: 0, values: [...values] }];
      const listeners = pins.map((p, i) => {
        const fn = (v: number) => { values[i] = v; samples.push({ tNs: this.board.nowNs() - start, values: [...values] }); };
        this.net.listen(p, fn);
        return fn;
      });
      this.capture = { pins, samples, endNs: start + durationNs, resolve: (s) => { void listeners; resolve(s); } };
    });
  }

  private finishCapture() {
    const cap = this.capture!;
    this.capture = undefined;
    cap.resolve(cap.samples);
  }

  /** Renders captured samples as VCD text (digital: 0/1/x, analog: real). */
  static toVCD(pins: string[], samples: LogicSample[]): string {
    const ids = pins.map((_, i) => String.fromCharCode(33 + i));
    const lines = [
      '$timescale 1ns $end',
      '$scope module circuitlab $end',
      ...pins.map((p, i) => `$var wire 1 ${ids[i]} ${p.replace(/[^a-zA-Z0-9_:]/g, '_')} $end`),
      '$upscope $end', '$enddefinitions $end',
    ];
    for (const s of samples) {
      lines.push(`#${s.tNs}`);
      s.values.forEach((v, i) => lines.push(`${Number.isNaN(v) ? 'x' : v > 2.5 ? '1' : '0'}${ids[i]}`));
    }
    return lines.join('\n');
  }
}
