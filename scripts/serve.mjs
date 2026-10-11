#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOrders } from './collect.mjs';
import { McpError } from '../src/mcp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': mime['.json'] }); res.end(JSON.stringify(data)); };

export function createTheaterServer({ collect = collectOrders, storyBytes = null } = {}) {
let busy = false;
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const port = server.address()?.port;
  const expectedHost = `127.0.0.1:${port}`;
  const origin = `http://${expectedHost}`;
  if (req.headers.host !== expectedHost) { res.writeHead(421); res.end(); return; }
  if (req.url === '/api/collect') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      json(res, 403, { error: { code: 'local_origin_required', message: '请从本机小剧场页面发起连接。' } }); return;
    }
    if (busy) { json(res, 409, { error: { code: 'request_in_progress', message: '正在读取订单，请等这次连接完成。' } }); return; }
    busy = true;
    let body = '';
    let token = '';
    try {
      for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 8192) throw new McpError('invalid_token_input', '输入内容太长，请只填写 Token。');
      }
      let data;
      try { data = JSON.parse(body); } catch { throw new McpError('invalid_token_input', '输入格式无效。'); }
      if (typeof data.token !== 'string' || !data.token.trim() || data.token.length > 4096) throw new McpError('missing_token', '请在密码框中填写麦当劳 MCP Token。');
      token = data.token.trim();
      data.token = '';
      body = '';
      const envelope = await collect({ token });
      if (!envelope.orders?.length) {
        json(res, 422, { error: { code: 'no_completed_orders', message: '近期没有可确认已完成且包含餐品的订单，未生成真实订单小剧场。' }, warnings: envelope.warnings || [] });
      } else {
        json(res, 200, envelope);
      }
    } catch (err) {
      const safe = err instanceof McpError ? err.toJSON() : { code: 'local_error', message: '读取未完成，请稍后重试；错误详情已隐藏。' };
      const status = safe.code === 'missing_token' || safe.code === 'invalid_token_input' ? 400 : ['unauthorized', 'authentication_failed'].includes(safe.code) ? 401 : 502;
      json(res, status, { error: safe });
    } finally { token = ''; body = ''; busy = false; }
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (path === '/story.json' && storyBytes) { res.setHeader('Content-Type', mime['.json']); res.end(req.method === 'HEAD' ? '' : storyBytes); return; }
  if (path === '/') { res.writeHead(302, { Location: '/web/index.html' + new URL(req.url, 'http://localhost').search }); res.end(); return; }
  if (!/^\/(web|src|assets|examples)\//.test(path)) { res.writeHead(404); res.end(); return; }
  const target = resolve(root, '.' + path);
  if (!target.startsWith(root + sep) || !Object.hasOwn(mime, extname(target))) { res.writeHead(404); res.end(); return; }
  try {
    if (!(await stat(target)).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', mime[extname(target)]);
    res.end(req.method === 'HEAD' ? '' : await readFile(target));
  } catch { res.writeHead(404); res.end(); }
});
return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  if (args.includes('--help')) {
    console.log('用法：node scripts/serve.mjs [--port 4173] [--story path/to/story.json]\n仅监听本机；页面密码框里的 Token 只用于当次官方 MCP 请求，不保存。');
  } else {
    const port = Number(option('--port', process.env.PORT || 4173));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535。');
    const storyPath = option('--story');
    let storyBytes = null;
    if (storyPath) {
      const raw = await readFile(resolve(storyPath), 'utf8');
      const story = JSON.parse(raw);
      if (story.version !== 1 || !Array.isArray(story.members) || !Array.isArray(story.messages)) throw new Error('不是有效的 story.json。');
      storyBytes = Buffer.from(JSON.stringify(story));
    }
    const server = createTheaterServer({ storyBytes });
    server.on('error', (err) => { console.error(err.code === 'EADDRINUSE' ? '端口已使用，请改用 --port。' : '本机预览服务无法启动。'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`麦麦小剧场：http://127.0.0.1:${port}/${storyBytes ? '?story=/story.json' : ''}\n按 Ctrl+C 关闭。`));
  }
}
