import '@wokwi/elements';
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
  monaco.editor.setModelLanguage(editor.getModel()!, name.endsWith('.json') || name.endsWith('.txt') ? 'plaintext' : 'cpp');
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

async function renderPalette() {
  const types = await api<string[]>('/parts');
  paletteEl.innerHTML = '';
  for (const t of types.filter((t) => !t.startsWith('wokwi-arduino-'))) {
    const label = t.replace(/^wokwi-/, '').split('-').map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = t;
    btn.draggable = true;
    btn.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', t));
    btn.addEventListener('click', () => addPartAt(t, canvas.scrollLeft + canvas.clientWidth / 2, canvas.scrollTop + canvas.clientHeight / 2));
    paletteEl.appendChild(btn);
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
  addPartAt(type, e.clientX - rect.left, e.clientY - rect.top);
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
    try { el = document.createElement(spec.type); }
    catch { continue; } // spec.type isn't a valid tag name (e.g. hand-edited diagram JSON); skip it
    el.className = 'part';
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
    partMeta.set(spec.id, { w: el.offsetWidth, h: el.offsetHeight, pins });
  }
  emptyHint.style.display = diagram.parts.length <= 1 ? 'flex' : 'none';
  renderOverlays();
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
      const dot = document.createElement('div');
      dot.className = 'pin-dot' + (pendingWire?.from === key ? ' active' : '');
      dot.style.left = `${pos.x}px`;
      dot.style.top = `${pos.y}px`;
      dot.title = key;
      dot.addEventListener('click', (e) => { e.stopPropagation(); onPinClick(key, pos); });
      pinsLayer.appendChild(dot);
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
    .catch((e) => showMsg(e instanceof Error ? e.message : String(e), true));
}

canvasInner.addEventListener('pointermove', (e) => {
  if (!pendingWire) return;
  const rect = canvasInner.getBoundingClientRect();
  tempLine.setAttribute('x1', String(pendingWire.pos.x));
  tempLine.setAttribute('y1', String(pendingWire.pos.y));
  tempLine.setAttribute('x2', String(e.clientX - rect.left));
  tempLine.setAttribute('y2', String(e.clientY - rect.top));
  tempWireSvg.style.display = 'block';
});

canvasInner.addEventListener('click', (e) => {
  if (e.target !== canvasInner) return; // a part/pin/wire click already stopPropagation()'d
  let changed = false;
  if (pendingWire) { setPendingWire(null); changed = true; }
  if (selectedPart || selectedWire) { setSelection(null, null); changed = true; }
  if (changed) renderOverlays();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (pendingWire || selectedPart || selectedWire) {
      setPendingWire(null); setSelection(null, null); renderOverlays();
    }
    return;
  }
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // typing elsewhere
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
      spec.top = origTop + dy;
      spec.left = origLeft + dx;
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
        if (el.tagName.toLowerCase().includes('pushbutton')) {
          api(`/projects/${projectId}/control`, { method: 'POST', body: JSON.stringify({ partId: spec.id, name: 'pressed', value: 1 }) })
            .then(() => setTimeout(() => api(`/projects/${projectId}/control`, { method: 'POST', body: JSON.stringify({ partId: spec.id, name: 'pressed', value: 0 }) }), 150))
            .catch(() => { /* no running simulation - ignore */ });
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

async function reloadDiagram() {
  diagram = await api<Diagram>(`/projects/${projectId}/diagram`);
  diagramJson.value = JSON.stringify(diagram, null, 2);
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

renderPalette();
loadProjects();
