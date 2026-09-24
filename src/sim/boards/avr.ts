import {
  CPU, avrInstruction, AVRIOPort, AVRTimer, AVRUSART, AVRTWI, AVRSPI, AVRADC, AVRClock, AVREEPROM,
  EEPROMMemoryBackend, AVRWatchdog, PinState, portAConfig, portBConfig, portCConfig, portDConfig,
  portEConfig, portFConfig, portGConfig, portHConfig, portJConfig, portKConfig, portLConfig,
  timer0Config, timer1Config, timer2Config, usart0Config, twiConfig, spiConfig, adcConfig,
  clockConfig, eepromConfig, watchdogConfig, PCINT0, PCINT1, PCINT2,
  type AVRPortConfig, type TWIEventHandler,
} from 'avr8js';
import type { Board, I2CDevice, SPIDevice, Firmware } from '../types.ts';
import type { Netlist } from '../netlist.ts';

export function parseHex(text: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let base = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(':')) continue;
    const n = parseInt(line.slice(1, 3), 16), addr = parseInt(line.slice(3, 7), 16), type = parseInt(line.slice(7, 9), 16);
    if (type === 0) for (let i = 0; i < n; i++) out[base + addr + i] = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
    else if (type === 2) base = parseInt(line.slice(9, 13), 16) << 4;
    else if (type === 4) base = parseInt(line.slice(9, 13), 16) << 16;
  }
  return out;
}

type PinMap = Record<string, [port: string, bit: number, adc?: number]>;

function range(prefix: string, from: number, port: string, bits: number[], adc0?: number): PinMap {
  const m: PinMap = {};
  bits.forEach((b, i) => { m[prefix + (from + i)] = adc0 === undefined ? [port, b] : [port, b, adc0 + i]; });
  return m;
}

const UNO_PINS: PinMap = {
  ...range('', 0, 'D', [0, 1, 2, 3, 4, 5, 6, 7]),
  ...range('', 8, 'B', [0, 1, 2, 3, 4, 5]),
  ...range('A', 0, 'C', [0, 1, 2, 3, 4, 5], 0),
};

// Arduino Mega 2560 pin mapping (from the ATmega2560 datasheet / Arduino Mega schematic)
const MEGA_PINS: PinMap = {
  0: ['E', 0], 1: ['E', 1], 2: ['E', 4], 3: ['E', 5], 4: ['G', 5], 5: ['E', 3], 6: ['H', 3], 7: ['H', 4],
  8: ['H', 5], 9: ['H', 6], 10: ['B', 4], 11: ['B', 5], 12: ['B', 6], 13: ['B', 7], 14: ['J', 1], 15: ['J', 0],
  16: ['H', 1], 17: ['H', 0], 18: ['D', 3], 19: ['D', 2], 20: ['D', 1], 21: ['D', 0],
  ...range('', 22, 'A', [0, 1, 2, 3, 4, 5, 6, 7]),
  ...range('', 30, 'C', [7, 6, 5, 4, 3, 2, 1, 0]),
  38: ['D', 7], 39: ['G', 2], 40: ['G', 1], 41: ['G', 0],
  ...range('', 42, 'L', [7, 6, 5, 4, 3, 2, 1, 0]),
  50: ['B', 3], 51: ['B', 2], 52: ['B', 1], 53: ['B', 0],
  ...range('A', 0, 'F', [0, 1, 2, 3, 4, 5, 6, 7], 0),
  // ponytail: A8-A15 digital only; ADC MUX5 channels not wired up yet
  ...range('A', 8, 'K', [0, 1, 2, 3, 4, 5, 6, 7]),
};

const PORTS: Record<string, AVRPortConfig> = {
  A: portAConfig, B: portBConfig, C: portCConfig, D: portDConfig, E: portEConfig, F: portFConfig,
  G: portGConfig, H: portHConfig, J: portJConfig, K: portKConfig, L: portLConfig,
};

interface Variant {
  flash: number; sram: number; eeprom: number; ports: string[]; pins: PinMap;
  i2c: { sda: string; scl: string }; spi: { sck: string; mosi: string; miso: string };
  // interrupt vector overrides (word addresses)
  vec?: Record<string, number>;
}

const ATMEGA328: Omit<Variant, 'pins'> = {
  flash: 0x8000, sram: 0x800, eeprom: 1024, ports: ['B', 'C', 'D'],
  i2c: { sda: 'A4', scl: 'A5' }, spi: { sck: '13', mosi: '11', miso: '12' },
};

