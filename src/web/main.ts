import '@wokwi/elements';
import './breadboard-element.ts';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

interface DiagramPart { type: string; id: string; top?: number; left?: number; rotate?: number; attrs?: Record<string, string> }
type ConnectionTuple = [string, string, string?];
interface Diagram { parts: DiagramPart[]; connections: ConnectionTuple[] }
interface Point { x: number; y: number }
/** Subset of @wokwi/elements' ElementPin we actually use. */
interface PinInfo { name: string; x: number; y: number }
interface PartMeta { w: number; h: number; pins: PinInfo[] }

const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const projectSelect = $<HTMLSelectElement>('project');
const status = $<HTMLElement>('status');
const msgBox = $<HTMLElement>('msg');
const msgText = $<HTMLElement>('msg-text');
const canvas = $<HTMLElement>('canvas');
const canvasInner = $<HTMLElement>('canvas-inner');
const partsLayer = $<HTMLElement>('parts-layer');
const pinsLayer = $<HTMLElement>('pins-layer');
const wiresSvg = $<HTMLElement>('wires') as unknown as SVGSVGElement;
const tempWireSvg = $<HTMLElement>('temp-wire') as unknown as SVGSVGElement;
const tempLine = $<HTMLElement>('temp-line') as unknown as SVGLineElement;
const toolbar = $<HTMLElement>('toolbar');
const emptyHint = $<HTMLElement>('empty-hint');
const paletteEl = $<HTMLElement>('palette');
const connectionsBox = $<HTMLElement>('connections');
const serialOut = $<HTMLElement>('serial-out');
const diagramJson = $<HTMLTextAreaElement>('diagram-json');
const tabs = $<HTMLElement>('tabs');
const boardSelect = $<HTMLSelectElement>('board-select');
const importInput = $<HTMLInputElement>('import-input');
const zoomInBtn = $<HTMLButtonElement>('zoom-in');
const zoomOutBtn = $<HTMLButtonElement>('zoom-out');
const zoomFitBtn = $<HTMLButtonElement>('zoom-fit');
const zoomLevelEl = $<HTMLElement>('zoom-level');

/** Palette grouping: cheapest correct grouping is to mirror src/parts/catalog.ts's own import
 *  structure (basic.ts/timing.ts/displays.ts/i2c.ts) rather than adding a server round-trip for it. */
const CATEGORIES: { label: string; types: string[] }[] = [
  { label: 'Prototyping', types: ['circuitlab-breadboard'] },
  { label: 'Basic & Switches', types: [
    'wokwi-led', 'wokwi-rgb-led', 'wokwi-resistor', 'wokwi-pushbutton', 'wokwi-pushbutton-6mm',
    'wokwi-slide-switch', 'wokwi-tilt-switch', 'wokwi-dip-switch-8', 'wokwi-potentiometer',
    'wokwi-slide-potentiometer', 'wokwi-analog-joystick', 'wokwi-buzzer', 'wokwi-7segment',
    'wokwi-led-bar-graph', 'wokwi-membrane-keypad', 'wokwi-ky-040', 'wokwi-biaxial-stepper',
    'wokwi-stepper-motor', 'wokwi-relay', 'wokwi-relay-module',
  ] },
  { label: 'Sensors & Actuators', types: [
    'wokwi-photoresistor-sensor', 'wokwi-ntc-temperature-sensor', 'wokwi-gas-sensor', 'wokwi-flame-sensor',
    'wokwi-small-sound-sensor', 'wokwi-big-sound-sensor', 'wokwi-heart-beat-sensor', 'wokwi-pir-motion-sensor',
    'wokwi-servo', 'wokwi-dht22', 'wokwi-hc-sr04', 'wokwi-neopixel', 'wokwi-neopixel-matrix',
    'wokwi-led-ring', 'wokwi-hx711', 'wokwi-ir-receiver',
  ] },
  { label: 'Displays', types: ['wokwi-lcd1602', 'wokwi-lcd2004', 'wokwi-ssd1306', 'wokwi-ili9341'] },
  { label: 'I2C Modules', types: ['wokwi-ds1307', 'wokwi-mpu6050'] },
];

type ControlKind = 'press' | 'toggle' | 'slider' | 'trigger';
interface ControlSpec { name: string; kind: ControlKind; label: string; min?: number; max?: number; step?: number; default?: number; value?: number }
/** Which control()s each part type actually implements (grepped from src/parts/*.ts control(name, …) -
 *  not guessed). Intentionally omits parts with no control() (servo, displays, ds1307, resistor, …). */
