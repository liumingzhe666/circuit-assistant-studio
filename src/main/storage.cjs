const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { app, safeStorage } = require('electron');

const DEFAULT_SETTINGS = Object.freeze({
  provider: 'local-rules',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'gemma3:4b',
  remoteBaseUrl: 'https://api.example.com/v1',
  remoteModel: '',
  remoteApiKey: '',
  retrievalStrength: 'deep',
  aiTemperature: 0.15,
  ollamaNumCtx: 8192,
  knowledgeMaxEntries: 12,
  allowRemoteKnowledge: false,
});

const RETRIEVAL_STRENGTH_KEYS = new Set(['standard', 'deep', 'exhaustive']);

function sanitizeRetrievalSettings(settings) {
  const temperature = Number(settings.aiTemperature);
  const numCtx = Number(settings.ollamaNumCtx);
  const entries = Number(settings.knowledgeMaxEntries);
  return {
    retrievalStrength: RETRIEVAL_STRENGTH_KEYS.has(settings.retrievalStrength)
      ? settings.retrievalStrength
      : 'deep',
    aiTemperature: Number.isFinite(temperature) ? Math.max(0, Math.min(1, temperature)) : DEFAULT_SETTINGS.aiTemperature,
    ollamaNumCtx: Number.isFinite(numCtx) ? Math.round(Math.max(2048, Math.min(32768, numCtx))) : DEFAULT_SETTINGS.ollamaNumCtx,
    knowledgeMaxEntries: Number.isFinite(entries) ? Math.round(Math.max(4, Math.min(20, entries))) : DEFAULT_SETTINGS.knowledgeMaxEntries,
    allowRemoteKnowledge: settings.allowRemoteKnowledge === true,
  };
}

const AGENT_SESSION_FILE = 'agent-session.json';
const AGENT_SESSION_MAX_BYTES = 2 * 1024 * 1024;
const AGENT_HISTORY_LIMIT = 8;
const AGENT_STAGE_LIMIT = 32;
const AGENT_RESULT_MAX_DEPTH = 20;
const AGENT_RESULT_MAX_NODES = 20_000;
const AGENT_RESULT_MAX_STRING = 100_000;
const AGENT_RESULT_MAX_KEYS = 2_000;
const AGENT_RUN_STATUSES = new Set(['running', 'completed', 'failed']);
const AGENT_STAGE_STATUSES = new Set(['pending', 'running', 'completed', 'skipped', 'warning', 'failed']);

function dataPath(name) {
  return path.join(app.getPath('userData'), name);
}

async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(dataPath(name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw new Error(`无法读取 ${name}，原文件已保留：${error.message}`, { cause: error });
  }
}

async function readJsonLimited(name, fallback, maxBytes) {
  try {
    const file = dataPath(name);
    const stats = await fs.stat(file);
    if (stats.size > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节体积上限`);
    const raw = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节体积上限`);
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw new Error(`无法读取 ${name}，原文件已保留：${error.message}`, { cause: error });
  }
}

async function writeJson(name, value) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const destination = dataPath(name);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, destination);
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, { force: true });
  }
}

// 同一主进程内所有 JSON 修改共用队列；失败不会阻断后续操作。
let mutationQueue = Promise.resolve();
function serializeMutation(operation) {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => {});
  return result;
}

function invalidAgentSession(message) {
  const error = new TypeError(`Agent 会话数据无效：${message}`);
  error.code = 'ERR_AGENT_SESSION_INVALID';
  return error;
}

function cleanAgentString(value, field, maxLength, required = false) {
  if (typeof value !== 'string') throw invalidAgentSession(`${field} 必须是字符串`);
  const clean = value.trim().slice(0, maxLength);
  if (required && !clean) throw invalidAgentSession(`${field} 不能为空`);
  return clean;
}

function optionalAgentString(record, key, maxLength, field) {
  if (!(key in record)) return undefined;
  return cleanAgentString(record[key], field, maxLength);
}

