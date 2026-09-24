import '@wokwi/elements';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

interface DiagramPart { type: string; id: string; top?: number; left?: number; rotate?: number; attrs?: Record<string, string> }
interface Diagram { parts: DiagramPart[]; connections: [string, string, string?][] }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const projectSelect = $<HTMLSelectElement>('project');
const status = $<HTMLElement>('status');
const canvas = $<HTMLElement>('canvas');
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

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
  return res.json();
}

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

function renderCanvas() {
  canvas.innerHTML = '';
  els.clear();
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
    canvas.appendChild(el);
    els.set(spec.id, el);
  }
  connectionsBox.textContent = diagram.connections.map(([a, b]) => `${a} — ${b}`).join('\n');
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

async function selectProject(id: string) {
  if (id !== projectId) flushSave();
  projectId = id;
  projectSelect.value = id;
  diagram = await api<Diagram>(`/projects/${id}/diagram`);
  diagramJson.value = JSON.stringify(diagram, null, 2);
  renderCanvas();
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
  if (!r.ok) alert(r.output);
};
$('start').onclick = async () => { await api(`/projects/${projectId}/start`, { method: 'POST' }); status.textContent = 'running'; };
$('stop').onclick = async () => { await api(`/projects/${projectId}/stop`, { method: 'POST' }); status.textContent = 'stopped'; };
$('edit-diagram').onclick = async () => {
  const editorEl = $('editor'), taEl = diagramJson;
  const showingJson = taEl.style.display === 'block';
  if (showingJson) {
    let parsed: Diagram;
    try { parsed = JSON.parse(taEl.value); }
    catch (e) { alert(`Invalid diagram JSON: ${e instanceof Error ? e.message : e}`); return; }
    diagram = parsed;
    await api(`/projects/${projectId}/diagram`, { method: 'PUT', body: taEl.value });
    renderCanvas();
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

canvas.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('.part') as (HTMLElement & { id: string }) | null;
  if (!el) return;
  const partId = el.id.replace('part-', '');
  if ((el as HTMLElement & { pressed?: boolean }).tagName.toLowerCase().includes('pushbutton'))
    api(`/projects/${projectId}/control`, { method: 'POST', body: JSON.stringify({ partId, name: 'pressed', value: 1 }) })
      .then(() => setTimeout(() => api(`/projects/${projectId}/control`, { method: 'POST', body: JSON.stringify({ partId, name: 'pressed', value: 0 }) }), 150));
});

loadProjects();
