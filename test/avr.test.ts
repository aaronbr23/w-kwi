// End-to-end smoke test: hand-assembled AVR machine code (no arduino-cli needed) that sets
// DDRB and PORTB bit 5 (Arduino Uno pin 13), run through the real avr8js core + our netlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AVRBoard } from '../src/sim/boards/avr.ts';
import { Netlist } from '../src/sim/netlist.ts';

// LDI r16, 0x20 ; OUT DDRB, r16 ; LDI r16, 0x20 ; OUT PORTB, r16 ; (rest is 0x0000 = NOP)
const program = Uint8Array.of(0x00, 0xe2, 0x04, 0xb9, 0x00, 0xe2, 0x05, 0xb9);

test('AVRBoard runs real machine code and drives pin 13 high through the netlist', () => {
  const board = new AVRBoard('uno', 'wokwi-arduino-uno', { kind: 'bin', data: program });
  const net = new Netlist();
  board.attach(net);
  board.run(1); // 1ms @ 16MHz is thousands of cycles, plenty for 4 instructions
  assert.equal(net.value('uno:13'), 5);
  assert.ok(Number.isNaN(net.value('uno:12'))); // untouched pin stays floating (input, no pull-up)
});
