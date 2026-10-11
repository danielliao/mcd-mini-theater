import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTheaterServer } from '../scripts/serve.mjs';
import { McpError } from '../src/mcp.mjs';

async function serve(t, collect) {
  const server = createTheaterServer({ collect });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (url, token, origin = url) => fetch(`${url}/api/collect`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });

test('local Token form rejects cross-origin requests and empty tokens before any upstream call', async t => {
  let calls = 0;
  const url = await serve(t, async () => { calls++; return { orders: [] }; });
  assert.equal((await post(url, 'fake-local-test-token', 'https://example.invalid')).status, 403);
  assert.equal((await post(url, '')).status, 400);
  assert.equal(calls, 0);
});

test('live route sends the one submitted token to its collector and returns only its sanitized envelope', async t => {
  let received;
  const envelope = { version: 1, source: 'mcp', orders: [{ id: 'order-001', items: [{ id: 'food-1', name: '中薯', quantity: 1, kind: 'fries' }] }], warnings: [] };
  const url = await serve(t, async ({ token }) => { received = token; return envelope; });
  const response = await post(url, 'fake-local-test-token');
  assert.equal(response.status, 200);
  assert.equal(received, 'fake-local-test-token');
  const body = await response.text();
  assert.ok(!body.includes(received));
  assert.deepEqual(JSON.parse(body), envelope);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('no completed orders produce an explicit failure instead of a demo story', async t => {
  const url = await serve(t, async () => ({ orders: [], warnings: ['已排除待支付订单。'] }));
  const response = await post(url, 'fake-local-test-token');
  assert.equal(response.status, 422);
  const result = await response.json();
  assert.equal(result.error.code, 'no_completed_orders');
  assert.equal(result.orders, undefined);
});

test('unknown failures never expose raw upstream messages or Token values', async t => {
  const secret = 'fake-local-test-token';
  const url = await serve(t, async () => { throw new Error(`${secret} a private address`); });
  const response = await post(url, secret);
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!body.includes(secret));
  assert.ok(!body.includes('private address'));
  assert.equal(JSON.parse(body).error.code, 'local_error');
});

test('credential errors are safe and static serving excludes scripts and private outputs', async t => {
  const url = await serve(t, async () => { throw new McpError('unauthorized', '凭证不可用。'); });
  assert.equal((await post(url, 'fake-local-test-token')).status, 401);
  assert.equal((await fetch(`${url}/scripts/collect.mjs`)).status, 404);
  assert.equal((await fetch(`${url}/generated/orders.sanitized.json`)).status, 404);
  assert.equal((await fetch(`${url}/web/../../package.json`)).status, 404);
});