const CONTROLS: Record<string, ControlSpec[]> = {
  'wokwi-pushbutton': [{ name: 'pressed', kind: 'press', label: 'Press' }],
  'wokwi-pushbutton-6mm': [{ name: 'pressed', kind: 'press', label: 'Press' }],
  'wokwi-slide-switch': [{ name: 'value', kind: 'toggle', label: 'On' }],
  'wokwi-tilt-switch': [{ name: 'tilted', kind: 'toggle', label: 'Tilted' }],
  'wokwi-dip-switch-8': Array.from({ length: 8 }, (_, i) => ({ name: String(i + 1), kind: 'toggle' as const, label: `${i + 1}` })),
  'wokwi-potentiometer': [{ name: 'value', kind: 'slider', label: 'Value', min: 0, max: 1023, default: 0 }],
  'wokwi-slide-potentiometer': [{ name: 'value', kind: 'slider', label: 'Value', min: 0, max: 1023, default: 0 }],
  'wokwi-analog-joystick': [
    { name: 'x', kind: 'slider', label: 'X', min: -1, max: 1, step: 0.05, default: 0 },
    { name: 'y', kind: 'slider', label: 'Y', min: -1, max: 1, step: 0.05, default: 0 },
    { name: 'pressed', kind: 'toggle', label: 'Press' },
  ],
  'wokwi-photoresistor-sensor': [{ name: 'lux', kind: 'slider', label: 'Lux', min: 0, max: 1000, default: 500 }],
  'wokwi-ntc-temperature-sensor': [{ name: 'temperature', kind: 'slider', label: '°C', min: -20, max: 100, default: 24 }],
  'wokwi-gas-sensor': [{ name: 'ppm', kind: 'slider', label: 'PPM', min: 0, max: 10000, default: 400 }],
  'wokwi-flame-sensor': [{ name: 'intensity', kind: 'slider', label: 'Intensity', min: 0, max: 100, default: 0 }],
  'wokwi-small-sound-sensor': [{ name: 'level', kind: 'slider', label: 'Level', min: 0, max: 100, default: 0 }],
  'wokwi-big-sound-sensor': [{ name: 'level', kind: 'slider', label: 'Level', min: 0, max: 100, default: 0 }],
  'wokwi-heart-beat-sensor': [{ name: 'level', kind: 'slider', label: 'Level', min: 0, max: 100, default: 50 }],
  'wokwi-pir-motion-sensor': [{ name: 'motion', kind: 'toggle', label: 'Motion' }],
  'wokwi-dht22': [
    { name: 'temperature', kind: 'slider', label: '°C', min: -40, max: 80, default: 24 },
    { name: 'humidity', kind: 'slider', label: 'RH%', min: 0, max: 100, default: 40 },
  ],
  'wokwi-hc-sr04': [{ name: 'distance', kind: 'slider', label: 'cm', min: 2, max: 400, default: 400 }],
  'wokwi-hx711': [{ name: 'weight', kind: 'slider', label: 'Weight', min: -1000, max: 1000, default: 0 }],
  'wokwi-ky-040': [
    { name: 'pressed', kind: 'toggle', label: 'Press' },
    { name: 'rotate', kind: 'trigger', label: '⟲ CCW', value: -1 },
    { name: 'rotate', kind: 'trigger', label: '⟳ CW', value: 1 },
  ],
  // KEYS4 layout must match src/parts/basic.ts's `keypad` factory exactly (row-major, 4 cols).
  'wokwi-membrane-keypad': [...'123A456B789C*0#D'].map((k) => ({ name: `key:${k}`, kind: 'press' as const, label: k })),
  'wokwi-mpu6050': [
    { name: 'accelX', kind: 'slider', label: 'AccelX', min: -16, max: 16, step: 0.1, default: 0 },
    { name: 'accelY', kind: 'slider', label: 'AccelY', min: -16, max: 16, step: 0.1, default: 0 },
    { name: 'accelZ', kind: 'slider', label: 'AccelZ', min: -16, max: 16, step: 0.1, default: 1 },
    { name: 'rotationX', kind: 'slider', label: 'GyroX', min: -2000, max: 2000, default: 0 },
    { name: 'rotationY', kind: 'slider', label: 'GyroY', min: -2000, max: 2000, default: 0 },
    { name: 'rotationZ', kind: 'slider', label: 'GyroZ', min: -2000, max: 2000, default: 0 },
    { name: 'temperature', kind: 'slider', label: '°C', min: -40, max: 85, default: 24 },
  ],
};
const controlState = new Map<string, number>();

let projectId = '';
let diagram: Diagram = { parts: [], connections: [] };
let files: string[] = [];
let currentFile = 'sketch/sketch.ino';
let ws: WebSocket | undefined;
const els = new Map<string, HTMLElement>();
const partMeta = new Map<string, PartMeta>();
const pinPositions = new Map<string, Point>();

let selectedPart: string | null = null;
let selectedWire: ConnectionTuple | null = null;
let pendingWire: { from: string; pos: Point } | null = null;
let partCounter = 0;

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
  return res.json();
}

function showMsg(text: string, isError = false) {
  msgText.textContent = text;
  msgBox.className = isError ? 'show' : 'show info';
}
$('msg-close').onclick = () => { msgBox.className = ''; };

const editor = monaco.editor.create($('editor'), { theme: 'vs-dark', language: 'cpp', automaticLayout: true, minimap: { enabled: false } });
let saveTimer: ReturnType<typeof setTimeout>;
let saveDirty = false;
function saveCurrentFile() {
  if (!saveDirty || !projectId) return;
  saveDirty = false;
  api(`/projects/${projectId}/file?name=${encodeURIComponent(currentFile)}`, { method: 'PUT', body: JSON.stringify({ content: editor.getValue() }) })
    .catch((e) => console.error('Save failed:', e));
}
editor.onDidChangeModelContent(() => {
  saveDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentFile, 500);
});
/** Flush a pending debounced save before switching away from the file/project it targets,
 *  otherwise the switch's own setValue() cancels the timer and the edit is lost silently. */
function flushSave() {
  clearTimeout(saveTimer);
  saveCurrentFile();
}

