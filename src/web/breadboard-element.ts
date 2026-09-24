// Custom element for <circuitlab-breadboard> - there is no @wokwi/elements graphic for this part
// (it doesn't exist upstream), so we render our own cheap grid. Pin names here MUST match
// src/parts/breadboard.ts exactly (that's what wires them up electrically).
const COLS = 30;
const ROWS_TOP = ['a', 'b', 'c', 'd', 'e'];
const ROWS_BOTTOM = ['f', 'g', 'h', 'i', 'j'];
const PITCH = 16, MARGIN = 14;

// Row y-offsets, top to bottom: top rails, gap, top strip (a-e), center gap, bottom strip (f-j), gap, bottom rails.
const Y: Record<string, number> = { tp: 14, tn: 28, a: 50, b: 64, c: 78, d: 92, e: 106, f: 126, g: 140, h: 154, i: 168, j: 182, bp: 204, bn: 218 };
const WIDTH = MARGIN * 2 + (COLS - 1) * PITCH;
const HEIGHT = Y.bn + MARGIN;

const colX = (c: number) => MARGIN + (c - 1) * PITCH;

interface PinInfo { name: string; x: number; y: number; signals: string[] }

export class BreadboardElement extends HTMLElement {
  get pinInfo(): PinInfo[] {
    const pins: PinInfo[] = [];
    for (let c = 1; c <= COLS; c++) {
      const x = colX(c);
      for (const r of [...ROWS_TOP, ...ROWS_BOTTOM]) pins.push({ name: `${c}${r}`, x, y: Y[r], signals: [] });
      for (const rail of ['tp', 'tn', 'bp', 'bn']) pins.push({ name: `${rail}${c}`, x, y: Y[rail], signals: [] });
    }
    return pins;
  }

  connectedCallback() {
    // Synchronous layout (no Lit/updateComplete involved) so offsetWidth/offsetHeight are
    // correct the instant this element is added to the DOM.
    this.style.display = 'block';
    this.style.width = `${WIDTH}px`;
    this.style.height = `${HEIGHT}px`;
    this.innerHTML = this.svg();
  }

  private svg(): string {
    let holes = '';
    for (const p of this.pinInfo) holes += `<circle cx="${p.x}" cy="${p.y}" r="1.3" fill="#2a2a2a" />`;
    const rail = (y: number, color: string) =>
      `<rect x="0" y="${y - 5}" width="${WIDTH}" height="10" fill="${color}" opacity="0.12" />`
      + `<line x1="${MARGIN - 6}" y1="${y}" x2="${WIDTH - MARGIN + 6}" y2="${y}" stroke="${color}" stroke-width="1.5" opacity="0.6" />`;
    return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" style="display:block;background:#ded9c7;border-radius:5px;box-shadow:inset 0 0 0 1px #a89f88;">
      ${rail(Y.tp, '#c0392b')}${rail(Y.tn, '#2464b4')}
      ${rail(Y.bp, '#c0392b')}${rail(Y.bn, '#2464b4')}
      ${holes}
    </svg>`;
  }
}

customElements.define('circuitlab-breadboard', BreadboardElement);
