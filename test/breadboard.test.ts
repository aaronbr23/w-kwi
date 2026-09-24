import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Netlist } from '../src/sim/netlist.ts';
import { breadboard } from '../src/parts/breadboard.ts';
import type { DiagramPart, SimContext } from '../src/sim/types.ts';

function makeCtx(net: Netlist): SimContext {
  return {
    net,
    board: { vcc: 5 } as SimContext['board'],
    nowNs: () => 0,
    schedule: () => () => {},
    log: () => {},
  };
}

test('breadboard: same strip is one node, across the center gap is not', () => {
  const net = new Netlist();
  const spec: DiagramPart = { type: 'circuitlab-breadboard', id: 'bb', attrs: {} };
  breadboard(makeCtx(net), spec);

  net.drive('bb:5a', { v: 5, strong: true });
  assert.equal(net.value('bb:5c'), 5); // same column, same (top) strip -> tied together
  assert.equal(Number.isNaN(net.value('bb:5f')), true); // same column, other side of the center gap -> not tied

  net.drive('bb:5f', { v: 3.3, strong: true });
  assert.equal(net.value('bb:5j'), 3.3); // bottom strip is its own node
  assert.equal(net.value('bb:5a'), 5); // unaffected by the bottom strip drive

  // A different column's strip is a separate node.
  net.drive('bb:6a', { v: 0, strong: true });
  assert.equal(net.value('bb:5a'), 5);
  assert.equal(net.value('bb:6a'), 0);
});

test('breadboard: power rails (dot-suffixed, tied via netlist.ts key()) run the full length of the board', () => {
  const net = new Netlist();
  const spec: DiagramPart = { type: 'circuitlab-breadboard', id: 'bb', attrs: {} };
  breadboard(makeCtx(net), spec);

  net.drive('bb:tp.1', { v: 5, strong: true });
  assert.equal(net.value('bb:tp.35'), 5); // + rail tied end to end (real diagram uses holes up to 50)
  assert.equal(net.value('bb:tp.50'), 5);
  assert.equal(Number.isNaN(net.value('bb:tn.1')), true); // - rail is a separate node

  net.drive('bb:bn.1', { v: 0, strong: true });
  assert.equal(net.value('bb:bn.50'), 0);
  assert.equal(Number.isNaN(net.value('bb:bp.1')), true); // rails don't cross-connect to each other
});