async function loadProjects(): Promise<void> {
  const list = await api<{ id: string; board: string }[]>('/projects');
  // board comes from diagram.json, which a user can edit freely (not restricted to BOARD_TYPES) -
  // build options via the DOM instead of innerHTML so a crafted board name can't inject markup.
  projectSelect.innerHTML = '';
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.id.slice(0, 8)} (${p.board.replace('wokwi-arduino-', '')})`;
    projectSelect.appendChild(opt);
  }
  if (list.length === 0) {
    const { id } = await api<{ id: string }>('/projects', { method: 'POST', body: JSON.stringify({ board: 'wokwi-arduino-uno' }) });
    return loadProjects().then(() => selectProject(id));
  }
  await selectProject(projectSelect.value || list[0].id);
}

async function selectFile(name: string) {
  if (name !== currentFile) flushSave();
  currentFile = name;
  const { content } = await api<{ content: string }>(`/projects/${projectId}/file?name=${encodeURIComponent(name)}`);
  editor.setValue(content);
  const language = name.endsWith('.json') ? 'json' : name.endsWith('.txt') ? 'plaintext' : 'cpp';
  monaco.editor.setModelLanguage(editor.getModel()!, language);
  [...tabs.children].forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.name === name));
}

async function renderTabs() {
  files = await api<string[]>(`/projects/${projectId}/files`);
  tabs.innerHTML = '';
  for (const f of files) {
    const b = document.createElement('button');
    b.textContent = f; b.dataset.name = f;
    b.onclick = () => selectFile(f);
    tabs.appendChild(b);
  }
  await selectFile(files.includes('sketch/sketch.ino') ? 'sketch/sketch.ino' : files[0]);
}

function partLabel(t: string): string {
  return t.replace(/^wokwi-/, '').replace(/^circuitlab-/, '').split('-').map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

function paletteButton(t: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = partLabel(t);
  btn.title = t;
  btn.draggable = true;
  btn.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', t));
  // Diagram-space point currently at the center of the (zoomed/panned) #canvas viewport - see setZoom()'s comment for the screen<->diagram formula this inverts.
  btn.addEventListener('click', () => addPartAt(t, (canvas.clientWidth / 2 - panX) / zoom, (canvas.clientHeight / 2 - panY) / zoom));
  return btn;
}

async function renderPalette() {
  const types = await api<string[]>('/parts');
  // wokwi-breadboard-half/full are import-compatibility aliases for circuitlab-breadboard (see
  // catalog.ts) - hide the duplicates, "Breadboard" already covers picking one from the palette.
  const HIDDEN = new Set(['wokwi-breadboard-half', 'wokwi-breadboard-full']);
  const addable = new Set(types.filter((t) => !t.startsWith('wokwi-arduino-') && !HIDDEN.has(t)));
  paletteEl.innerHTML = '';
  const grouped = new Set<string>();
  for (const { label, types: group } of CATEGORIES) {
    const present = group.filter((t) => addable.has(t));
    present.forEach((t) => grouped.add(t));
    if (present.length === 0) continue;
    const section = document.createElement('div');
    section.className = 'palette-section';
    const h = document.createElement('h4');
    h.textContent = label;
    section.appendChild(h);
    const row = document.createElement('div');
    row.className = 'palette-row';
    for (const t of present) row.appendChild(paletteButton(t));
    section.appendChild(row);
    paletteEl.appendChild(section);
  }
  // Anything the catalog added that isn't in CATEGORIES yet still shows up, just ungrouped.
  const rest = [...addable].filter((t) => !grouped.has(t));
  if (rest.length) {
    const section = document.createElement('div');
    section.className = 'palette-section';
    const h = document.createElement('h4');
    h.textContent = 'Other';
    section.appendChild(h);
    const row = document.createElement('div');
    row.className = 'palette-row';
    for (const t of rest) row.appendChild(paletteButton(t));
    section.appendChild(row);
    paletteEl.appendChild(section);
  }
}

function nextPartId(type: string): string {
  const base = type.replace(/^wokwi-/, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'part';
  let id: string;
  do { id = `${base}-${++partCounter}`; } while (diagram.parts.some((p) => p.id === id));
  return id;
}

async function addPartAt(type: string, left: number, top: number) {
  const id = nextPartId(type);
  try {
    await api(`/projects/${projectId}/parts`, { method: 'POST', body: JSON.stringify({ type, id, top: Math.round(top), left: Math.round(left) }) });
    await reloadDiagram();
  } catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
}

canvasInner.addEventListener('dragover', (e) => e.preventDefault());
canvasInner.addEventListener('drop', (e) => {
  e.preventDefault();
  const type = e.dataTransfer?.getData('text/plain');
  if (!type) return;
  const rect = canvasInner.getBoundingClientRect();
  addPartAt(type, (e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom);
});

/** Viewport: #canvas-inner has no native scroll/zoom (overflow: hidden) - it's positioned purely by
 *  this {zoom, panX, panY} state via a CSS transform. This is what lets diagram-space parts at
 *  negative top/left (real imported Wokwi diagrams have these) become reachable at all: native
 *  scrollLeft/scrollTop can never go negative, so a 0-origin scrollable box can't reach them, but a
 *  translate() has no such floor. transform-origin: 0 0 keeps the math below simple: a diagram-space
 *  point (x, y) lands on screen (relative to #canvas's own top-left) at (panX + zoom*x, panY + zoom*y). */
let zoom = 1, panX = 0, panY = 0;
const ZOOM_MIN = 0.15, ZOOM_MAX = 3;

function applyTransform() {
  canvasInner.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}
function updateZoomReadout() {
  zoomLevelEl.textContent = `${Math.round(zoom * 100)}%`;
}

/** Zoom to a point: screenX/screenY are relative to #canvas's own top-left (NOT canvasInner's -
 *  canvasInner's rect moves/scales with the transform we're about to change). Since
 *  screen = pan + zoom*diagram, the diagram-space point under the cursor is
 *  (screenX - panX) / zoom; solving the same equation for the new zoom with that diagram point
 *  held fixed gives the new pan. */
function setZoom(newZoom: number, screenX: number, screenY: number) {
  newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  const diagramX = (screenX - panX) / zoom;
  const diagramY = (screenY - panY) / zoom;
  zoom = newZoom;
  panX = screenX - diagramX * zoom;
  panY = screenY - diagramY * zoom;
  applyTransform();
  updateZoomReadout();
}
function zoomCentered(factor: number) {
  setZoom(zoom * factor, canvas.clientWidth / 2, canvas.clientHeight / 2);
}

/** Approximate (rotation-unaware - ponytail: a heavily-rotated part's true footprint can exceed
 *  this slightly; add a rotated-corners bbox if that ever visibly clips something) bounding box of
 *  every rendered part, then zoom/pan so the whole thing fits in #canvas with a margin. Clamped to
 *  the same zoom range as wheel-zoom, and to a lower max so a tiny fresh project doesn't zoom in absurdly far. */
function fitToView() {
  const margin = 50;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const spec of diagram.parts) {
    const meta = partMeta.get(spec.id);
    const left = spec.left ?? 0, top = spec.top ?? 0;
    minX = Math.min(minX, left); minY = Math.min(minY, top);
    maxX = Math.max(maxX, left + (meta?.w ?? 0)); maxY = Math.max(maxY, top + (meta?.h ?? 0));
  }
  if (!Number.isFinite(minX)) { minX = minY = maxX = maxY = 0; } // no parts at all
  const bboxW = Math.max(1, maxX - minX), bboxH = Math.max(1, maxY - minY);
  const viewW = Math.max(1, canvas.clientWidth - margin * 2);
  const viewH = Math.max(1, canvas.clientHeight - margin * 2);
  zoom = Math.min(2, Math.max(ZOOM_MIN, Math.min(viewW / bboxW, viewH / bboxH)));
  panX = margin + (viewW - bboxW * zoom) / 2 - minX * zoom;
  panY = margin + (viewH - bboxH * zoom) / 2 - minY * zoom;
  applyTransform();
  updateZoomReadout();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  setZoom(zoom * Math.exp(-e.deltaY * 0.001), e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });
zoomInBtn.onclick = () => zoomCentered(1.25);
zoomOutBtn.onclick = () => zoomCentered(1 / 1.25);
zoomFitBtn.onclick = () => fitToView();

/** Click-drag on empty canvas background (not a part/pin/wire/toolbar - those are all separate
 *  elements and never equal e.target here) pans the view. Same click-vs-drag threshold pattern as
 *  attachDrag()'s part dragging, so a real drag doesn't also fire the deselect click below. */
function handleEmptyClick() {
  let changed = false;
  if (pendingWire) { setPendingWire(null); changed = true; }
  if (selectedPart || selectedWire) { setSelection(null, null); changed = true; }
  if (changed) renderOverlays();
}
let panDrag: { startX: number; startY: number; startPanX: number; startPanY: number; moved: boolean } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.target !== canvas && e.target !== canvasInner) return;
  panDrag = { startX: e.clientX, startY: e.clientY, startPanX: panX, startPanY: panY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!panDrag) return;
  const dx = e.clientX - panDrag.startX, dy = e.clientY - panDrag.startY;
  if (!panDrag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) panDrag.moved = true;
  if (!panDrag.moved) return;
  panX = panDrag.startPanX + dx;
  panY = panDrag.startPanY + dy;
  applyTransform();
});
canvas.addEventListener('pointerup', (e) => {
  if (!panDrag) return;
  const moved = panDrag.moved;
  panDrag = null;
  canvas.releasePointerCapture(e.pointerId);
  if (!moved) handleEmptyClick();
});

/** Rotate a point (relative to an element's own center) by the element's `rotate` degrees,
 *  matching the CSS `transform: rotate()` applied to it (which rotates around its own center). */
function computePinPos(spec: DiagramPart, meta: PartMeta, p: Point): Point {
  const rad = ((spec.rotate ?? 0) * Math.PI) / 180;
  const dx = p.x - meta.w / 2, dy = p.y - meta.h / 2;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  return { x: (spec.left ?? 0) + meta.w / 2 + rx, y: (spec.top ?? 0) + meta.h / 2 + ry };
}

/** Full rebuild: recreates part elements (and re-measures their size/pinInfo). Needed whenever
 *  the *set* of parts changes (add/remove/project load) - not for plain moves/rotates. */
async function renderAll() {
  partsLayer.innerHTML = '';
  els.clear();
  partMeta.clear();
  const created: HTMLElement[] = [];
  for (const spec of diagram.parts) {
    let el: HTMLElement;
    try { el = document.createElement(spec.type === 'wokwi-text' ? 'div' : spec.type); }
    catch { continue; } // spec.type isn't a valid tag name (e.g. hand-edited diagram JSON); skip it
    el.className = 'part';
    if (spec.type === 'wokwi-text') {
      // Cosmetic diagram annotation, not an unrecognized part - show its actual label text (with
      // line breaks preserved), not the type string, and don't flag it as "unknown"/zero-pin.
      el.classList.add('part-text');
      el.style.whiteSpace = 'pre';
      el.textContent = spec.attrs?.text ?? '';
    } else if (!customElements.get(spec.type)) {
      // Unknown type (e.g. imported from a real Wokwi project using a part we don't have a
      // graphic/model for) would otherwise render as an invisible 0x0 element - show it as a
      // visible placeholder instead so it's at least not silently missing from the canvas.
      el.classList.add('part-unknown');
      el.textContent = spec.type;
      el.title = `Unsupported part type "${spec.type}" - not in the catalog, can't be simulated or wired.`;
    }
    el.style.top = `${spec.top ?? 0}px`;
    el.style.left = `${spec.left ?? 0}px`;
    if (spec.rotate) el.style.transform = `rotate(${spec.rotate}deg)`;
    for (const [k, v] of Object.entries(spec.attrs ?? {})) {
      try { (el as unknown as Record<string, unknown>)[k] = v; } catch { /* read-only prop */ }
      el.setAttribute(k, v);
    }
    (el as HTMLElement & { id: string }).id = `part-${spec.id}`;
    partsLayer.appendChild(el);
    els.set(spec.id, el);
    created.push(el);
    attachDrag(el, spec);
  }
  // Custom elements (@wokwi/elements are LitElement-based) upgrade/render asynchronously;
  // wait so offsetWidth/offsetHeight and pinInfo reflect the real rendered size, not 0.
  await Promise.all(created.map((el) => (el as unknown as { updateComplete?: Promise<unknown> }).updateComplete ?? Promise.resolve()));
  for (const spec of diagram.parts) {
    const el = els.get(spec.id);
    if (!el) continue;
    const pins = (el as unknown as { pinInfo?: PinInfo[] }).pinInfo ?? [];
    // wokwi-text is a cosmetic label - it's SUPPOSED to have zero pins, not a warning-worthy surprise.
    if (pins.length === 0 && spec.type !== 'wokwi-text') console.warn(`Part "${spec.id}" (${spec.type}) rendered with zero pins - wiring won't be clickable for it.`);
    partMeta.set(spec.id, { w: el.offsetWidth, h: el.offsetHeight, pins });
  }
  emptyHint.style.display = diagram.parts.length <= 1 ? 'flex' : 'none';
  renderOverlays();
  fitToView(); // renderAll() only runs on a full diagram load/reload (reloadDiagram/selectProject/edit-diagram apply) - exactly when re-fitting the view makes sense.
}

