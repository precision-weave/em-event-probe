// Event probe app: records everything a board emits (realtime channels and the REST event log), runs
// scenarios against a fixture timeline on that board, and logs each step it takes as an action, so the
// viewer can show cause and effect side by side.
// Usage: node app.mjs [board-id] [port]. Configuration: see loadConfig() and README.md.
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'http';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

// Configuration, highest first: command-line arguments, then environment variables (a .env file at the repo
// root is loaded, but never overrides a variable already set), then config.local.json, the board connection
// object EM Studio gives you, then defaults.
function loadConfig() {
  try { process.loadEnvFile(join(here, '.env')); } catch { /* no .env: nothing to load */ }
  const configFile = join(here, 'config.local.json');
  let file = {};
  if (existsSync(configFile)) {
    try { file = JSON.parse(readFileSync(configFile, 'utf-8')); }
    catch (e) { console.error(`config.local.json is not valid JSON: ${e.message}`); process.exit(1); }
  }
  const env = (name) => process.env[name] || undefined;   // an empty value counts as unset
  const [argBoard, argPort] = process.argv.slice(2);
  const cfg = {
    boardId: argBoard || env('EP_BOARD_ID') || file.boardId,
    port: Number(argPort || env('EP_PORT') || 8790),
    token: env('EP_TOKEN') || file.token,
    organizationId: env('EP_ORG_ID') || file.organizationId,
    baseUrl: (env('EP_BASE_URL') || file.baseUrl || 'https://api.eventmodelers.ai').replace(/\/+$/, ''),
  };
  const missing = [
    !cfg.boardId && 'board id: "boardId" in config.local.json, EP_BOARD_ID, or the first argument',
    !cfg.token && 'API token: "token" in config.local.json, or EP_TOKEN',
    !cfg.organizationId && 'organisation id: "organizationId" in config.local.json, or EP_ORG_ID',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Missing configuration:\n  - ${missing.join('\n  - ')}\nSee "Configure" in README.md.`);
    process.exit(1);
  }
  return cfg;
}
const { boardId, port, token, organizationId: org, baseUrl } = loadConfig();
const AGENT_A = randomUUID();   // this app, and "builder A" in scenarios
const AGENT_B = randomUUID();   // "builder B"
const fixtureFile = join(here, 'records', 'fixture.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Recording ──────────────────────────────────────────────────────────────
let file;
const clients = new Set();
function newRecording() { file = join(here, 'records', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`); }
newRecording();
function broadcast(line) { for (const res of clients) res.write(`data: ${JSON.stringify(line)}\n\n`); }
let lastRecordMs = 0;   // the newest record of any kind
let lastEventMs = 0;    // the newest realtime or REST log record
function record(entry) {
  const line = { t: new Date().toISOString(), ms: Date.now(), ...entry };
  lastRecordMs = line.ms;
  if (line.src === 'rt' || line.src === 'rest') lastEventMs = line.ms;
  appendFileSync(file, JSON.stringify(line) + '\n');
  broadcast(line);
  return line;
}
const trim = (v) => { const s = JSON.stringify(v ?? null); return s.length > 4000 ? s.slice(0, 4000) + '…' : v; };