function cloneJsonSnapshot(value, field) {
  const ancestors = new Set();
  const state = { nodes: 0 };

  function validate(item, location, depth) {
    state.nodes += 1;
    if (state.nodes > AGENT_RESULT_MAX_NODES) throw invalidAgentSession(`${field} 节点过多`);
    if (depth > AGENT_RESULT_MAX_DEPTH) throw invalidAgentSession(`${field} 嵌套过深`);
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (item.length > AGENT_RESULT_MAX_STRING) throw invalidAgentSession(`${location} 字符串过长`);
      return;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw invalidAgentSession(`${location} 必须是有限数值`);
      return;
    }
    if (typeof item !== 'object') throw invalidAgentSession(`${location} 不是 JSON-safe 值`);
    if (Object.prototype.toString.call(item) !== '[object Array]' && Object.prototype.toString.call(item) !== '[object Object]') {
      throw invalidAgentSession(`${location} 不是普通 JSON 对象或数组`);
    }
    if (ancestors.has(item)) throw invalidAgentSession(`${field} 包含循环引用`);
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (item.length > AGENT_RESULT_MAX_KEYS) throw invalidAgentSession(`${location} 数组过长`);
      for (let index = 0; index < item.length; index += 1) validate(item[index], `${location}[${index}]`, depth + 1);
    } else {
      const keys = Object.keys(item);
      if (keys.length > AGENT_RESULT_MAX_KEYS) throw invalidAgentSession(`${location} 字段过多`);
      for (const key of keys) {
        if (key.length > 200) throw invalidAgentSession(`${location} 字段名过长`);
        validate(item[key], `${location}.${key}`, depth + 1);
      }
    }
    ancestors.delete(item);
  }

  validate(value, field, 0);
  return JSON.parse(JSON.stringify(value));
}

function normalizeAgentStage(stage, index, runField) {
  if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
    throw invalidAgentSession(`${runField}.stages[${index}] 必须是对象`);
  }
  const status = cleanAgentString(stage.status, `${runField}.stages[${index}].status`, 24, true);
  if (!AGENT_STAGE_STATUSES.has(status)) throw invalidAgentSession(`${runField}.stages[${index}].status 非法`);
  return {
    id: cleanAgentString(stage.id, `${runField}.stages[${index}].id`, 80, true),
    label: cleanAgentString(stage.label, `${runField}.stages[${index}].label`, 200, true),
    status,
    detail: cleanAgentString(stage.detail ?? '', `${runField}.stages[${index}].detail`, 2_000),
  };
}

function normalizeAgentRun(run, field) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw invalidAgentSession(`${field} 必须是对象`);
  const status = cleanAgentString(run.status, `${field}.status`, 24, true);
  if (!AGENT_RUN_STATUSES.has(status)) throw invalidAgentSession(`${field}.status 非法`);
  if (!Array.isArray(run.stages)) throw invalidAgentSession(`${field}.stages 必须是数组`);
  const stages = run.stages.slice(0, AGENT_STAGE_LIMIT).map((stage, index) => normalizeAgentStage(stage, index, field));
  if (new Set(stages.map((stage) => stage.id)).size !== stages.length) {
    throw invalidAgentSession(`${field}.stages 包含重复 id`);
  }
  const clean = {
    id: cleanAgentString(run.id, `${field}.id`, 128, true),
    title: cleanAgentString(run.title, `${field}.title`, 1_200, true),
    status,
    startedAt: cleanAgentString(run.startedAt, `${field}.startedAt`, 64, true),
    stages,
  };
  for (const [key, maxLength] of [['summary', 8_000], ['page', 80], ['endedAt', 64]]) {
    const value = optionalAgentString(run, key, maxLength, `${field}.${key}`);
    if (value !== undefined) clean[key] = value;
  }
  if ('interrupted' in run) {
    if (typeof run.interrupted !== 'boolean') throw invalidAgentSession(`${field}.interrupted 必须是布尔值`);
    clean.interrupted = run.interrupted;
  }
  if ('result' in run) clean.result = cloneJsonSnapshot(run.result, `${field}.result`);
  return clean;
}

function normalizeAgentSession(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidAgentSession('外层必须是对象');
  if (input.version !== 1) throw invalidAgentSession('version 必须为 1');
  if (!Number.isSafeInteger(input.totalRuns) || input.totalRuns < 0) {
    throw invalidAgentSession('totalRuns 必须是非负安全整数');
  }
  if (!('active' in input) || (input.active !== null && (typeof input.active !== 'object' || Array.isArray(input.active)))) {
    throw invalidAgentSession('active 必须是对象或 null');
  }
  if (!Array.isArray(input.history)) throw invalidAgentSession('history 必须是数组');
  return {
    version: 1,
    totalRuns: input.totalRuns,
    active: input.active === null ? null : normalizeAgentRun(input.active, 'active'),
    history: input.history.slice(0, AGENT_HISTORY_LIMIT).map((run, index) => normalizeAgentRun(run, `history[${index}]`)),
  };
}