/** Cheap synchronous redraw of pin dots, wires, selection outline and the toolbar - safe to
 *  call on every pointermove while dragging a part, since it never touches the DOM elements
 *  created in renderAll() nor re-measures anything. */
function renderOverlays() {
  pinsLayer.innerHTML = '';
  pinPositions.clear();
  for (const spec of diagram.parts) {
    const el = els.get(spec.id);
    if (el) el.classList.toggle('selected', spec.id === selectedPart);
    const meta = partMeta.get(spec.id);
    if (!meta) continue;
    for (const p of meta.pins) {
      const pos = computePinPos(spec, meta, p);
      const key = `${spec.id}:${p.name}`;
      pinPositions.set(key, pos);
      // Bigger invisible hit target + smaller visible dot inside it, same pattern as wires'
      // fat invisible hit-line + thin visible line - pins are a small, easy-to-miss click target otherwise.
      const hit = document.createElement('div');
      hit.className = 'pin-hit';
      hit.style.left = `${pos.x}px`;
      hit.style.top = `${pos.y}px`;
      hit.title = key;
      const dot = document.createElement('div');
      dot.className = 'pin-dot' + (pendingWire?.from === key ? ' active' : '');
      hit.appendChild(dot);
      hit.addEventListener('click', (e) => { e.stopPropagation(); onPinClick(key, pos); });
      pinsLayer.appendChild(hit);
    }
  }

  while (wiresSvg.firstChild) wiresSvg.removeChild(wiresSvg.firstChild);
  for (const conn of diagram.connections) {
    const [a, b, color] = conn;
    const pa = pinPositions.get(a), pb = pinPositions.get(b);
    if (!pa || !pb) continue; // dangling reference to a pin that no longer exists
    const isSel = !!selectedWire && selectedWire[0] === a && selectedWire[1] === b;
    const g = document.createElementNS(SVG_NS, 'g');
    const hit = document.createElementNS(SVG_NS, 'line');
    hit.setAttribute('x1', String(pa.x)); hit.setAttribute('y1', String(pa.y));
    hit.setAttribute('x2', String(pb.x)); hit.setAttribute('y2', String(pb.y));
    hit.setAttribute('stroke', 'transparent'); hit.setAttribute('stroke-width', '10');
    hit.style.pointerEvents = 'stroke'; hit.style.cursor = 'pointer';
    const vis = document.createElementNS(SVG_NS, 'line');
    vis.setAttribute('x1', String(pa.x)); vis.setAttribute('y1', String(pa.y));
    vis.setAttribute('x2', String(pb.x)); vis.setAttribute('y2', String(pb.y));
    vis.setAttribute('stroke', isSel ? '#4da3ff' : (color || '#4a4'));
    vis.setAttribute('stroke-width', isSel ? '3' : '2');
    g.appendChild(hit); g.appendChild(vis);
    g.addEventListener('click', (e) => { e.stopPropagation(); setSelection(null, [a, b, color]); renderOverlays(); });
    wiresSvg.appendChild(g);
  }
  connectionsBox.textContent = diagram.connections.map(([a, b]) => `${a} — ${b}`).join('\n');
  updateToolbar();
}

