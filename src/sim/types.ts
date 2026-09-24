import type { Netlist } from './netlist.ts';

export interface DiagramPart {
  type: string;
  id: string;
  top?: number;
  left?: number;
  rotate?: number;
  hide?: boolean;
  attrs?: Record<string, string>;
}

/** [from, to, color, route] — same shape as the common diagram.json format. */
export type Connection = [string, string, string?, string[]?];

export interface Diagram {
  version: number;
  author?: string;
  editor?: string;
  parts: DiagramPart[];
  connections: Connection[];
  serialMonitor?: { display?: string; newline?: string };
}

export interface I2CDevice {
  address: number;
  /** Returns ack. */
  connect(write: boolean): boolean;
  write(byte: number): boolean;
  read(ack: boolean): number;
  stop(): void;
}

export interface SPIDevice {
  /** Chip-select endpoint (active low), e.g. "sd1:CS". */
  cs: string;
  transfer(byte: number): number;
}

export interface Board {
  readonly id: string;
  readonly vcc: number;
  readonly i2cPins?: { sda: string; scl: string };
  readonly spiPins?: { sck: string; mosi: string; miso: string };
  /** Board pin names that the simulation drives/listens to (no power pins). */
  readonly pins: string[];
  nowNs(): number;
  /** Run fn after delayNs of simulated time. Returns a cancel function. */
  schedule(fn: () => void, delayNs: number): () => void;
  /** Execute until simulated time advanced by ms. */
  run(ms: number): void;
  serialWrite(data: Uint8Array): void;
  onSerial: (data: Uint8Array) => void;
  addI2C(dev: I2CDevice): void;
  addSPI(dev: SPIDevice): void;
  /** Wire pins into the netlist: drive outputs, listen for inputs. */
  attach(net: Netlist): void;
  stop(): void;
  /** Optional: returns true while the firmware has not finished booting (e.g. MicroPython). */
  readonly async?: boolean;
}

export interface SimContext {
  net: Netlist;
  board: Board;
  nowNs(): number;
  schedule(fn: () => void, delayNs: number): () => void;
  log(msg: string): void;
}

export interface Part {
  /** Properties pushed to the browser element (element property names). */
  state?(): Record<string, unknown>;
  /** User/automation input, e.g. ("pressed", 1), ("position", 512), ("temperature", 25). */
  control?(name: string, value: number): void;
  /** Called at UI refresh rate (~20Hz) with simulated time; for averaging (PWM brightness). */
  frame?(): void;
  /** Framebuffer for screenshots of displays. */
  framebuffer?(): { width: number; height: number; rgba: Uint8Array };
  i2c?: I2CDevice;
  spi?: SPIDevice;
}

export type PartFactory = (ctx: SimContext, spec: DiagramPart) => Part;

export interface Firmware {
  kind: 'hex' | 'uf2' | 'bin' | 'elf';
  data: Uint8Array;
  /** Extra files, e.g. MicroPython sources to upload on boot. */
  files?: Record<string, string>;
}
