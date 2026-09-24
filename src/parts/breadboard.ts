// Full-size breadboard, simulated only (no @wokwi/elements graphic exists for this part at all -
// the visual is a custom element in src/web/breadboard-element.ts, kept pin-name-compatible with
// this file). 50 columns x two 5-row terminal strips (a-e / f-j, NOT connected across the center
// gap), plus a top and bottom power rail pair (+/-). No state/timing - just static internal wiring.
//
// Rail pin naming (tp.1..tp.50, tn.1..tn.50, bp.1..bp.50, bn.1..bn.50) is VERIFIED against a real
// Wokwi diagram.json export's connections (e.g. "bb1:tp.1", "bb1:tp.35", "bb1:tp.49", "bb1:tp.50"
// all wired to what's meant to be one top-positive-rail net). Because these use the dot-numeric
// tie-suffix convention netlist.ts's key() already merges (see netlist.ts's comment), no explicit
// connect() is needed to tie a rail together - they collapse to one net key ("tp", "tn", ...) purely
// from their names, the same way a board's GND.1/GND.2 pins already did before this file existed.
//
// Terminal-strip hole naming (`${col}${row}`, e.g. "5a") is NOT verified against any real
// @wokwi/elements graphic - none exists for this part to check against - it's our own reasonable
// inference, carried over unchanged from the original half-size implementation.
import type { PartFactory } from '../sim/types.ts';
import { pin } from './util.ts';

export const COLS = 50;
export const ROWS_TOP = ['a', 'b', 'c', 'd', 'e'];
export const ROWS_BOTTOM = ['f', 'g', 'h', 'i', 'j'];
export const RAILS = ['tp', 'tn', 'bp', 'bn'];

export const breadboard: PartFactory = (ctx, spec) => {
  for (let c = 1; c <= COLS; c++) {
    // Each strip's 5 holes are one node; the two strips of a column are NOT tied together.
    for (let i = 0; i < ROWS_TOP.length - 1; i++) ctx.net.connect(pin(spec, `${c}${ROWS_TOP[i]}`), pin(spec, `${c}${ROWS_TOP[i + 1]}`));
    for (let i = 0; i < ROWS_BOTTOM.length - 1; i++) ctx.net.connect(pin(spec, `${c}${ROWS_BOTTOM[i]}`), pin(spec, `${c}${ROWS_BOTTOM[i + 1]}`));
  }
  return {};
};
