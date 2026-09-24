// MCP tools: same operations the HTTP API exposes, for Claude (or any MCP client) to drive CircuitLab directly.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as core from './core.ts';
import { Session } from '../sim/session.ts';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2));
const err = (e: unknown): CallToolResult => ({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] });

async function guard(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try { return await fn(); } catch (e) { return err(e); }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'circuitlab', version: '0.1.0' });
  const tool = server.registerTool.bind(server);

  tool('list_projects', { description: 'List all projects (id, board type).' }, () => guard(async () => json(await core.store.listProjects())));

  tool('create_project', {
    description: `Create a new project with a default Blink sketch. Boards: ${core.listPartTypes().filter((t) => t.startsWith('wokwi-arduino')).join(', ')}`,
    inputSchema: { board: z.string().describe('Board type, e.g. wokwi-arduino-uno') },
  }, ({ board }) => guard(async () => text(await core.store.createProject(board))));

  tool('delete_project', { inputSchema: { id: z.string() } }, ({ id }) => guard(async () => { core.stopSimulation(id); await core.store.deleteProject(id); return text('deleted'); }));

  tool('list_files', { inputSchema: { id: z.string() } }, ({ id }) => guard(async () => json(await core.store.listFiles(id))));
  tool('read_file', { inputSchema: { id: z.string(), name: z.string() } }, ({ id, name }) => guard(async () => text(await core.store.readFile(id, name))));
  tool('write_file', { inputSchema: { id: z.string(), name: z.string(), content: z.string() } },
    ({ id, name, content }) => guard(async () => { await core.store.writeFile(id, name, content); return text('written'); }));
  tool('delete_file', { inputSchema: { id: z.string(), name: z.string() } }, ({ id, name }) => guard(async () => { await core.store.deleteFile(id, name); return text('deleted'); }));

  tool('list_parts', { description: 'Catalog of all part/board types that can be used with add_part or create_project.' },
    () => guard(async () => json(core.listPartTypes())));
  tool('get_diagram', { inputSchema: { id: z.string() } }, ({ id }) => guard(async () => json(await core.store.getDiagram(id))));
  tool('add_part', {
    description: 'Add a part to the diagram. See list_parts for valid types.',
    inputSchema: {
      id: z.string(), type: z.string(), partId: z.string().describe('Unique id for this part instance, used in connect/set_control/etc.'),
      top: z.number().optional(), left: z.number().optional(), rotate: z.number().optional(), attrs: z.record(z.string(), z.string()).optional(),
    },
  }, ({ id, partId, ...part }) => guard(async () => { await core.addPart(id, { ...part, id: partId }); return text('added'); }));
  tool('remove_part', { inputSchema: { id: z.string(), partId: z.string() } }, ({ id, partId }) => guard(async () => { await core.removePart(id, partId); return text('removed'); }));
  tool('connect', {
    description: 'Wire two pins, e.g. from="board:13" to="led1:A".',
    inputSchema: { id: z.string(), from: z.string(), to: z.string(), color: z.string().optional() },
  }, ({ id, from, to, color }) => guard(async () => { await core.connect(id, from, to, color); return text('connected'); }));
  tool('disconnect', { inputSchema: { id: z.string(), from: z.string(), to: z.string() } },
    ({ id, from, to }) => guard(async () => { await core.disconnect(id, from, to); return text('disconnected'); }));
  tool('set_part_attr', { inputSchema: { id: z.string(), partId: z.string(), name: z.string(), value: z.string() } },
    ({ id, partId, name, value }) => guard(async () => { await core.setPartAttr(id, partId, name, value); return text('set'); }));

  tool('compile', { description: 'Compile sketch/sketch.ino with arduino-cli. Returns compiler output; check .ok.', inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => { const r = await core.compileProject(id); return json({ ok: r.ok, output: r.output }); }));

  tool('start_simulation', { inputSchema: { id: z.string() } }, ({ id }) => guard(async () => { await core.startSimulation(id); return text('started'); }));
  tool('stop_simulation', { inputSchema: { id: z.string() } }, ({ id }) => guard(async () => { core.stopSimulation(id); return text('stopped'); }));

  tool('read_serial', {
    description: 'Read serial output produced since a previous call. Pass the previous `next` value as `since` (0 for all output so far).',
    inputSchema: { id: z.string(), since: z.number().default(0) },
  }, ({ id, since }) => guard(async () => {
    const [data, next] = core.getSession(id).readSerial(since);
    return json({ text: Buffer.from(data).toString('utf8'), next });
  }));
  tool('write_serial', { inputSchema: { id: z.string(), text: z.string() } },
    ({ id, text: t }) => guard(async () => { core.getSession(id).writeSerial(new TextEncoder().encode(t)); return text('written'); }));

  tool('read_pin', {
    description: 'Read a pin\'s voltage, e.g. pin="board:13" or pin="led1:A". NaN = floating.',
    inputSchema: { id: z.string(), pin: z.string() },
  }, ({ id, pin }) => guard(async () => { const v = core.getSession(id).readPin(pin); return json({ volts: v, digital: Number.isNaN(v) ? null : v > 2.5 }); }));

  tool('set_control', {
    description: 'Drive a part\'s user input, e.g. partId="btn1" name="pressed" value=1, or name="value"/"temperature"/"distance"/"x" depending on the part.',
    inputSchema: { id: z.string(), partId: z.string(), name: z.string(), value: z.number() },
  }, ({ id, partId, name, value }) => guard(async () => { core.getSession(id).control(partId, name, value); return text('set'); }));

  tool('get_state', { description: 'Current rendered state of every part (LED brightness, LCD text, sensor readings, …).', inputSchema: { id: z.string() } },
    ({ id }) => guard(async () => json(core.getSession(id).state())));

  tool('capture_logic', {
    description: 'Record digital transitions on the given pins for durationMs of simulated time. Returns VCD text (view with any waveform viewer or read the transitions in it directly).',
    inputSchema: { id: z.string(), pins: z.array(z.string()), durationMs: z.number() },
  }, ({ id, pins, durationMs }) => guard(async () => {
    const samples = await core.getSession(id).captureLogic(pins, durationMs * 1e6);
    return text(Session.toVCD(pins, samples));
  }));

  tool('screenshot', {
    description: 'PNG framebuffer of a display part (SSD1306, ILI9341, HD44780).',
    inputSchema: { id: z.string(), partId: z.string() },
  }, ({ id, partId }) => guard(async () => ({ content: [{ type: 'image', data: core.getSession(id).screenshot(partId).toString('base64'), mimeType: 'image/png' }] })));

  return server;
}