/** POST a control value; silently ignored if no simulation is running (same as the old pushbutton-only code did). */
function sendControl(partId: string, name: string, value: number) {
  return api(`/projects/${projectId}/control`, { method: 'POST', body: JSON.stringify({ partId, name, value }) }).catch(() => {});
}

function controlStateKey(partId: string, ctrl: ControlSpec) { return `${partId}:${ctrl.name}:${ctrl.label}`; }

/** Renders one control (button/toggle/slider) for the selection toolbar. Value tracking is purely
 *  client-side (there's no generic "read a control's current value" API) - it reflects what this
 *  UI itself has sent, not necessarily ground truth if driven from elsewhere (e.g. MCP). */
function controlWidget(partId: string, ctrl: ControlSpec): HTMLElement {
  const key = controlStateKey(partId, ctrl);
  if (ctrl.kind === 'press') {
    const btn = document.createElement('button');
    btn.textContent = ctrl.label;
    btn.onclick = () => { sendControl(partId, ctrl.name, 1); setTimeout(() => sendControl(partId, ctrl.name, 0), 150); };
    return btn;
  }
  if (ctrl.kind === 'trigger') {
    const btn = document.createElement('button');
    btn.textContent = ctrl.label;
    btn.onclick = () => sendControl(partId, ctrl.name, ctrl.value ?? 1);
    return btn;
  }
  if (ctrl.kind === 'toggle') {
    const on = !!(controlState.get(key) ?? 0);
    const btn = document.createElement('button');
    btn.textContent = `${ctrl.label}: ${on ? 'On' : 'Off'}`;
    btn.classList.toggle('active', on);
    btn.onclick = () => { const v = on ? 0 : 1; controlState.set(key, v); sendControl(partId, ctrl.name, v); updateToolbar(); };
    return btn;
  }
  // slider
  if (!controlState.has(key)) controlState.set(key, ctrl.default ?? 0);
  const wrap = document.createElement('label');
  wrap.className = 'ctrl-slider';
  const span = document.createElement('span');
  const v = controlState.get(key)!;
  span.textContent = `${ctrl.label} ${v}`;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(ctrl.min ?? 0);
  input.max = String(ctrl.max ?? 100);
  input.step = String(ctrl.step ?? 1);
  input.value = String(v);
  input.oninput = () => {
    const nv = Number(input.value);
    controlState.set(key, nv);
    span.textContent = `${ctrl.label} ${nv}`;
    sendControl(partId, ctrl.name, nv);
  };
  wrap.appendChild(span);
  wrap.appendChild(input);
  return wrap;
}

