// Display controllers implemented from datasheets: HD44780 (+PCF8574 backpack), SSD1306, ILI9341.
import type { PartFactory, SimContext, DiagramPart, I2CDevice } from '../sim/types.ts';
import { pin, attr } from './util.ts';

/** HD44780 character LCD controller. */
class HD44780 {
  ddram = new Uint8Array(128).fill(0x20);
  cgram = new Uint8Array(64);
  addr = 0; cgMode = false; inc = 1; shiftDisplay = false; offset = 0;
  displayOn = false; cursor = false; blink = false;
  fourBit = false; nibble = -1;
  constructor(public cols: number, public rows: number) {}

  /** Called on falling edge of E with the current RS and data bus. */
  strobe(rs: boolean, bus: number) {
    if (this.fourBit) {
      if (this.nibble < 0) { this.nibble = bus & 0xf0; return; }
      bus = this.nibble | (bus >> 4);
      this.nibble = -1;
    }
    if (rs) this.data(bus); else this.command(bus);
  }

  private data(b: number) {
    if (this.cgMode) { this.cgram[this.addr & 0x3f] = b & 0x1f; this.addr = (this.addr + this.inc) & 0x3f; return; }
    this.ddram[this.addr & 0x7f] = b;
    this.addr = (this.addr + this.inc) & 0x7f;
    if (this.shiftDisplay) this.offset += this.inc;
  }

  private command(c: number) {
    if (c & 0x80) { this.cgMode = false; this.addr = c & 0x7f; }
    else if (c & 0x40) { this.cgMode = true; this.addr = c & 0x3f; }
    else if (c & 0x20) { this.fourBit = !(c & 0x10); this.nibble = -1; }
    else if (c & 0x10) {
      const right = !!(c & 0x04);
      if (c & 0x08) this.offset += right ? -1 : 1; else this.addr = (this.addr + (right ? 1 : -1)) & 0x7f;
    }
    else if (c & 0x08) { this.displayOn = !!(c & 4); this.cursor = !!(c & 2); this.blink = !!(c & 1); }
    else if (c & 0x04) { this.inc = c & 2 ? 1 : -1; this.shiftDisplay = !!(c & 1); }
    else if (c & 0x02) { this.addr = 0; this.offset = 0; this.cgMode = false; }
    else if (c & 0x01) { this.ddram.fill(0x20); this.addr = 0; this.offset = 0; this.inc = 1; this.cgMode = false; }
  }

  private rowAddr(r: number) { return [0x00, 0x40, this.cols, 0x40 + this.cols][r]; }

  state() {
    const chars = new Array<number>(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const base = this.rowAddr(r) & 0x40, start = this.rowAddr(r) - base;
        const col = ((((start + c + this.offset) % 40) + 40) % 40);
        chars[r * this.cols + c] = this.displayOn ? this.ddram[base + col] : 0x20;
      }
    let cx = -1, cy = -1;
    for (let r = 0; r < this.rows; r++) {
      const base = this.rowAddr(r) & 0x40, start = this.rowAddr(r) - base;
      const a = this.addr & 0x7f;
      if ((a & 0x40) !== base) continue;
      const col = ((((a - base) - start - this.offset) % 40) + 40) % 40;
      if (col < this.cols && (a - base) >= start) { cx = col; cy = r; break; }
    }
    return { characters: chars, cursor: this.cursor && this.displayOn, blink: this.blink && this.displayOn, cursorX: cx, cursorY: cy, cgram: [...this.cgram] };
  }
}

function lcd(cols: number, rows: number): PartFactory {
  return (ctx, spec) => {
    const hd = new HD44780(cols, rows);
    let backlight = true;
    if (attr(spec, 'pins', 'full') === 'i2c') {
      let lastE = false;
      const dev: I2CDevice = {
        address: parseInt(attr(spec, 'i2cAddress', '0x27')),
        connect: () => true,
        write(b) {
          // PCF8574 backpack wiring: P0=RS P1=RW P2=E P3=backlight P4..P7=D4..D7
          const e = !!(b & 4);
          backlight = !!(b & 8);
          if (lastE && !e && !(b & 2)) hd.strobe(!!(b & 1), b & 0xf0);
          lastE = e;
          return true;
        },
        read: () => 0xff,
        stop() {},
      };
      return { i2c: dev, state: () => ({ ...hd.state(), backlight }) };
    }
    const V = (p: string) => ctx.net.value(pin(spec, p)) > 2.5;
    let e = false;
    ctx.net.listen(pin(spec, 'E'), (v) => {
      const now = v > 2.5;
      if (e && !now && !V('RW')) {
        let bus = 0;
        for (let i = 0; i < 8; i++) if (V(`D${i}`)) bus |= 1 << i;
        hd.strobe(V('RS'), bus);
      }
      e = now;
    });
    return { state: () => ({ ...hd.state(), backlight: true }) };
  };
}
export const lcd1602 = lcd(16, 2);
export const lcd2004 = lcd(20, 4);

