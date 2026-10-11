import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { McpClient, McpError } from '../src/mcp.mjs';

// Local synthetic protocol fixtures. These are not live MCP evidence.
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
async function server(t, handle) {
  const requests = [];
  const http = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const rpc = JSON.parse(body); requests.push({ rpc, headers: req.headers });
    await handle(rpc, req, res, requests);
  });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  t.after(() => { http.closeAllConnections(); return new Promise((done) => http.close(done)); });
  return { endpoint: `http://127.0.0.1:${http.address().port}`, requests };
}
function json(res, id, result, headers = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
function handshake(rpc, res) {
  if (rpc.method === 'initialize') { json(res, rpc.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } }, { 'Mcp-Session-Id': 'test-session' }); return true; }
  if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); return true; }
  return false;
}

test('initialize, notification, dynamic tool schema and chunked SSE retain session/auth headers', async (t) => {
  const stub = await server(t, async (rpc, req, res) => {
    if (handshake(rpc, res)) return;
    if (rpc.method === 'tools/list') return json(res, rpc.id, { tools: [
      { name: 'order-list', inputSchema: emptySchema },
      { name: 'query-order', inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] } },
      { name: 'create-order', inputSchema: {} },
    ] });
    assert.equal(rpc.params.name, 'order-list');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r');
    await new Promise((done) => setTimeout(done, 2));
    res.end(`\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"success":true,"code":200,"data":{"list":[]}}' }] } })}\r\n\r\n`);
  });
  const client = new McpClient({ token: 'test-secret', endpoint: stub.endpoint });
  const result = await client.callTool('order-list');
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(stub.requests.map((v) => v.rpc.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  for (const { headers } of stub.requests) {
    assert.equal(headers.authorization, 'Bearer test-secret');
    assert.match(headers.accept, /application\/json, text\/event-stream/);
  }
  for (const { headers } of stub.requests.slice(1)) {
    assert.equal(headers['mcp-session-id'], 'test-session');
    assert.equal(headers['mcp-protocol-version'], '2025-06-18');
  }
});

test('required fields come from tools/list and missing arguments never call tools/call', async (t) => {
  const stub = await server(t, async (rpc, req, res) => {
    if (handshake(rpc, res)) return;
    json(res, rpc.id, { tools: [{ name: 'order-list', inputSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] } }] });
  });
  const client = new McpClient({ token: 'test', endpoint: stub.endpoint });
  await assert.rejects(client.callTool('order-list'), (error) => error.code === 'missing_arguments' && error.fields[0] === 'region');
  assert.equal(stub.requests.some((v) => v.rpc.method === 'tools/call'), false);
});

test('write operations are rejected before any network request', async () => {
  let requests = 0;
  const client = new McpClient({ token: 'test', fetchImpl: async () => { requests++; } });
  await assert.rejects(client.callTool('create-order'), { code: 'tool_not_allowed' });
  await assert.rejects(client.callTool('auto-bind-coupons'), { code: 'tool_not_allowed' });
  assert.equal(requests, 0);
});

for (const [status, code] of [[401, 'authentication_failed'], [429, 'rate_limited'], [500, 'http_error']]) {
  test(`HTTP ${status} errors are classified without upstream PII/token text`, async (t) => {
    const stub = await server(t, async (rpc, req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end('{"token":"test-secret","phone":"13812345678","address":"private home"}'); });
    const client = new McpClient({ token: 'test-secret', endpoint: stub.endpoint });
    await assert.rejects(client.initialize(), (error) => {
      assert.equal(error.code, code); assert.doesNotMatch(JSON.stringify(error.toJSON()), /test-secret|13812345678|private home/); return true;
    });
  });
}

test('timeout covers stalled responses', async (t) => {
  const stub = await server(t, async () => {});
  const client = new McpClient({ token: 'test', endpoint: stub.endpoint, timeoutMs: 20 });
  await assert.rejects(client.initialize(), { code: 'timeout' });
});

test('session expiry reinitializes once before retrying a read', async (t) => {
  let listed = 0;
  const stub = await server(t, async (rpc, req, res) => {
    if (handshake(rpc, res)) return;
    if (rpc.method === 'tools/list' && listed++ === 0) { res.writeHead(404); res.end(); return; }
    json(res, rpc.id, { tools: [{ name: 'order-list', inputSchema: emptySchema }] });
  });
  const client = new McpClient({ token: 'test', endpoint: stub.endpoint });
  assert.equal((await client.listTools())[0].name, 'order-list');
  assert.equal(stub.requests.filter((v) => v.rpc.method === 'initialize').length, 2);
  assert.equal(stub.requests.filter((v) => v.rpc.method === 'initialize').some((v) => v.headers['mcp-session-id']), false);
});

test('missing token and external endpoint fail without exposing credentials', () => {
  assert.throws(() => new McpClient(), { code: 'missing_token' });
  assert.throws(() => new McpClient({ token: 'secret', endpoint: 'https://example.com' }), { code: 'invalid_endpoint' });
  const error = new McpError('missing_arguments', '参数缺失。', ['orderId']);
  assert.deepEqual(error.toJSON(), { code: 'missing_arguments', message: '参数缺失。', fields: ['orderId'] });
});