function updateToolbar() {
  toolbar.innerHTML = '';
  if (selectedPart) {
    const spec = diagram.parts.find((p) => p.id === selectedPart);
    if (!spec) { toolbar.style.display = 'none'; return; }
    toolbar.style.display = 'flex';
    toolbar.style.left = `${spec.left ?? 0}px`;
    toolbar.style.top = `${spec.top ?? 0}px`;
    const rotateBtn = document.createElement('button');
    rotateBtn.textContent = '⟳ Rotate';
    rotateBtn.onclick = () => rotateSelected();
    toolbar.appendChild(rotateBtn);
    if (selectedPart !== 'board') {
      const delBtn = document.createElement('button');
      delBtn.textContent = '✕ Delete';
      delBtn.onclick = () => deleteSelectedPart();
      toolbar.appendChild(delBtn);
    }
    for (const ctrl of CONTROLS[spec.type] ?? []) toolbar.appendChild(controlWidget(spec.id, ctrl));
  } else if (selectedWire) {
    const [a, b] = selectedWire;
    const pa = pinPositions.get(a), pb = pinPositions.get(b);
    toolbar.style.display = 'flex';
    toolbar.style.left = `${pa && pb ? (pa.x + pb.x) / 2 : 0}px`;
    toolbar.style.top = `${pa && pb ? (pa.y + pb.y) / 2 : 0}px`;
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕ Delete wire';
    delBtn.onclick = () => deleteSelectedWire();
    toolbar.appendChild(delBtn);
  } else {
    toolbar.style.display = 'none';
  }
}

function setSelection(part: string | null, wire: ConnectionTuple | null) {
  selectedPart = part;
  selectedWire = wire;
}

function setPendingWire(v: { from: string; pos: Point } | null) {
  pendingWire = v;
  if (!v) tempWireSvg.style.display = 'none';
}

function selectPart(id: string) {
  setSelection(id, null);
  setPendingWire(null);
  renderOverlays();
}

function onPinClick(key: string, pos: Point) {
  if (!pendingWire) {
    setPendingWire({ from: key, pos });
    renderOverlays();
    return;
  }
  if (pendingWire.from === key) { setPendingWire(null); renderOverlays(); return; }
  if (pendingWire.from.split(':')[0] === key.split(':')[0]) {
    showMsg('Cannot wire a part to itself', true);
    setPendingWire(null);
    renderOverlays();
    return;
  }
  const from = pendingWire.from, to = key;
  setPendingWire(null);
  renderOverlays();
  api(`/projects/${projectId}/connections`, { method: 'POST', body: JSON.stringify({ from, to }) })
    .then(reloadDiagram)
    .catch((e) => { console.error('Failed to create wire', from, '->', to, e); showMsg(e instanceof Error ? e.message : String(e), true); });
}

