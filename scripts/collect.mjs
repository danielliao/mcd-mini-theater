#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpClient, McpError } from '../src/mcp.mjs';
import { officialOrderRecords, isUnknownOfficialStatus, normalizeMcdRecords, normalizeMcdResponse, normalizeImportedOrders } from '../src/normalize.mjs';

export async function collectOrders({ client, token = process.env.MCD_MCP_TOKEN, args = {}, detail = true } = {}) {
  const mcp = client ?? new McpClient({ token });
  const records = officialOrderRecords(await mcp.callTool('order-list', args['order-list'] ?? {}));
  const normalized = [];
  const warnings = [];
  let unresolved = 0;
  let detailFailures = 0;
  const append = (one) => {
    normalized.push(...one.orders);
    warnings.push(...one.warnings.filter((message) => !/^已排除 \d|^\d+ 笔订单的完成状态未知|^没有可确认/.test(message)));
  };
  for (const record of records.slice(0, 10)) {
    if (detail && isUnknownOfficialStatus(record) && typeof record?.orderId === 'string' && record.orderId) {
      // orderId is documented by the official guide; all other required inputs
      // must be supplied explicitly and validated against the current tools/list.
      try {
        const found = officialOrderRecords(await mcp.callTool('query-order', { ...(args['query-order'] ?? {}), orderId: record.orderId }), 'query-order');
        const one = normalizeMcdRecords(found, { tool: 'query-order' });
        append(one);
        if (isUnknownOfficialStatus(found[0])) unresolved++;
      } catch (error) {
        // Detail is optional enrichment. Keep confirmed list records when a
        // detail is unavailable, but propagate expired/invalid credentials so
        // the caller can request a new token. Never copy upstream error text.
        if (!(error instanceof McpError) || error.code === 'authentication_failed') throw error;
        detailFailures++;
        unresolved++;
      }
    } else {
      const one = normalizeMcdRecords([record]);
      append(one);
      if (isUnknownOfficialStatus(record)) unresolved++;
    }
  }
  const excluded = Math.min(records.length, 10) - normalized.length;
  if (detailFailures) warnings.push('部分订单的详情补查未成功，已排除这些未确认完成的记录；已确认完成的订单仍保留。');
  if (excluded) warnings.push(`已排除 ${excluded} 笔取消、待支付、状态未确认或缺少餐品的记录。`);
  if (unresolved) warnings.push(`${unresolved} 笔订单的完成状态未知；需订单详情核实或由用户确认，未默认为完成。`);
  if (records.length > 10) warnings.push('上游返回超过 10 笔，仅处理前 10 笔近期订单。');
  if (!normalized.length) warnings.push('没有可确认已完成且包含餐品的近期订单。');
  return { version: 1, source: 'mcp', orders: normalized.map((order, i) => ({ ...order, id: `order-${String(i + 1).padStart(3, '0')}` })), warnings: [...new Set(warnings)], scope: '仅近期已完成订单' };
}

const HELP = `麦麦小剧场：只读订单采集\n\n  node scripts/collect.mjs --output work/orders.sanitized.json\n  node scripts/collect.mjs --args work/query-args.json --output work/orders.sanitized.json\n  node scripts/collect.mjs --from work/orders.raw.json --output work/orders.sanitized.json\n\n凭证仅从环境变量 MCD_MCP_TOKEN 读取。接口固定为 https://mcp.mcd.cn。\n--args 文件按工具名保存参数：{"order-list":{},"query-order":{}}；必填项从 tools/list 获取。\n--from 可读官方 order-list JSON/MCP 响应，或本机 {orders:[{status:"completed",items:[{name,quantity}]}]}。\n--confirm-completed 仅用于本机格式中用户核实完成状态的订单，不覆盖取消/待支付。\n--no-detail 不补查状态未知的订单，仍将其排除。\n不指定 --output 时，仅向 stdout 输出去敏后的标准订单。原始数据永不保存。\n`;

async function readJson(path) {
  try { return JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch { throw new McpError('invalid_json_file', '无法读取有效的本机 JSON；文件内容和路径已隐藏。'); }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { process.stdout.write(HELP); return; }
    if (['--output', '--from', '--args'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new McpError('invalid_cli', '命令参数缺少值。');
      options[arg.slice(2)] = argv[++i];
    } else if (arg === '--confirm-completed') options.confirmedCompleted = true;
    else if (arg === '--no-detail') options.detail = false;
    else throw new McpError('invalid_cli', '命令包含未知参数；使用 --help 查看用法。');
  }
  let envelope;
  if (options.from) {
    const raw = await readJson(options.from);
    envelope = raw?.success !== undefined || raw?.structuredContent || raw?.content
      ? normalizeMcdResponse(raw, { source: 'import' })
      : normalizeImportedOrders(raw, { confirmedCompleted: options.confirmedCompleted });
  } else {
    if (options.confirmedCompleted) throw new McpError('invalid_cli', '--confirm-completed 仅用于本机 JSON 导入。');
    envelope = await collectOrders({ args: options.args ? await readJson(options.args) : {}, detail: options.detail !== false });
  }
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  if (options.output) {
    const destination = resolve(options.output);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text, { mode: 0o600 });
    process.stderr.write(`已写出去敏订单：${envelope.orders.length} 笔。\n`);
  } else process.stdout.write(text);
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safe = error instanceof McpError ? error : new McpError('local_error', '采集未完成；本机或上游错误详情已隐藏。');
    process.stderr.write(`${JSON.stringify({ error: safe.toJSON() })}\n`);
    process.exitCode = 1;
  });
}
