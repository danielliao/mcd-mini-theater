export const MCP_ENDPOINT = 'https://mcp.mcd.cn';
export const READ_ONLY_TOOLS = Object.freeze(['order-list', 'query-order']);
const VERSIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const MAX_BYTES = 8 * 1024 * 1024;

export class McpError extends Error {
  constructor(code, message, fields = []) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.fields = fields.map((v) => String(v).replace(/[^a-zA-Z0-9_.\[\]-]/g, '').slice(0, 100));
  }
  toJSON() { return { code: this.code, message: this.message, ...(this.fields.length ? { fields: this.fields } : {}) }; }
}

function missing(schema, value, path = '') {
  if (!schema || typeof schema !== 'object') return [];
  const result = [];
  if (schema.type === 'object' || schema.properties || schema.required) {
    const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) result.push(path ? `${path}.${key}` : key);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(object, key)) result.push(...missing(sub, object[key], path ? `${path}.${key}` : key));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => result.push(...missing(schema.items, item, `${path}[${i}]`)));
  for (const sub of schema.allOf ?? []) result.push(...missing(sub, value, path));
  return [...new Set(result)];
}

export function missingRequiredFields(schema, args = {}) { return missing(schema, args); }

function validate(schema, value) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref) return false; // Unresolved schemas are never treated as an empty contract.
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) return false;
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  const type = schema.type;
  if (Array.isArray(type)) return type.some((t) => validate({ ...schema, type: t }, value));
  if (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return false;
  if (type === 'array' && !Array.isArray(value)) return false;
  if (type === 'string' && typeof value !== 'string') return false;
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (type === 'integer' && !Number.isSafeInteger(value)) return false;
  if (type === 'boolean' && typeof value !== 'boolean') return false;
  if (type === 'null' && value !== null) return false;
  if (missing(schema, value).length) return false;
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (typeof value === 'string' && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength))) return false;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key) && !validate(sub, value[key])) return false;
  }
  if (Array.isArray(value) && schema.items && value.some((v) => !validate(schema.items, v))) return false;
  if (schema.allOf && !schema.allOf.every((s) => validate(s, value))) return false;
  if (schema.anyOf && !schema.anyOf.some((s) => validate(s, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((s) => validate(s, value)).length !== 1) return false;
  return true;
}

function rpcResult(message, id) {
  const messages = Array.isArray(message) ? message : [message];
  const match = messages.find((v) => v && v.jsonrpc === '2.0' && v.id === id);
  if (!match) return undefined;
  if (match.error) throw new McpError('rpc_error', 'MCP 服务返回协议错误；上游错误正文已隐藏。');
  if (!Object.hasOwn(match, 'result')) throw new McpError('invalid_response', 'MCP 响应没有 result。');
  return { result: match.result };
}

async function readResponse(response, id) {
  const type = response.headers.get('content-type') ?? '';
  if (!response.body) throw new McpError('invalid_response', 'MCP 响应为空。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  const parse = (text) => { try { return JSON.parse(text); } catch { throw new McpError('invalid_response', 'MCP 返回了无法解析的 JSON；正文已隐藏。'); } };
  try {
    if (!type.includes('application/json') && !type.includes('text/event-stream')) throw new McpError('unsupported_transport', 'MCP 响应类型不是 JSON 或 SSE。');
    for (;;) {
      const { value, done } = await reader.read();
      if (value) { bytes += value.byteLength; if (bytes > MAX_BYTES) throw new McpError('response_too_large', 'MCP 响应超过安全大小限制。'); buffer += decoder.decode(value, { stream: true }); }
      if (done) buffer += decoder.decode();
      if (type.includes('text/event-stream')) {
        // SSE line endings may span chunks. Normalize only after an entire event arrives.
        let delimiter;
        while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, delimiter.index); buffer = buffer.slice(delimiter.index + delimiter[0].length);
          const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
          if (data.trim()) { const result = rpcResult(parse(data), id); if (result) return result.result; }
        }
        if (done && buffer.trim()) {
          const data = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
          if (data.trim()) { const result = rpcResult(parse(data), id); if (result) return result.result; }
        }
      } else if (done) {
        const result = rpcResult(parse(buffer), id); if (result) return result.result;
      }
      if (done) throw new McpError('invalid_response', 'MCP 没有返回本次请求的响应。');
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export class McpClient {
  #token; #fetch; #session; #version; #nextId = 1; #tools; #initialized = false;
  constructor({ token, endpoint = MCP_ENDPOINT, timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
    if (typeof token !== 'string' || !token.trim()) throw new McpError('missing_token', '请在本机环境变量 MCD_MCP_TOKEN 中提供凭证。');
    const url = new URL(endpoint);
    if (endpoint !== MCP_ENDPOINT && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new McpError('invalid_endpoint', '仅允许官方 MCP 地址；本地测试可使用回环地址。');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new McpError('invalid_timeout', '请求超时设置无效。');
    this.#token = token; this.endpoint = endpoint; this.timeoutMs = timeoutMs; this.#fetch = fetchImpl;
  }
  async #send(method, params, notification = false) {
    const id = notification ? undefined : this.#nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { Authorization: `Bearer ${this.#token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    if (this.#session) headers['Mcp-Session-Id'] = this.#session;
    if (this.#version) headers['MCP-Protocol-Version'] = this.#version;
    try {
      const response = await this.#fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }), signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) throw new McpError('authentication_failed', 'MCP 凭证无效、过期或无访问权限；请重新检查本机凭证。');
        if (response.status === 429) throw new McpError('rate_limited', 'MCP 请求限流；请稍后重试。');
        if (response.status === 404 && this.#session) throw new McpError('session_expired', 'MCP 会话已失效。');
        throw new McpError('http_error', `MCP 请求失败（HTTP ${response.status}）；错误正文已隐藏。`);
      }
      if (method === 'initialize') {
        const session = response.headers.get('mcp-session-id');
        if (session && !/^[\x21-\x7E]{1,1024}$/.test(session)) throw new McpError('invalid_session', 'MCP 会话标识格式无效。');
        this.#session = session ?? undefined;
      }
      if (notification) { await response.body?.cancel().catch(() => {}); return undefined; }
      return await readResponse(response, id);
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (controller.signal.aborted) throw new McpError('timeout', 'MCP 请求超时；没有保存上游响应。');
      throw new McpError('network_error', '无法连接 MCP；网络错误详情已隐藏。');
    } finally { clearTimeout(timer); }
  }
  async initialize() {
    if (this.#initialized) return;
    const result = await this.#send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcd-mini-theater-readonly', version: '1.0.0' } });
    if (!result || !VERSIONS.has(result.protocolVersion) || !result.capabilities?.tools) throw new McpError('unsupported_protocol', 'MCP 没有协商到受支持的协议和工具能力。');
    this.#version = result.protocolVersion;
    await this.#send('notifications/initialized', undefined, true);
    this.#initialized = true;
  }
  async #request(method, params) {
    await this.initialize();
    try { return await this.#send(method, params); }
    catch (error) {
      if (error.code !== 'session_expired') throw error;
      this.#session = undefined; this.#version = undefined; this.#initialized = false; this.#tools = undefined;
      await this.initialize();
      return this.#send(method, params);
    }
  }
  async listTools() {
    const tools = []; let cursor; const seen = new Set();
    for (let page = 0; page < 10; page++) {
      const result = await this.#request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw new McpError('invalid_tool_schema', 'MCP tools/list 响应不包含工具数组。');
      for (const tool of result.tools) if (READ_ONLY_TOOLS.includes(tool.name)) {
        if (!tool.inputSchema || typeof tool.inputSchema !== 'object') throw new McpError('invalid_tool_schema', '查询工具没有 inputSchema。');
        tools.push({ name: tool.name, inputSchema: tool.inputSchema });
      }
      cursor = result.nextCursor;
      if (!cursor) { this.#tools = tools; return tools; }
      if (typeof cursor !== 'string' || seen.has(cursor)) throw new McpError('invalid_tool_schema', '工具分页游标无效。');
      seen.add(cursor);
    }
    throw new McpError('invalid_tool_schema', '工具分页超出安全限制。');
  }
  async callTool(name, args = {}) {
    if (!READ_ONLY_TOOLS.includes(name)) throw new McpError('tool_not_allowed', '本项目仅允许 order-list 和 query-order 只读查询。');
    const tool = (this.#tools ?? await this.listTools()).find((t) => t.name === name);
    if (!tool) throw new McpError('tool_unavailable', '服务没有提供所需的订单查询工具。');
    const fields = missingRequiredFields(tool.inputSchema, args);
    if (fields.length) throw new McpError('missing_arguments', '查询参数不完整；请依据当前 tools/list 合约补齐列出的字段。', fields);
    if (!validate(tool.inputSchema, args)) throw new McpError('invalid_arguments', '查询参数不符合当前 tools/list 合约；未发送查询。');
    const result = await this.#request('tools/call', { name, arguments: args });
    if (result?.isError) throw new McpError('tool_error', '订单查询返回错误；上游正文已隐藏。');
    return result;
  }
}
