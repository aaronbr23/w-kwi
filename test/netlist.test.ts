import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Netlist } from '../src/sim/netlist.ts';

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
