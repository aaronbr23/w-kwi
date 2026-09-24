// Half-size breadboard, simulated only (no @wokwi/elements graphic exists for this - the visual
// is a custom element in src/web/breadboard-element.ts, kept pin-name-compatible with this file).
// 30 columns x two 5-row terminal strips (a-e / f-j, NOT connected across the center gap), plus
// a top and bottom power rail pair (+/-). No state/timing - just static internal wiring.
import type { PartFactory } from '../sim/types.ts';
import { pin } from './util.ts';

export const COLS = 30;
export const ROWS_TOP = ['a', 'b', 'c', 'd', 'e'];
export const ROWS_BOTTOM = ['f', 'g', 'h', 'i', 'j'];

export const breadboard: PartFactory = (ctx, spec) => {
  for (let c = 1; c <= COLS; c++) {
    // Each strip's 5 holes are one node; the two strips of a column are NOT tied together.
    for (let i = 0; i < ROWS_TOP.length - 1; i++) ctx.net.connect(pin(spec, `${c}${ROWS_TOP[i]}`), pin(spec, `${c}${ROWS_TOP[i + 1]}`));
    for (let i = 0; i < ROWS_BOTTOM.length - 1; i++) ctx.net.connect(pin(spec, `${c}${ROWS_BOTTOM[i]}`), pin(spec, `${c}${ROWS_BOTTOM[i + 1]}`));
  }
  // Rails run the full length of the board.
  for (let c = 1; c < COLS; c++) {
    ctx.net.connect(pin(spec, `tp${c}`), pin(spec, `tp${c + 1}`));
    ctx.net.connect(pin(spec, `tn${c}`), pin(spec, `tn${c + 1}`));
    ctx.net.connect(pin(spec, `bp${c}`), pin(spec, `bp${c + 1}`));
    ctx.net.connect(pin(spec, `bn${c}`), pin(spec, `bn${c + 1}`));
  }
  return {};
};