export const AVR_VARIANTS: Record<string, Variant> = {
  'wokwi-arduino-uno': { ...ATMEGA328, pins: UNO_PINS },
  'wokwi-arduino-nano': { ...ATMEGA328, pins: { ...UNO_PINS, A6: ['C', 6, 6], A7: ['C', 7, 7] } },
  'wokwi-arduino-mega': {
    flash: 0x40000, sram: 0x2000, eeprom: 4096, ports: Object.keys(PORTS), pins: MEGA_PINS,
    i2c: { sda: '20', scl: '21' }, spi: { sck: '52', mosi: '51', miso: '50' },
    vec: {
      pcint0: 0x12, pcint1: 0x14, pcint2: 0x16, wdt: 0x18, t2a: 0x1a, t2b: 0x1c, t2ovf: 0x1e,
      t1capt: 0x20, t1a: 0x22, t1b: 0x24, t1c: 0x26, t1ovf: 0x28, t0a: 0x2a, t0b: 0x2c, t0ovf: 0x2e,
      spi: 0x30, rx: 0x32, udre: 0x34, tx: 0x36, adc: 0x3a, ee: 0x3c, twi: 0x4e,
    },
  },
};

const FREQ = 16e6;

export class AVRBoard implements Board {
  readonly vcc = 5;
  readonly pins: string[];
  readonly i2cPins; readonly spiPins;
  onSerial: (data: Uint8Array) => void = () => {};
  private cpu: CPU;
  private portObjs = new Map<string, AVRIOPort>();
  private usart: AVRUSART;
  private adc: AVRADC;
  private rxQueue: number[] = [];
  private i2c = new Map<number, I2CDevice>();
  private spiDevs: SPIDevice[] = [];
  private net?: Netlist;
  private stopped = false;

  constructor(readonly id: string, private type: string, fw: Firmware) {
    const v = AVR_VARIANTS[type];
    if (!v) throw new Error(`Unsupported AVR board ${type}`);
    this.pins = Object.keys(v.pins);
    this.i2cPins = v.i2c; this.spiPins = v.spi;
    const flash = fw.kind === 'hex' ? parseHex(new TextDecoder().decode(fw.data), v.flash) : padTo(fw.data, v.flash);
    const cpu = this.cpu = new CPU(new Uint16Array(flash.buffer), v.sram);
    const vec = v.vec ?? {};
    const o = <T extends object>(cfg: T, m: Record<string, string>): T =>
      Object.fromEntries(Object.entries(cfg).map(([k, val]) => [k, m[k] && vec[m[k]] !== undefined ? vec[m[k]] : val])) as T;

    const pcints = { B: PCINT0, C: PCINT1, D: PCINT2 } as Record<string, typeof PCINT0>;
    for (const p of v.ports) {
      let cfg = PORTS[p];
      if (v.vec) {
        const pc = cfg.pinChange && pcints[p] ? { ...cfg.pinChange, pinChangeInterrupt: p === 'B' ? vec.pcint0 : 0 } : undefined;
        // ponytail: on Mega only PCINT0 (port B) and no INTn external interrupts are mapped
        cfg = { ...cfg, pinChange: p === 'B' ? pc : undefined, externalInterrupts: [] };
      }
      this.portObjs.set(p, new AVRIOPort(cpu, cfg));
    }
    const t = (n: number) => ({ compAInterrupt: `t${n}a`, compBInterrupt: `t${n}b`, compCInterrupt: `t${n}c`, ovfInterrupt: `t${n}ovf`, captureInterrupt: `t${n}capt` });
    let t0 = o(timer0Config, t(0)), t1 = o(timer1Config, t(1)), t2 = o(timer2Config, t(2));
    if (v.vec) {
      const { PORT: B } = portBConfig, { PORT: G } = portGConfig, { PORT: H } = portHConfig;
      t0 = { ...t0, compPortA: B, compPinA: 7, compPortB: G, compPinB: 5 };
      t1 = { ...t1, compPortA: B, compPinA: 5, compPortB: B, compPinB: 6, compPortC: B, compPinC: 7, OCRC: 0x8c, OCFC: 8, OCIEC: 8 };
      t2 = { ...t2, compPortA: B, compPinA: 4, compPortB: H, compPinB: 6 };
    }
    new AVRTimer(cpu, t0); new AVRTimer(cpu, t1); new AVRTimer(cpu, t2);
    const clock = new AVRClock(cpu, FREQ, clockConfig);
    new AVREEPROM(cpu, new EEPROMMemoryBackend(v.eeprom), o(eepromConfig, { eepromReadyInterrupt: 'ee' }));
    new AVRWatchdog(cpu, o(watchdogConfig, { watchdogInterrupt: 'wdt' }), clock);
    this.adc = new AVRADC(cpu, o(adcConfig, { adcInterrupt: 'adc' }));

    this.usart = new AVRUSART(cpu, o(usart0Config, { rxCompleteInterrupt: 'rx', dataRegisterEmptyInterrupt: 'udre', txCompleteInterrupt: 'tx' }), FREQ);
    this.usart.onByteTransmit = (b) => this.onSerial(Uint8Array.of(b));
    this.usart.onRxComplete = () => { if (this.rxQueue.length) this.usart.writeByte(this.rxQueue.shift()!); };

    const twi = new AVRTWI(cpu, o(twiConfig, { twiInterrupt: 'twi' }), FREQ);
    let dev: I2CDevice | undefined;
    const i2c = this.i2c;
    twi.eventHandler = {
      start: () => twi.completeStart(),
      stop: () => { dev?.stop(); dev = undefined; twi.completeStop(); },
      connectToSlave: (addr, write) => { dev = i2c.get(addr); twi.completeConnect(!!dev && dev.connect(write)); },
      writeByte: (b) => twi.completeWrite(dev ? dev.write(b) : false),
      readByte: (ack) => twi.completeRead(dev ? dev.read(ack) : 0xff),
    } satisfies TWIEventHandler;

    const spi = new AVRSPI(cpu, o(spiConfig, { spiInterrupt: 'spi' }), FREQ);
    spi.onByte = (b) => {
      const d = this.spiDevs.find((d) => this.net && this.net.value(d.cs) < 1);
      const r = d ? d.transfer(b) : 0xff;
      cpu.addClockEvent(() => spi.completeTransfer(r), spi.transferCycles);
    };
  }