canvasInner.addEventListener('pointermove', (e) => {
  if (!pendingWire) return;
  const rect = canvasInner.getBoundingClientRect();
  tempLine.setAttribute('x1', String(pendingWire.pos.x));
  tempLine.setAttribute('y1', String(pendingWire.pos.y));
  tempLine.setAttribute('x2', String((e.clientX - rect.left) / zoom));
  tempLine.setAttribute('y2', String((e.clientY - rect.top) / zoom));
  tempWireSvg.style.display = 'block';
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (pendingWire || selectedPart || selectedWire) {
      setPendingWire(null); setSelection(null, null); renderOverlays();
    }
    return;
  }
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // typing elsewhere
  if (!e.ctrlKey && !e.metaKey) { // don't hijack the browser's own ctrl/cmd +/-/0 page zoom
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCentered(1.25); return; }
    if (e.key === '-') { e.preventDefault(); zoomCentered(1 / 1.25); return; }
    if (e.key === '0') { e.preventDefault(); fitToView(); return; }
  }
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (selectedPart && selectedPart !== 'board') { e.preventDefault(); deleteSelectedPart(); }
  else if (selectedWire) { e.preventDefault(); deleteSelectedWire(); }
});

async function rotateSelected() {
  if (!selectedPart) return;
  const spec = diagram.parts.find((p) => p.id === selectedPart);
  if (!spec) return;
  spec.rotate = ((spec.rotate ?? 0) + 90) % 360;
  const el = els.get(selectedPart);
  if (el) el.style.transform = spec.rotate ? `rotate(${spec.rotate}deg)` : '';
  renderOverlays();
  try { await api(`/projects/${projectId}/parts/${selectedPart}`, { method: 'PATCH', body: JSON.stringify({ rotate: spec.rotate }) }); }
  catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
}

async function deleteSelectedPart() {
  if (!selectedPart || selectedPart === 'board') return;
  const id = selectedPart;
  setSelection(null, null);
  try { await api(`/projects/${projectId}/parts/${id}`, { method: 'DELETE' }); await reloadDiagram(); }
  catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
}

async function deleteSelectedWire() {
  if (!selectedWire) return;
  const [from, to] = selectedWire;
  setSelection(null, null);
  try { await api(`/projects/${projectId}/connections`, { method: 'DELETE', body: JSON.stringify({ from, to }) }); await reloadDiagram(); }
  catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
}

function attachDrag(el: HTMLElement, spec: DiagramPart) {
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const origTop = spec.top ?? 0, origLeft = spec.left ?? 0;
    let moved = false;
    el.classList.add('dragging');
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true;
      if (!moved) return;
      // Screen-pixel delta -> diagram-space delta: divide out the current zoom, otherwise a
      // dragged part moves faster/slower than the cursor whenever zoom != 1.
      spec.top = origTop + dy / zoom;
      spec.left = origLeft + dx / zoom;
      el.style.top = `${spec.top}px`;
      el.style.left = `${spec.left}px`;
      renderOverlays();
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.classList.remove('dragging');
      if (moved) {
        api(`/projects/${projectId}/parts/${spec.id}`, { method: 'PATCH', body: JSON.stringify({ top: spec.top, left: spec.left }) })
          .catch((err) => showMsg(err instanceof Error ? err.message : String(err), true));
      } else {
        selectPart(spec.id);
        // Click-to-press on the part itself, but only when it has exactly ONE control and it's a
        // momentary press (pushbutton) - unambiguous. Multi-control parts (keypad, ky-040, …) only
        // expose their controls via the selection toolbar, since clicking the part body is ambiguous there.
        const ctrls = CONTROLS[spec.type] ?? [];
        if (ctrls.length === 1 && ctrls[0].kind === 'press') {
          sendControl(spec.id, ctrls[0].name, 1);
          setTimeout(() => sendControl(spec.id, ctrls[0].name, 0), 150);
        }
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp, { once: true });
    el.addEventListener('pointercancel', onUp, { once: true });
  });
}

function applyState(id: string, state: Record<string, unknown>) {
  const el = els.get(id) as (HTMLElement & Record<string, unknown>) | undefined;
  if (!el) return;
  if ('bitmap' in state) { applySSD1306(el, state as { bitmap: string; width: number; height: number }); return; }
  if ('rgb565' in state) { applyILI9341(el, state as { rgb565: string; width: number; height: number }); return; }
  Object.assign(el, state);
}

function applySSD1306(el: HTMLElement & Record<string, unknown>, s: { bitmap: string; width: number; height: number }) {
  const bytes = Uint8Array.from(atob(s.bitmap), (c) => c.charCodeAt(0));
  const img = new ImageData(s.width, s.height);
  for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
    const on = !!(bytes[(y * s.width + x) >> 3] & (0x80 >> (x & 7))), o = (y * s.width + x) * 4;
    img.data[o] = on ? 0x9f : 0; img.data[o + 1] = on ? 0xef : 0; img.data[o + 2] = on ? 0xff : 0; img.data[o + 3] = 255;
  }
  el.imageData = img;
}