// ── Platform calls ─────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, { ...opts, headers: { 'x-token': token, ...(opts.headers || {}) } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${String(text).slice(0, 300)}`);
  return { status: res.status, headers: res.headers, body };
}
// POST nodes/events the way the build kit does. Every event gets its own fresh id.
async function nodeEvents(events, agentId) {
  const r = await api(`/api/org/${org}/boards/${boardId}/nodes/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(agentId ? { 'x-agent-id': agentId } : {}) },
    body: JSON.stringify(events.map((e) => ({ id: randomUUID(), ...e }))),
  });
  return r.body;
}
// The eventmodelers MCP server over plain HTTP: one JSON-RPC tools/call per request.
let rpcId = 0;
async function mcp(name, args = {}, agentId) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'x-token': token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(agentId ? { 'x-agent-id': agentId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: { boardId, ...args } } }),
  });
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  const msg = JSON.parse(data ? data.slice(5) : text);
  if (msg.error) throw new Error(msg.error.message);
  const content = msg.result?.content?.[0]?.text;
  if (msg.result?.isError) throw new Error(content || `${name} failed`);
  try { return JSON.parse(content); } catch { return content; }
}

// ── Realtime ───────────────────────────────────────────────────────────────
// Startup calls fail with a plain message and the setting to check, not a stack trace.
async function startup(what, hint, fn) {
  try { return await fn(); }
  catch (e) { console.error(`Could not ${what}: ${e.message}\n${hint}`); process.exit(1); }
}
const config = await startup(`reach the platform at ${baseUrl}`, 'Check the token and baseUrl in your configuration.', async () => (await api('/api/config')).body);
const getRealtimeToken = async () => (await api(`/api/org/${org}/prompts/realtime-token`, { headers: { 'x-agent-id': AGENT_A } })).body.token;
const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, { realtime: { params: { apikey: config.supabaseAnonKey } } });
await supabase.realtime.setAuth(await startup('get a realtime token', 'Check the token and organizationId in your configuration.', getRealtimeToken));
for (const topic of [`board:${boardId}`, `board:${boardId}-slicechanged`, `org:${org}`]) {
  supabase.channel(topic, { config: { private: true } })
    .on('broadcast', { event: '*' }, (msg) => record({ src: 'rt', topic, event: msg.event, payload: msg.payload }))
    .subscribe((status, err) => record({ src: 'status', topic, status, error: err?.message }));
}
setInterval(async () => {
  try { await supabase.realtime.setAuth(await getRealtimeToken()); record({ src: 'status', status: 'realtime token refreshed' }); }
  catch (e) { record({ src: 'status', status: 'realtime token refresh failed', error: e.message }); }
}, 9 * 60 * 1000);

// ── REST event log poller ──────────────────────────────────────────────────
// Each poll re-reads the last few seconds of the log and drops events already seen, so an event
// whose seq becomes visible after a higher one is still picked up.
const OVERLAP_MS = 5000;
const seen = new Map();          // event id -> { seq, ms }
let floorSeq = 0;                // highest seq seen more than OVERLAP_MS ago
async function poll(recordIt) {
  const now = Date.now();
  for (const [id, s] of seen) if (now - s.ms > OVERLAP_MS) { floorSeq = Math.max(floorSeq, s.seq); if (now - s.ms > 60_000) seen.delete(id); }
  let since = floorSeq;
  for (;;) {
    const { headers, body } = await api(`/api/org/${org}/boards/${boardId}/events?since=${since}&skipSilent=false`);
    for (const e of body) {
      since = Math.max(since, e.seq);
      if (seen.has(e.id)) continue;
      seen.set(e.id, { seq: e.seq, ms: now });
      if (recordIt) record({ src: 'rest', event: e.event_type, payload: e });
    }
    if (headers.get('x-has-more') !== 'true') return;
  }
}
await startup(`read board ${boardId}`, 'Check the board id and organizationId in your configuration.', () => poll(false));
for (const s of seen.values()) floorSeq = Math.max(floorSeq, s.seq);
seen.clear();
setInterval(() => poll(true).catch((e) => record({ src: 'status', status: 'events poll failed', error: e.message })), 1000);

// ── Actions and scenarios ──────────────────────────────────────────────────
let actionSeq = 0;
let running = null;
// Sync mode: after each action, wait for the board to go quiet and for the viewer to have shown everything
// recorded so far, then pause briefly so a person can compare the board with the timeline.
// Only the viewer that started the scenario is waited for, and only while it is connected.
const viewerShown = new Map();   // viewer id -> playback position, reported to POST /ack
const viewers = new Map();       // viewer id -> open stream count
// The board has gone quiet: at least one REST poll since the last write, then no new events for 1.2 s.
async function settle() {
  await sleep(1200);
  const quietFrom = Date.now();
  while (Date.now() - lastEventMs < 1200 && Date.now() - quietFrom < 15000) await sleep(200);
}
async function waitForTimeline(label) {
  const viewer = running?.viewer;
  broadcast({ src: 'sync', waiting: true, label });
  await settle();
  const target = lastRecordMs;
  while (viewers.get(viewer) > 0 && (viewerShown.get(viewer) ?? 0) < target) await sleep(200);
  await sleep(800);
  broadcast({ src: 'sync', waiting: false });
}
async function act(label, detail, fn) {
  const id = ++actionSeq;
  const t0 = Date.now();
  record({ src: 'action', id, phase: 'start', label, scenario: running?.id, detail });
  try {
    const result = await fn();
    record({ src: 'action', id, phase: 'end', label, scenario: running?.id, ok: true, took: Date.now() - t0, result: trim(result) });
    if (running?.sync) await waitForTimeline(label);
    return result;
  } catch (e) {
    record({ src: 'action', id, phase: 'end', label, scenario: running?.id, ok: false, took: Date.now() - t0, error: e.message });
    throw e;
  }
}
const asList = (r) => (Array.isArray(r) ? r : r?.nodes ?? []);
const setStatus = (sliceId, status, via) => via === 'mcp'
  ? mcp('update_slice_status', { sliceId, newStatus: status })
  : nodeEvents([{ eventType: 'node:changed', nodeId: sliceId, changedAttributes: ['sliceStatus'], meta: { type: 'SLICE_BORDER', sliceStatus: status } }], via);
const retitle = (nodeId, type, title, extra = {}) => nodeEvents([{ eventType: 'node:changed', nodeId, changedAttributes: ['meta.title'], meta: { type, title }, ...extra }], AGENT_A);
async function addField(nodeId, type) {
  const node = asList(await mcp('get_nodes', { nodeIds: [nodeId], projection: 'fields' }))[0];
  const fields = (node?.fields ?? []).concat([{ name: `extra${(node?.fields ?? []).length + 1}`, type: 'String' }]);
  return mcp('submit_node_events', { events: [{ id: randomUUID(), eventType: 'node:changed', nodeId, changedAttributes: ['meta.fields'], meta: { type, fields } }] });
}

let fixture = existsSync(fixtureFile) ? JSON.parse(readFileSync(fixtureFile, 'utf-8')) : null;
function names(fx) {
  if (!fx) return {};
  return {
    [fx.chapterId]: 'timeline', [fx.s1.border]: 'S1 border', [fx.s1.screen]: 'S1 screen', [fx.s1.command]: 'S1 command', [fx.s1.event]: 'S1 event',
    [fx.s2.border]: 'S2 border', [fx.s2.screen]: 'S2 screen', [fx.s2.readmodel]: 'S2 read model', [fx.stray]: 'stray event',
    [AGENT_A]: 'builder A', [AGENT_B]: 'builder B',
  };
}
async function buildFixture() {
  const ch = await act('Create timeline "Probe"', { tool: 'create_chapter' }, () => mcp('create_chapter', { title: 'Probe', columns: 1 }));
  const s1 = await act('Create slice S1 "Register user"', { tool: 'create_slice' }, () => mcp('create_slice', {
    timelineId: ch.id, type: 'state-change', index: 0, status: 'Created',
    nodes: {
      actor: { title: 'Register screen' },
      interaction: { title: 'Register user', fields: [{ name: 'email', type: 'String' }, { name: 'name', type: 'String' }] },
      swimlane: { title: 'User registered', fields: [{ name: 'userId', type: 'UUID', idAttribute: true }, { name: 'email', type: 'String' }] },
    },
  }));
  const s2 = await act('Create slice S2 "User list"', { tool: 'create_slice' }, () => mcp('create_slice', {
    timelineId: ch.id, type: 'state-view', status: 'Created',
    nodes: { actor: { title: 'User list screen' }, interaction: { title: 'User list', fields: [{ name: 'userId', type: 'UUID' }, { name: 'name', type: 'String' }] } },
  }));
  const col = await act('Add an empty column', { tool: 'add_column' }, () => mcp('add_column', { timelineId: ch.id }));
  const stray = await act('Place "Stray event" outside any slice', { tool: 'place_element' }, () => mcp('place_element', {
    timelineId: ch.id, compact: true, elements: [{ elementType: 'EVENT', title: 'Stray event', columnIndex: 2, autoConnect: false, fields: [{ name: 'userId', type: 'UUID' }] }],
  }));
  fixture = {
    chapterId: ch.id,
    cols: [ch.columnIds[0], s2.columnId, col.columnId],
    s1: { border: s1.sliceDefinition.nodeId, screen: s1.nodes.actor.nodeId, command: s1.nodes.interaction.nodeId, event: s1.nodes.swimlane.nodeId },
    s2: { border: s2.sliceDefinition.nodeId, screen: s2.nodes.actor.nodeId, readmodel: s2.nodes.interaction.nodeId },
    stray: stray.results[0].nodeId,
  };
  writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2));
  record({ src: 'fixture', fixture, names: names(fixture) });
  return fixture;
}
async function wipeBoard() {
  const chapters = asList(await act('Find timelines on the board', { tool: 'get_nodes' }, () => mcp('get_nodes', { type: 'CHAPTER', projection: 'line' })));
  for (const c of chapters) await act(`Delete timeline "${c.title ?? c.id}"`, { tool: 'delete_node', nodeId: c.id }, () => mcp('delete_node', { nodeId: c.id }));
  fixture = null;
}
async function ensureFixture() {
  if (fixture) {
    const found = asList(await mcp('get_nodes', { nodeIds: [fixture.chapterId], projection: 'line' }));
    if (found.length) return fixture;
  }
  return buildFixture();
}

const SCENARIOS = [
  { id: 'reset-board', title: 'Reset board', group: 'setup', about: 'Delete every timeline on the board and rebuild the fixture: S1 Register user, S2 User list, and a stray event outside any slice.',
    run: async () => { await wipeBoard(); await buildFixture(); } },
  { id: 'status-mcp', title: 'Status via MCP', group: 'slice', about: 'S1 → Ready → Planned through the MCP tool, which sends no x-agent-id.',
    run: async (fx) => {
      await act('S1 → Ready (MCP)', { tool: 'update_slice_status' }, () => setStatus(fx.s1.border, 'Ready', 'mcp')); await sleep(1200);
      await act('S1 → Planned (MCP)', { tool: 'update_slice_status' }, () => setStatus(fx.s1.border, 'Planned', 'mcp'));
    } },
  { id: 'status-rest', title: 'Status via REST', group: 'slice', about: 'S1 → InProgress through POST nodes/events with x-agent-id, the build kit\'s own write path.',
    run: async (fx) => { await act('S1 → InProgress (REST, builder A)', { rest: 'nodes/events' }, () => setStatus(fx.s1.border, 'InProgress', AGENT_A)); } },
  { id: 'edit-fields', title: 'Edit element fields', group: 'element', about: 'Add a field to S1\'s command. No slice:changed is expected.',
    run: async (fx) => { await act('Add a field to S1 command (MCP)', { tool: 'submit_node_events' }, () => addField(fx.s1.command, 'COMMAND')); } },
  { id: 'rename', title: 'Rename element', group: 'element', about: 'Rename S1\'s event. S2\'s read model is connected to it.',
    run: async (fx) => { await act('Rename S1 event (MCP)', { tool: 'submit_node_events' }, () => mcp('submit_node_events', { events: [{ id: randomUUID(), eventType: 'node:changed', nodeId: fx.s1.event, changedAttributes: ['meta.title'], meta: { type: 'EVENT', title: `User registered ${new Date().toISOString().slice(11, 19)}` } }] })); } },
  { id: 'add-delete', title: 'Add then delete element', group: 'element', about: 'Place an event in S2\'s column, then delete it.',
    run: async (fx) => {
      const r = await act('Place an event in S2\'s column (MCP)', { tool: 'place_element' }, () => mcp('place_element', { timelineId: fx.chapterId, compact: true, elements: [{ elementType: 'EVENT', title: 'Temporary event', columnIndex: 1, autoConnect: false }] }));
      await sleep(1500);
      await act('Delete that event (MCP)', { tool: 'delete_node' }, () => mcp('delete_node', { nodeId: r.results[0].nodeId }));
    } },
  { id: 'move', title: 'Move element in and out', group: 'element', about: 'Move the stray event into S2\'s column and back out. Only the timeline node changes.',
    run: async (fx) => {
      await act('Move stray event into S2\'s column (MCP)', { tool: 'place_element' }, () => mcp('place_element', { timelineId: fx.chapterId, compact: true, elements: [{ action: 'move', nodeId: fx.stray, cellName: 'B3' }] }));
      await sleep(1500);
      await act('Move it back out (MCP)', { tool: 'place_element' }, () => mcp('place_element', { timelineId: fx.chapterId, compact: true, elements: [{ action: 'move', nodeId: fx.stray, cellName: 'C3' }] }));
    } },
  { id: 'comment', title: 'Comment', group: 'element', about: 'Comment on S1\'s command.',
    run: async (fx) => { await act('Comment on S1 command (MCP)', { tool: 'add_comment' }, () => mcp('add_comment', { nodeId: fx.s1.command, text: `Probe comment ${new Date().toISOString().slice(11, 19)}`, type: 'COMMENT' })); } },
  { id: 'linked-copy', title: 'Linked copy, edit origin', group: 'element', about: 'Create a slice, turn its command into a linked copy of S1\'s command, then edit the original.',
    run: async (fx) => {
      const s = await act('Create slice "Register user (copy)"', { tool: 'create_slice' }, () => mcp('create_slice', { timelineId: fx.chapterId, type: 'state-change', status: 'Created', nodes: { interaction: { title: 'Copy target' } } }));
      await sleep(1200);
      await act('Make its command a linked copy of S1 command', { tool: 'link_element' }, () => mcp('link_element', { nodeId: fx.s1.command, targetNodeId: s.nodes.interaction.nodeId }));
      await sleep(1200);
      await act('Add a field to the original S1 command', { tool: 'submit_node_events' }, () => addField(fx.s1.command, 'COMMAND'));
    } },
  { id: 'burst', title: 'Burst: 10 parallel writes', group: 'delivery', about: 'Ten separate REST requests at once, each retitling the stray event.',
    run: async (fx) => { await act('10 parallel REST writes (builder A)', { rest: 'nodes/events ×10' }, () => Promise.all(Array.from({ length: 10 }, (_, i) => retitle(fx.stray, 'EVENT', `Burst ${i + 1}`)))); } },
  { id: 'batch', title: 'Batch: 5 events, 1 request', group: 'delivery', about: 'One REST request carrying five events. Watch the broadcast order.',
    run: async (fx) => { await act('One REST request with 5 events (builder A)', { rest: 'nodes/events' }, () => nodeEvents(Array.from({ length: 5 }, (_, i) => ({ eventType: 'node:changed', nodeId: fx.stray, changedAttributes: ['meta.title'], meta: { type: 'EVENT', title: `Batch ${i + 1}` } })), AGENT_A)); } },
  { id: 'silent', title: 'Silent write', group: 'delivery', about: 'A silent:true write, then a normal one. The silent one is only in the REST log.',
    run: async (fx) => {
      await act('Silent write on stray event (builder A)', { rest: 'nodes/events', silent: true }, () => retitle(fx.stray, 'EVENT', 'Silent write', { silent: true }));
      await sleep(1500);
      await act('Normal write on stray event (builder A)', { rest: 'nodes/events' }, () => retitle(fx.stray, 'EVENT', 'Loud write'));
    } },
  { id: 'replan', title: 'Done, then re-plan', group: 'slice', about: 'S1 → Done → Planned through REST.',
    run: async (fx) => {
      await act('S1 → Done (REST, builder A)', {}, () => setStatus(fx.s1.border, 'Done', AGENT_A)); await sleep(1500);
      await act('S1 → Planned (REST, builder A)', {}, () => setStatus(fx.s1.border, 'Planned', AGENT_A));
    } },
  { id: 'same-status', title: 'Same-status writes', group: 'slice', about: 'S1 → InProgress twice by builder A, then once by builder B. Every write is accepted today.',
    run: async (fx) => {
      await act('S1 → InProgress (builder A)', {}, () => setStatus(fx.s1.border, 'InProgress', AGENT_A)); await sleep(1200);
      await act('S1 → InProgress again (builder A)', {}, () => setStatus(fx.s1.border, 'InProgress', AGENT_A)); await sleep(1200);
      await act('S1 → InProgress (builder B)', {}, () => setStatus(fx.s1.border, 'InProgress', AGENT_B));
    } },
  { id: 'border-move', title: 'Move slice border', group: 'slice', about: 'Move S2\'s border to the empty column and back.',
    run: async (fx) => {
      const move = (colId) => nodeEvents([{ eventType: 'node:changed', nodeId: fx.s2.border, changedAttributes: ['meta.colId'], meta: { type: 'SLICE_BORDER', colId } }], AGENT_A);
      await act('S2 border → empty column (builder A)', {}, () => move(fx.cols[2])); await sleep(1500);
      await act('S2 border → back to its column (builder A)', {}, () => move(fx.cols[1]));
    } },
  { id: 'build-happy', title: 'Build: happy path', group: 'pipeline', about: 'A person plans S1, builder A claims it, builds for 3 s, and marks it Done.',
    run: async (fx) => {
      await act('Person: S1 → Planned (MCP)', {}, () => setStatus(fx.s1.border, 'Planned', 'mcp')); await sleep(1500);
      await act('Builder A claims: S1 → InProgress', {}, () => setStatus(fx.s1.border, 'InProgress', AGENT_A));
      await act('Builder A builds (simulated)', { note: 'no board writes' }, () => sleep(3000));
      await act('Builder A: S1 → Done', {}, () => setStatus(fx.s1.border, 'Done', AGENT_A));
    } },
  { id: 'two-builders', title: 'Build: two builders, edit mid-build', group: 'pipeline', about: 'Both builders claim S1, a person edits it mid-build, both mark it Done.',
    run: async (fx) => {
      await act('Person: S1 → Planned (MCP)', {}, () => setStatus(fx.s1.border, 'Planned', 'mcp')); await sleep(1500);
      await act('Builder A claims: S1 → InProgress', {}, () => setStatus(fx.s1.border, 'InProgress', AGENT_A)); await sleep(800);
      await act('Builder B claims: S1 → InProgress', {}, () => setStatus(fx.s1.border, 'InProgress', AGENT_B)); await sleep(1500);
      await act('Person edits S1 command mid-build (MCP)', {}, () => addField(fx.s1.command, 'COMMAND')); await sleep(1500);
      await act('Builder A: S1 → Done', {}, () => setStatus(fx.s1.border, 'Done', AGENT_A)); await sleep(1500);
      await act('Builder B: S1 → Done', {}, () => setStatus(fx.s1.border, 'Done', AGENT_B));
    } },
];

// Start a new recording and tell every viewer to clear, as POST /reset-view does.
function clearView() {
  newRecording();
  broadcast({ src: 'hello', reset: true, names: names(fixture), running: running?.title ?? null });
  broadcast({ src: 'replayed' });
}

// resetFirst: delete the board's timelines without waiting, clear the view, then rebuild the fixture and run
// the scenario. The rebuild and the scenario both follow the sync setting, so a person watching the board sees
// each component arrive with its events.
async function runScenario(sc, sync, viewer, resetFirst) {
  if (resetFirst) {
    const steps = [
      { id: 'wipe', title: 'Clear the board', about: 'Delete every timeline on the board.', sync: false, run: wipeBoard, clearAfter: true },
      { id: 'fixture', title: 'Build the fixture', about: 'S1 Register user, S2 User list, an empty column and a stray event, one at a time.', sync, run: buildFixture },
    ];
    for (const step of steps) {
      running = { ...step, viewer };
      record({ src: 'scenario', phase: 'start', id: step.id, title: step.title, about: step.about, sync: step.sync });
      try {
        await step.run();
      } catch (e) {
        record({ src: 'scenario', phase: 'end', id: step.id, title: step.title, ok: false, error: e.message });
        running = null;
        return;
      }
      await settle();   // the tail of the step lands in its own recording, not the next view
      record({ src: 'scenario', phase: 'end', id: step.id, title: step.title, ok: true });
      if (step.clearAfter) { running = { ...steps[1], viewer }; clearView(); }
    }
  }
  running = { ...sc, sync, viewer };
  record({ src: 'scenario', phase: 'start', id: sc.id, title: sc.title, about: sc.about, sync });
  try {
    const fx = sc.id === 'reset-board' ? null : await ensureFixture();
    await sc.run(fx);
    await sleep(2500);   // let the poller catch the tail
    record({ src: 'scenario', phase: 'end', id: sc.id, title: sc.title, ok: true });
  } catch (e) {
    record({ src: 'scenario', phase: 'end', id: sc.id, title: sc.title, ok: false, error: e.message });
  } finally {
    running = null;
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────
// Precision Weave glass theme, and the Lucide icons the viewer uses as one inline sprite.
const PW_CSS = { '/pw/theme.css': 'themes/precision-weave-glass.css', '/pw/components.css': 'components.css', '/pw/glass.css': 'styles/glass.css' };
const ICONS = ['play', 'pause', 'step-forward', 'skip-back', 'radio', 'copy', 'check', 'search', 'x', 'circle-alert', 'triangle-alert', 'info', 'rotate-ccw', 'eraser', 'circle-check', 'clock', 'zap', 'activity', 'chevron-up', 'chevron-down', 'eye-off', 'wifi-off'];
const sprite = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">' + ICONS.map((name) => {
  const svg = readFileSync(join(here, 'node_modules', 'lucide-static', 'icons', `${name}.svg`), 'utf-8');
  return `<symbol id="i-${name}" viewBox="0 0 24 24">${svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))}</symbol>`;
}).join('') + '</svg>';
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(readFileSync(join(here, 'index.html'), 'utf-8').replace('<!--SPRITE-->', sprite)); }
  if (req.method === 'GET' && PW_CSS[url.pathname]) { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(readFileSync(join(here, 'node_modules', '@pw', 'ui', 'dist', PW_CSS[url.pathname]))); }
  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ src: 'hello', names: names(fixture), running: running?.title ?? null })}\n\n`);
    if (existsSync(file)) for (const l of readFileSync(file, 'utf-8').split('\n').filter(Boolean)) res.write(`data: ${l}\n\n`);
    res.write(`data: ${JSON.stringify({ src: 'replayed' })}\n\n`);   // everything after this is live
    const viewer = url.searchParams.get('viewer');
    clients.add(res);
    if (viewer) viewers.set(viewer, (viewers.get(viewer) ?? 0) + 1);
    req.on('close', () => { clients.delete(res); if (viewer) viewers.set(viewer, viewers.get(viewer) - 1); });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/scenarios') return json(res, 200, SCENARIOS.map(({ id, title, group, about }) => ({ id, title, group, about })));
  if (req.method === 'POST' && url.pathname.startsWith('/scenario/')) {
    const sc = SCENARIOS.find((s) => s.id === url.pathname.slice('/scenario/'.length));
    if (!sc) return json(res, 404, { error: 'no such scenario' });
    if (running) return json(res, 409, { error: `${running.title} is still running` });
    runScenario(sc, url.searchParams.get('sync') === '1', url.searchParams.get('viewer'), url.searchParams.get('reset') === '1');
    return json(res, 202, { started: sc.id });
  }
  if (req.method === 'POST' && url.pathname === '/reset-view') {
    clearView();
    return json(res, 200, { file });
  }
  if (req.method === 'POST' && url.pathname === '/ack') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { const b = JSON.parse(body); viewerShown.set(String(b.viewer), Number(b.ms) || 0); } catch { /* ignore a bad ack */ } res.writeHead(204); res.end(); });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/info') return json(res, 200, { boardId, file, agents: { A: AGENT_A, B: AGENT_B }, fixture, running: running?.id ?? null });
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => {
  record({ src: 'status', status: 'app started', boardId, agents: { A: AGENT_A, B: AGENT_B } });
  console.log(`event probe on http://127.0.0.1:${port}`);
});
