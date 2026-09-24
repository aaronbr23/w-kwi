import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Netlist } from '../src/sim/netlist.ts';
import { pushbutton } from '../src/parts/basic.ts';
import type { DiagramPart, SimContext } from '../src/sim/types.ts';

test('two wired strong drives at the same voltage agree, no short', () => {
  const net = new Netlist();
  net.connect('a:1', 'b:1');
  net.drive('a:1', { v: 5, strong: true });
  net.drive('b:1', { v: 5, strong: true });
  assert.equal(net.value('a:1'), 5);
  assert.equal(net.short, false);
});

test('conflicting strong drives on the same net short', () => {
  const net = new Netlist();
  net.connect('a:1', 'b:1');
  net.drive('a:1', { v: 5, strong: true });
  net.drive('b:1', { v: 0, strong: true });
  assert.equal(net.short, true);
});

test('resistor pull-up: floats to source through resistor, overridden by a strong drive', () => {
  const net = new Netlist();
  net.addResistor('vcc:P', 'node:P');
  net.drive('vcc:P', { v: 5, strong: true });
  assert.equal(net.value('node:P'), 5); // pulled up through resistor
  net.drive('node:P', { v: 0, strong: true }); // e.g. a button pressed to ground
  assert.equal(net.value('node:P'), 0); // strong drive wins over resistor
});

test('closed switch merges nets; open switch isolates them', () => {
  const net = new Netlist();
  let closed = false;
  net.addSwitch('a:1', 'b:1', () => closed);
  net.drive('a:1', { v: 5, strong: true });
  net.drive('b:1', { v: 0, strong: true });
  assert.equal(net.value('a:1'), 5);
  assert.equal(net.value('b:1'), 0);
  closed = true;
  net.topologyChanged();
  // merged net with two conflicting strong drives -> short, low wins per compute()
  assert.equal(net.short, true);
  assert.equal(net.value('a:1'), 0);
});

test('listen fires only on value change', () => {
  const net = new Netlist();
  const seen: number[] = [];
  net.listen('a:1', (v) => seen.push(v));
  net.drive('a:1', { v: 5, strong: true });
  net.drive('a:1', { v: 5, strong: true }); // no-op, same drive
  net.drive('a:1', { v: 0, strong: true });
  assert.deepEqual(seen, [5, 0]);
});

test('pin suffix .N addresses are merged into the base pin (e.g. GND.1, GND.2)', () => {
  const net = new Netlist();
  net.drive('gnd:GND.1', { v: 0, strong: true });
  assert.equal(net.value('gnd:GND.2'), 0);
});

test('pin suffix .word addresses are also merged (e.g. pushbutton 1.l/1.r are the same physical node)', () => {
  const net = new Netlist();
  net.drive('btn1:1.l', { v: 5, strong: true });
  assert.equal(net.value('btn1:1.r'), 5); // .l/.r are two physical pin spots for the SAME node
});

test('the real pushbutton factory: wiring to its real pin names (1.l/2.l/1.r/2.r) is electrically live', () => {
  // This is the exact bug reported: the UI wires up to the REAL @wokwi/elements pinInfo names
  // ("1.l", "2.l", "1.r", "2.r" - "1.l"/"1.r" are always the same node, as are "2.l"/"2.r"; the
  // button's switch is between node "1" and node "2"), but the pushbutton factory drives its
  // switch on plain "1"/"2". Before the key() fix these never tied together and the button did
  // nothing when pressed.
  const net = new Netlist();
  const ctx: SimContext = { net, board: { vcc: 5 } as SimContext['board'], nowNs: () => 0, schedule: () => () => {}, log: () => {} };
  const spec: DiagramPart = { type: 'wokwi-pushbutton', id: 'btn1', attrs: {} };
  const part = pushbutton(ctx, spec);

  net.drive('gnd:GND', { v: 0, strong: true });
  net.connect('gnd:GND', 'btn1:2.l'); // wired via one real, clickable pin name (node "2")

  assert.equal(Number.isNaN(net.value('btn1:1.r')), true); // not pressed -> node "1" floats
  part.control!('pressed', 1);
  assert.equal(net.value('btn1:1.r'), 0); // pressed -> switch ties node "1" to node "2" -> reads GND
  part.control!('pressed', 0);
  assert.equal(Number.isNaN(net.value('btn1:1.r')), true); // released -> isolated again
});

test('a real dotted pin name that is NOT a tie suffix stays its own net (e.g. Arduino "3.3V")', () => {
  const net = new Netlist();
  net.drive('board:3.3V', { v: 3.3, strong: true });
  net.drive('board:3', { v: 0, strong: true }); // an unrelated digital pin literally named "3"
  assert.equal(net.value('board:3.3V'), 3.3);
  assert.equal(net.value('board:3'), 0); // must NOT have merged with "3.3V"
});
