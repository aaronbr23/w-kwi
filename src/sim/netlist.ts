// Digital/analog net resolver. Endpoints are "partId:pin".
// Pins named "X.<n>" (all-digit suffix, e.g. GND.1/GND.2) or "X.<word>" (all-letter suffix, e.g.
// a pushbutton's 1.l/1.r) are internally connected to "X" - real @wokwi/elements graphics expose
// both conventions for pins that are electrically the same node brought out to two physical spots.
// Deliberately NOT a blanket "any suffix after the last dot": some real pin names are dotted for
// an unrelated reason and must stay distinct, e.g. Arduino's "3.3V" pin (suffix "3V" is neither
// all-digit nor all-letter, so it doesn't match and is untouched) - verified against every
// `name: '...'` pinInfo entry shipped in node_modules/@wokwi/elements.
// Drive levels: strong (outputs, power) > via resistor > weak (internal pull-ups) > floating (NaN).
// ponytail: full value recompute per change, fine for <1000 endpoints; incremental if large circuits get slow.

export type Drive = { v: number; strong: boolean } | null;
type Listener = (v: number) => void;

const STRONG = 3, RESISTOR = 2, WEAK = 1;

export function key(endpoint: string): string {
  const i = endpoint.indexOf(':');
  return endpoint.slice(0, i) + ':' + endpoint.slice(i + 1).replace(/\.(?:\d+|[a-zA-Z]+)$/, '');
}

export class Netlist {
  private parent = new Map<string, string>();
  private switches: { a: string; b: string; closed: () => boolean }[] = [];
  private resistors: [string, string][] = [];
  private drives = new Map<string, Drive>();
  private listeners = new Map<string, Listener[]>();
  private last = new Map<string, number>();
  private groupOf = new Map<string, string>();
  private values = new Map<string, number>();
  private dirty = true;
  private batching = false;
  short = false;

  private find(k: string): string {
    let p = this.parent.get(k);
    if (p === undefined) { this.parent.set(k, k); this.dirty = true; return k; }
    while (p !== k) { const pp: string = this.parent.get(p)!; this.parent.set(k, pp); k = p; p = pp; }
    return k;
  }

  connect(a: string, b: string) {
    const ra = this.find(key(a)), rb = this.find(key(b));
    if (ra !== rb) this.parent.set(ra, rb);
    this.dirty = true;
  }

  addSwitch(a: string, b: string, closed: () => boolean) {
    this.switches.push({ a: key(a), b: key(b), closed });
    this.find(key(a)); this.find(key(b));
  }

  addResistor(a: string, b: string) {
    this.resistors.push([key(a), key(b)]);
    this.find(key(a)); this.find(key(b));
  }

  /** Call after a switch opened/closed. */
  topologyChanged() { this.dirty = true; this.update(); }

  drive(endpoint: string, d: Drive) {
    const k = key(endpoint);
    const old = this.drives.get(k);
    if (old === d || (old && d && old.v === d.v && old.strong === d.strong)) return;
    this.find(k);
    this.drives.set(k, d);
    this.update();
  }

  listen(endpoint: string, fn: Listener) {
    const k = key(endpoint);
    this.find(k);
    const l = this.listeners.get(k) ?? [];
    l.push(fn);
    this.listeners.set(k, l);
  }

  value(endpoint: string): number {
    if (this.dirty) this.rebuild();
    return this.values.get(this.groupOf.get(key(endpoint)) ?? '') ?? NaN;
  }

  /** Endpoints electrically connected (wires + closed switches) to endpoint. */
  connected(endpoint: string): string[] {
    if (this.dirty) this.rebuild();
    const g = this.groupOf.get(key(endpoint));
    return [...this.groupOf].filter(([, gg]) => gg === g).map(([k]) => k);
  }

  /** Run fn with notifications deferred until the end (e.g. while wiring up a circuit). */
  batch(fn: () => void) {
    this.batching = true;
    try { fn(); } finally { this.batching = false; }
    this.update();
  }

  private rebuild() {
    const sw = new Map<string, string>();
    const f = (k: string): string => { let r = k; while (sw.has(r) && sw.get(r) !== r) r = sw.get(r)!; return r; };
    for (const s of this.switches) {
      if (!s.closed()) continue;
      const ra = f(this.find(s.a)), rb = f(this.find(s.b));
      if (ra !== rb) sw.set(ra, rb);
    }
    this.groupOf.clear();
    for (const k of this.parent.keys()) this.groupOf.set(k, f(this.find(k)));
    this.dirty = false;
    this.compute();
  }

  private compute() {
    const level = new Map<string, number>();
    this.values.clear();
    this.short = false;
    for (const [k, d] of this.drives) {
      if (!d) continue;
      const g = this.groupOf.get(k)!;
      const lv = d.strong ? STRONG : WEAK, cur = level.get(g) ?? 0;
      if (lv > cur) { level.set(g, lv); this.values.set(g, d.v); }
      else if (lv === cur && d.v !== this.values.get(g)) {
        if (lv === STRONG) this.short = true;
        this.values.set(g, Math.min(d.v, this.values.get(g)!)); // low wins
      }
    }
    for (let changed = true, n = 0; changed && n <= this.resistors.length; n++) {
      changed = false;
      for (const [a, b] of this.resistors) {
        const ga = this.groupOf.get(a)!, gb = this.groupOf.get(b)!;
        for (const [from, to] of [[ga, gb], [gb, ga]]) {
          const lf = level.get(from) ?? 0, lt = level.get(to) ?? 0;
          if (lf >= RESISTOR && lt < RESISTOR) {
            level.set(to, RESISTOR); this.values.set(to, this.values.get(from)!); changed = true;
          }
        }
      }
    }
  }

  private update() {
    if (this.batching) return;
    if (this.dirty) this.rebuild(); else this.compute();
    for (const [k, fns] of this.listeners) {
      const v = this.values.get(this.groupOf.get(k)!) ?? NaN;
      const old = this.last.get(k);
      if (old === v || (Number.isNaN(v) && Number.isNaN(old))) continue;
      this.last.set(k, v);
      for (const fn of fns) fn(v);
    }
  }
}