function assertAgentSessionSize(value, label, indentation = 0) {
  let json;
  try {
    json = JSON.stringify(value, null, indentation);
  } catch (error) {
    throw invalidAgentSession(`${label} 不能序列化为 JSON：${error.message}`);
  }
  if (typeof json !== 'string') throw invalidAgentSession(`${label} 不能序列化为 JSON`);
  if (Buffer.byteLength(json, 'utf8') > AGENT_SESSION_MAX_BYTES) {
    throw invalidAgentSession(`${label} 超过 ${AGENT_SESSION_MAX_BYTES} 字节体积上限`);
  }
}

function defaultAgentSession() {
  return { version: 1, totalRuns: 0, active: null, history: [] };
}

async function loadAgentSession() {
  const saved = await readJsonLimited(AGENT_SESSION_FILE, defaultAgentSession(), AGENT_SESSION_MAX_BYTES);
  try {
    return normalizeAgentSession(saved);
  } catch (error) {
    throw new Error(`${AGENT_SESSION_FILE} 会话数据格式无效，原文件已保留：${error.message}`, { cause: error });
  }
}

async function saveAgentSessionRecord(input) {
  assertAgentSessionSize(input, '传入会话');
  const clean = normalizeAgentSession(input);
  assertAgentSessionSize(clean, '清理后的会话', 2);
  await loadAgentSession();
  await writeJson(AGENT_SESSION_FILE, clean);
  return clean;
}

async function loadSettings() {
  const saved = await readJson('settings.json', {});
  const settings = { ...DEFAULT_SETTINGS, ...saved, ...sanitizeRetrievalSettings(saved) };
  if (saved.remoteApiKeyEncrypted) {
    try {
      settings.remoteApiKey = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(saved.remoteApiKeyEncrypted, 'base64'))
        : '';
    } catch {
      settings.remoteApiKey = '';
    }
  }
  delete settings.remoteApiKeyEncrypted;
  return settings;
}

async function saveSettingsRecord(input) {
  await readJson('settings.json', {});
  const settings = {
    ...DEFAULT_SETTINGS,
    ...input,
    ...sanitizeRetrievalSettings(input),
    provider: ['local-rules', 'ollama', 'openai-compatible'].includes(input.provider)
      ? input.provider
      : 'local-rules',
  };
  const record = { ...settings };
  delete record.remoteApiKey;
  if (settings.remoteApiKey && safeStorage.isEncryptionAvailable()) {
    record.remoteApiKeyEncrypted = safeStorage.encryptString(settings.remoteApiKey).toString('base64');
  }
  await writeJson('settings.json', record);
  return settings;
}

async function loadUserKnowledge() {
  return readJson('user-knowledge.json', []);
}

async function saveUserKnowledgeRecord(entries) {
  await readJson('user-knowledge.json', []);
  const clean = Array.isArray(entries) ? entries.slice(0, 500) : [];
  await writeJson('user-knowledge.json', clean);
  return clean;
}

async function loadProjects() {
  const projects = await readJson('projects.json', []);
  if (!Array.isArray(projects) || projects.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('projects.json 项目数据格式无效，原文件已保留。');
  }
  return projects;
}

async function saveProjectRecord(project) {
  if (!project || typeof project !== 'object') throw new Error('项目数据无效。');
  const projects = await loadProjects();
  const now = new Date().toISOString();
  const id = String(project.id || `project-${randomUUID()}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const clean = {
    ...project,
    id,
    name: String(project.name || '未命名电路').slice(0, 80),
    createdAt: project.createdAt || now,
    updatedAt: now,
    components: Array.isArray(project.components) ? project.components.slice(0, 1000) : [],
    wires: Array.isArray(project.wires) ? project.wires.slice(0, 2000) : [],
  };
  const index = projects.findIndex((item) => item.id === id);
  if (index >= 0) projects[index] = clean;
  else projects.unshift(clean);
  await writeJson('projects.json', projects.slice(0, 100));
  return clean;
}

async function deleteProjectRecord(id) {
  const projects = await loadProjects();
  const filtered = projects.filter((item) => item.id !== id);
  await writeJson('projects.json', filtered);
  return filtered;
}

function saveSettings(input) { return serializeMutation(() => saveSettingsRecord(input)); }
function saveUserKnowledge(entries) { return serializeMutation(() => saveUserKnowledgeRecord(entries)); }
function saveProject(project) { return serializeMutation(() => saveProjectRecord(project)); }
function deleteProject(id) { return serializeMutation(() => deleteProjectRecord(id)); }
function saveAgentSession(input) { return serializeMutation(() => saveAgentSessionRecord(input)); }

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  loadUserKnowledge,
  saveUserKnowledge,
  loadProjects,
  saveProject,
  deleteProject,
  loadAgentSession,
  saveAgentSession,
};