  nowNs() { return (this.cpu.cycles / FREQ) * 1e9; }

  schedule(fn: () => void, delayNs: number) {
    const cb = () => fn();
    this.cpu.addClockEvent(cb, Math.max(1, Math.round((delayNs * FREQ) / 1e9)));
    return () => { this.cpu.clearClockEvent(cb); };
  }

  run(ms: number) {
    const cpu = this.cpu, end = cpu.cycles + (ms * FREQ) / 1000;
    while (cpu.cycles < end && !this.stopped) { avrInstruction(cpu); cpu.tick(); }
  }

  serialWrite(data: Uint8Array) {
    this.rxQueue.push(...data);
    if (!this.usart.rxBusy && this.rxQueue.length) this.usart.writeByte(this.rxQueue.shift()!);
  }

  addI2C(dev: I2CDevice) { this.i2c.set(dev.address, dev); }
  addSPI(dev: SPIDevice) { this.spiDevs.push(dev); }

  attach(net: Netlist) {
    this.net = net;
    const v = AVR_VARIANTS[this.type];
    net.drive(`${this.id}:GND`, { v: 0, strong: true });
    net.drive(`${this.id}:5V`, { v: 5, strong: true });
    net.drive(`${this.id}:3.3V`, { v: 3.3, strong: true });
    net.drive(`${this.id}:VIN`, { v: 5, strong: true });
    net.drive(`${this.id}:IOREF`, { v: 5, strong: true });
    net.drive(`${this.id}:AREF`, { v: 5, strong: true });
    for (const [name, [p, bit, adc]] of Object.entries(v.pins)) {
      const port = this.portObjs.get(p)!, ep = `${this.id}:${name}`;
      const update = () => {
        const s = port.pinState(bit);
        net.drive(ep, s === PinState.High ? { v: 5, strong: true } : s === PinState.Low ? { v: 0, strong: true }
          : s === PinState.InputPullUp ? { v: 5, strong: false } : null);
      };
      port.addListener(update);
      update();
      net.listen(ep, (volts) => {
        port.setPin(bit, volts > 2.5 || (Number.isNaN(volts) && port.pinState(bit) === PinState.InputPullUp));
        if (adc !== undefined) this.adc.channelValues[adc] = Number.isNaN(volts) ? 0 : volts;
      });
    }
  }

  stop() { this.stopped = true; }
}

function padTo(data: Uint8Array, size: number) {
  const out = new Uint8Array(size);
  out.set(data.subarray(0, size));
  return out;
}