function applyILI9341(el: HTMLElement & Record<string, unknown>, s: { rgb565: string; width: number; height: number }) {
  const canvasEl = el.canvas as HTMLCanvasElement | undefined;
  if (!canvasEl) return;
  const bytes = Uint8Array.from(atob(s.rgb565), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const img = new ImageData(s.width, s.height);
  for (let i = 0; i < s.width * s.height; i++) {
    const p = view.getUint16(i * 2, true), o = i * 4;
    img.data[o] = ((p >> 11) & 0x1f) << 3; img.data[o + 1] = ((p >> 5) & 0x3f) << 2; img.data[o + 2] = (p & 0x1f) << 3; img.data[o + 3] = 255;
  }
  canvasEl.getContext('2d')?.putImageData(img, 0, 0);
}

function connectWS() {
  ws?.close();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${projectId}`);
  ws.onmessage = (e) => {
    let msg: { type: string; states?: Record<string, Record<string, unknown>>; text?: string };
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'state') for (const [id, state] of Object.entries(msg.states ?? {})) applyState(id, state);
    if (msg.type === 'serial') { serialOut.textContent += msg.text; serialOut.scrollTop = serialOut.scrollHeight; }
  };
}

/** Reflects the diagram's actual board part in the "Board:" select, best-effort (a hand-edited
 *  diagram.json could reference a board type not in this dropdown's option list - then it just
 *  shows nothing selected, which is an acceptable edge case). */
function syncBoardSelect() {
  const board = diagram.parts.find((p) => p.id === 'board')?.type;
  if (board) boardSelect.value = board;
}

async function reloadDiagram() {
  diagram = await api<Diagram>(`/projects/${projectId}/diagram`);
  diagramJson.value = JSON.stringify(diagram, null, 2);
  syncBoardSelect();
  await renderAll();
}

async function selectProject(id: string) {
  if (id !== projectId) flushSave();
  projectId = id;
  projectSelect.value = id;
  setSelection(null, null);
  setPendingWire(null);
  diagram = await api<Diagram>(`/projects/${id}/diagram`);
  diagramJson.value = JSON.stringify(diagram, null, 2);
  syncBoardSelect();
  await renderAll();
  await renderTabs();
  connectWS();
  status.textContent = '';
}

projectSelect.onchange = () => selectProject(projectSelect.value);
$('new-project').onclick = async () => {
  const board = $<HTMLSelectElement>('new-board').value;
  const { id } = await api<{ id: string }>('/projects', { method: 'POST', body: JSON.stringify({ board }) });
  await loadProjects();
  await selectProject(id);
};
$('compile').onclick = async () => {
  status.textContent = 'compiling…';
  const r = await api<{ ok: boolean; output: string }>(`/projects/${projectId}/compile`, { method: 'POST' });
  status.textContent = r.ok ? 'compiled ✓' : 'compile failed';
  if (!r.ok) showMsg(r.output, true);
};
$('start').onclick = async () => { await api(`/projects/${projectId}/start`, { method: 'POST' }); status.textContent = 'running'; };
$('stop').onclick = async () => { await api(`/projects/${projectId}/stop`, { method: 'POST' }); status.textContent = 'stopped'; };
$('edit-diagram').onclick = async () => {
  const editorEl = $('editor'), taEl = diagramJson;
  const showingJson = taEl.style.display === 'block';
  if (showingJson) {
    let parsed: Diagram;
    try { parsed = JSON.parse(taEl.value); }
    catch (e) { showMsg(`Invalid diagram JSON: ${e instanceof Error ? e.message : e}`, true); return; }
    diagram = parsed;
    await api(`/projects/${projectId}/diagram`, { method: 'PUT', body: taEl.value });
    await renderAll();
  }
  taEl.style.display = showingJson ? 'none' : 'block';
  editorEl.style.display = showingJson ? 'block' : 'none';
};
$<HTMLInputElement>('serial-input').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target as HTMLInputElement;
  await api(`/projects/${projectId}/serial`, { method: 'POST', body: JSON.stringify({ text: input.value + '\n' }) });
  input.value = '';
});

// Switch the CURRENT project's board (distinct from #new-board, which only affects "New").
boardSelect.onchange = async () => {
  const board = boardSelect.value;
  try {
    await api(`/projects/${projectId}/board`, { method: 'PATCH', body: JSON.stringify({ board }) });
    status.textContent = 'board switched';
    await reloadDiagram(); // board part's type changed -> re-render with the new graphic/pins
    const opt = [...projectSelect.options].find((o) => o.value === projectId);
    if (opt) opt.textContent = `${projectId.slice(0, 8)} (${board.replace('wokwi-arduino-', '')})`;
  } catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); syncBoardSelect(); }
};

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? ''); // strip the "data:...;base64," prefix
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

$('import-project').onclick = () => importInput.click();
importInput.onchange = async () => {
  const fileList = [...(importInput.files ?? [])];
  importInput.value = ''; // allow re-selecting the same file(s) later
  if (fileList.length === 0) return;
  try {
    let payload: { files?: Record<string, string>; zip?: string };
    if (fileList.length === 1 && fileList[0].name.toLowerCase().endsWith('.zip')) {
      payload = { zip: await readFileAsBase64(fileList[0]) };
    } else {
      const files: Record<string, string> = {};
      for (const f of fileList) files[f.name] = await readFileAsText(f);
      payload = { files };
    }
    const { id } = await api<{ id: string }>('/projects/import', { method: 'POST', body: JSON.stringify(payload) });
    await loadProjects();
    await selectProject(id);
    showMsg(`Imported as project ${id.slice(0, 8)}`);
  } catch (e) { console.error('Import failed', e); showMsg(e instanceof Error ? e.message : String(e), true); }
};

renderPalette();
loadProjects();