/** SSD1306 128x64 OLED over I2C. */
export const ssd1306: PartFactory = (ctx, spec) => {
  const W = 128, H = 64, buf = new Uint8Array(W * H / 8);
  let mode = 2, col = 0, page = 0, c0 = 0, c1 = W - 1, p0 = 0, p1 = 7;
  let on = false, invert = false, dirty = true;
  let expectControl = true, cmd: number[] = [], dataMode = false, continuation = false;
  const ARGS: Record<number, number> = { 0x81: 1, 0x20: 1, 0x21: 2, 0x22: 2, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x8d: 1, 0xa3: 2, 0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5 };

  const command = (c: number[]) => {
    const op = c[0];
    if (op === 0xae || op === 0xaf) on = op === 0xaf;
    else if (op === 0xa6 || op === 0xa7) invert = op === 0xa7;
    else if (op === 0x20) mode = c[1] & 3;
    else if (op === 0x21) { c0 = c[1] & 0x7f; c1 = c[2] & 0x7f; col = c0; }
    else if (op === 0x22) { p0 = c[1] & 7; p1 = c[2] & 7; page = p0; }
    else if (op >= 0xb0 && op <= 0xb7) page = op & 7;
    else if (op <= 0x0f) col = (col & 0xf0) | op;
    else if (op >= 0x10 && op <= 0x1f) col = (col & 0x0f) | ((op & 0xf) << 4);
    dirty = true;
  };
  const data = (b: number) => {
    buf[page * W + col] = b;
    dirty = true;
    if (mode === 2) { col = Math.min(col + 1, W - 1); return; }
    if (mode === 0) { if (++col > c1) { col = c0; if (++page > p1) page = p0; } }
    else { if (++page > p1) { page = p0; if (++col > c1) col = c0; } }
  };

  const dev: I2CDevice = {
    address: parseInt(attr(spec, 'i2cAddress', '0x3c')),
    connect: () => { expectControl = true; return true; },
    write(b) {
      if (expectControl) { continuation = !!(b & 0x80); dataMode = !!(b & 0x40); expectControl = false; return true; }
      if (dataMode) data(b);
      else {
        cmd.push(b);
        if (cmd.length > (ARGS[cmd[0]] ?? 0)) { command(cmd); cmd = []; }
      }
      if (continuation) expectControl = true;
      return true;
    },
    read: () => 0,
    stop() {},
  };

  const pixel = (x: number, y: number) => !!(buf[(y >> 3) * W + x] & (1 << (y & 7))) !== invert && on;
  let packed = '';
  return {
    i2c: dev,
    frame() {
      if (!dirty) return;
      dirty = false;
      const bits = new Uint8Array(W * H / 8);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pixel(x, y)) bits[(y * W + x) >> 3] |= 0x80 >> (x & 7);
      packed = Buffer.from(bits).toString('base64');
    },
    state: () => ({ bitmap: packed, width: W, height: H }),
    framebuffer() {
      const rgba = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, v = pixel(x, y);
        rgba[o] = v ? 0x9f : 0; rgba[o + 1] = v ? 0xef : 0; rgba[o + 2] = v ? 0xff : 0; rgba[o + 3] = 255;
      }
      return { width: W, height: H, rgba };
    },
  };
};

/** ILI9341 240x320 TFT over SPI (RGB565). */
export const ili9341: PartFactory = (ctx: SimContext, spec: DiagramPart) => {
  const W = 240, H = 320, fb = new Uint16Array(W * H);
  let cmd = 0, args: number[] = [], x0 = 0, x1 = W - 1, y0 = 0, y1 = H - 1, x = 0, y = 0, hi = -1, dirty = true, madctl = 0;
  const dc = pin(spec, 'D/C');
  const transfer = (b: number) => {
    if (ctx.net.value(dc) < 1.5) { cmd = b; args = []; hi = -1; if (cmd === 0x2c) { x = x0; y = y0; } return 0; }
    if (cmd === 0x2a || cmd === 0x2b) {
      args.push(b);
      if (args.length === 4) {
        const a = (args[0] << 8) | args[1], z = (args[2] << 8) | args[3];
        if (cmd === 0x2a) { x0 = a; x1 = z; } else { y0 = a; y1 = z; }
      }
    } else if (cmd === 0x36) madctl = b;
    else if (cmd === 0x2c) {
      if (hi < 0) { hi = b; return 0; }
      const px = (hi << 8) | b; hi = -1;
      // ponytail: MADCTL rotation only handles MV (row/column exchange) for landscape
      const [fx, fy] = madctl & 0x20 ? [y, x] : [x, y];
      if (fx < W && fy < H) fb[fy * W + fx] = px;
      dirty = true;
      if (++x > x1) { x = x0; if (++y > y1) y = y0; }
    }
    return 0;
  };
  let packed = '';
  const rgba = () => {
    const out = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const p = fb[i];
      out[i * 4] = ((p >> 11) & 0x1f) << 3; out[i * 4 + 1] = ((p >> 5) & 0x3f) << 2; out[i * 4 + 2] = (p & 0x1f) << 3; out[i * 4 + 3] = 255;
    }
    return out;
  };
  return {
    spi: { cs: pin(spec, 'CS'), transfer },
    frame() { if (dirty) { dirty = false; packed = Buffer.from(fb.buffer).toString('base64'); } },
    state: () => ({ rgb565: packed, width: W, height: H }),
    framebuffer: () => ({ width: W, height: H, rgba: rgba() }),
  };
};
