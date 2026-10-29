import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const source = await fs.readFile(new URL('../src/main/storage.cjs', import.meta.url), 'utf8');

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'circuit-storage-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const module = { exports: {} };
  const sandboxRequire = (name) => {
    if (name === 'electron') return {
      app: { getPath: (key) => { assert.equal(key, 'userData'); return directory; } },
      safeStorage: { isEncryptionAvailable: () => false },
    };
    if (name === 'node:fs/promises') return { ...fs, ...overrides };
    return require(name);
  };
  runInNewContext('(function(require, module) {' + source + '\n})', { structuredClone, Buffer })(sandboxRequire, module);
  return {
    storage: module.exports,
    directory,
    file: path.join(directory, 'projects.json'),
    agentFile: path.join(directory, 'agent-session.json'),
  };
}

function makeAgentRun(index, overrides = {}) {
  return {
    id: `run-${index}`,
    title: `任务 ${index}`,
    status: 'completed',
    startedAt: '2026-09-14T08:00:00.000Z',
    endedAt: '2026-09-14T08:00:01.000Z',
    summary: `结果 ${index}`,
    page: 'designer',
    stages: [
      { id: 'build', label: '生成方案', status: 'completed', detail: '完成' },
      { id: 'audit', label: '工程审查', status: 'completed', detail: '通过' },
    ],
    ...overrides,
  };
}

test('并发保存全部保留；保存/删除共用 FIFO 读改写队列', async (t) => {
  const { storage, file } = await fixture(t);
  await Promise.all(Array.from({ length: 40 }, (_, i) => storage.saveProject({ id: `p${i}`, name: `项目 ${i}` })));
  assert.equal((await storage.loadProjects()).length, 40);
  await Promise.all([
    storage.saveProject({ id: 'new' }),
    storage.deleteProject('p0'),
    storage.saveProject({ id: 'p1', name: 'updated' }),
    storage.deleteProject('new'),
    storage.saveProject({ id: 'last' }),
  ]);
  const projects = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(projects.length, 40);
  assert.ok(!projects.some(({ id }) => id === 'p0' || id === 'new'));
  assert.equal(projects.find(({ id }) => id === 'p1').name, 'updated');
  assert.ok(projects.some(({ id }) => id === 'last'));
});

test('无 id 并发新建不会因同毫秒时间戳覆盖', async (t) => {
  const { storage } = await fixture(t);
  const saved = await Promise.all(Array.from({ length: 30 }, () => storage.saveProject({ name: '新建' })));
  assert.equal(new Set(saved.map(({ id }) => id)).size, 30);
  assert.equal((await storage.loadProjects()).length, 30);
});

test('损坏 JSON/非法项目结构报错且原样保留，队列失败后仍可继续', async (t) => {
  const { storage, file } = await fixture(t);
  assert.equal((await storage.loadProjects()).length, 0);
  for (const broken of ['{"broken":', '{}', 'null', '[null]']) {
    await fs.writeFile(file, broken);
    await assert.rejects(storage.loadProjects(), /原文件已保留/);
    await assert.rejects(storage.saveProject({ id: 'must-not-save' }), /原文件已保留/);
    await assert.rejects(storage.deleteProject('missing'), /原文件已保留/);
    assert.equal(await fs.readFile(file, 'utf8'), broken);
  }
  await fs.writeFile(file, '[]');
  await storage.saveProject({ id: 'recovered' });
  assert.equal((await storage.loadProjects())[0].id, 'recovered');
});

test('权限读取错误不可当成空项目覆盖', async (t) => {
  const { storage, file } = await fixture(t, {
    readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  await fs.writeFile(file, '[{"id":"original"}]');
  await assert.rejects(storage.saveProject({ id: 'new' }), /denied/);
  assert.equal(await fs.readFile(file, 'utf8'), '[{"id":"original"}]');
});

test('原子替换前旧文件完整可读；临时文件同目录且 rename 失败不破坏原件', async (t) => {
  let rejectRename = false;
  let replacements = 0;
  const { storage, file, directory } = await fixture(t, {
    rename: async (temporary, destination) => {
      assert.equal(path.dirname(temporary), path.dirname(destination));
      assert.match(temporary, /\.tmp$/);
      const next = JSON.parse(await fs.readFile(temporary, 'utf8'));
      assert.ok(Array.isArray(next));
      if (replacements > 0) assert.equal(JSON.parse(await fs.readFile(destination, 'utf8'))[0].id, 'original');
      if (rejectRename) throw new Error('simulated rename failure');
      replacements += 1;
      return fs.rename(temporary, destination);
    },
  });
  await storage.saveProject({ id: 'original' });
  const before = await fs.readFile(file, 'utf8');
  rejectRename = true;
  await assert.rejects(storage.saveProject({ id: 'failed' }), /simulated rename failure/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(directory), ['projects.json']);
  rejectRename = false;
  await storage.saveProject({ id: 'recovered' });
  assert.equal((await storage.loadProjects()).length, 2);
  assert.deepEqual(await fs.readdir(directory), ['projects.json']);
});

test('设置/知识保存兼容旧配置，损坏 JSON 同样禁止覆盖', async (t) => {
  const { storage, directory } = await fixture(t);
  const settings = await storage.loadSettings();
  assert.equal(settings.ollamaBaseUrl, 'http://127.0.0.1:11434');
  await storage.saveSettings({ provider: 'ollama', ollamaModel: 'legacy-model' });
  assert.equal((await storage.loadSettings()).ollamaModel, 'legacy-model');
  await storage.saveUserKnowledge([{ title: '测试' }]);
  assert.equal((await storage.loadUserKnowledge())[0].title, '测试');
  for (const [name, save] of [
    ['settings.json', () => storage.saveSettings({ provider: 'local-rules' })],
    ['user-knowledge.json', () => storage.saveUserKnowledge([])],
  ]) {
    const file = path.join(directory, name);
    await fs.writeFile(file, '{bad');
    await assert.rejects(save(), /原文件已保留/);
    assert.equal(await fs.readFile(file, 'utf8'), '{bad');
  }
});

test('Agent 会话缺省值稳定，保存后可完整往返 JSON 结果快照', async (t) => {
  const { storage, agentFile } = await fixture(t);
  const empty = await storage.loadAgentSession();
  assert.equal(JSON.stringify(empty), JSON.stringify({ version: 1, totalRuns: 0, active: null, history: [] }));

  const active = makeAgentRun(2, {
    status: 'running',
    endedAt: undefined,
    summary: undefined,
    result: { plan: { title: '5 V 电源', values: [5, true, null] } },
  });
  delete active.endedAt;
  delete active.summary;
  const completed = makeAgentRun(1, { interrupted: true, result: { audit: { score: 92 } } });
  const saved = await storage.saveAgentSession({ version: 1, totalRuns: 2, active, history: [completed] });
  const loaded = await storage.loadAgentSession();

  assert.equal(saved.totalRuns, 2);
  assert.equal(loaded.active.status, 'running');
  assert.equal(loaded.history[0].interrupted, true);
  assert.equal(loaded.history[0].result.audit.score, 92);
  assert.equal(loaded.active.result.plan.values[2], null);
  assert.equal(JSON.parse(await fs.readFile(agentFile, 'utf8')).version, 1);
});

test('Agent 会话清理未知字段并截断历史、阶段和长字符串', async (t) => {
  const { storage } = await fixture(t);
  const stages = Array.from({ length: 40 }, (_, index) => ({
    id: `stage-${index}`,
    label: ` 阶段 ${index} ${'L'.repeat(220)} `,
    status: index === 0 ? ' warning ' : 'completed',
    detail: ` ${'D'.repeat(2_100)} `,
    ignored: true,
  }));
  const history = Array.from({ length: 12 }, (_, index) => makeAgentRun(index, {
    title: ` ${'T'.repeat(1_300)} `,
    summary: ` ${'S'.repeat(8_100)} `,
    stages,
    ignored: 'drop me',
  }));
  const saved = await storage.saveAgentSession({
    version: 1,
    totalRuns: 12,
    active: null,
    history,
    ignored: 'drop me',
  });

  assert.equal(saved.history.length, 8);
  assert.equal(saved.history[0].stages.length, 32);
  assert.equal(saved.history[0].title.length, 1_200);
  assert.equal(saved.history[0].summary.length, 8_000);
  assert.equal(saved.history[0].stages[0].label.length, 200);
  assert.equal(saved.history[0].stages[0].detail.length, 2_000);
  assert.equal(saved.history[0].stages[0].status, 'warning');
  assert.ok(!('ignored' in saved));
  assert.ok(!('ignored' in saved.history[0]));
  assert.ok(!('ignored' in saved.history[0].stages[0]));
});

test('Agent 会话拒绝超大输入和非 JSON-safe 结果', async (t) => {
  const { storage } = await fixture(t);
  await assert.rejects(storage.saveAgentSession({
    version: 1,
    totalRuns: 1,
    active: null,
    history: [makeAgentRun(1, { result: { blob: 'x'.repeat(2_100_000) } })],
  }), /体积上限/);

  await assert.rejects(storage.saveAgentSession({
    version: 1,
    totalRuns: 1,
    active: null,
    history: [makeAgentRun(1, { result: { value: undefined } })],
  }), /JSON-safe/);
});

test('Agent 会话损坏或结构非法时保留原文件并拒绝覆盖', async (t) => {
  const { storage, agentFile } = await fixture(t);
  const replacement = { version: 1, totalRuns: 1, active: null, history: [makeAgentRun(1)] };
  const brokenRecords = [
    '{bad',
    '{}',
    JSON.stringify({ version: 1, totalRuns: 1, active: null, history: [makeAgentRun(1, { status: 'unknown' })] }),
  ];

  for (const broken of brokenRecords) {
    await fs.writeFile(agentFile, broken);
    await assert.rejects(storage.loadAgentSession(), /原文件已保留/);
    await assert.rejects(storage.saveAgentSession(replacement), /原文件已保留/);
    assert.equal(await fs.readFile(agentFile, 'utf8'), broken);
  }

  const oversized = ' '.repeat(2_100_000);
  await fs.writeFile(agentFile, oversized);
  await assert.rejects(storage.loadAgentSession(), /体积上限/);
  await assert.rejects(storage.saveAgentSession(replacement), /体积上限/);
  assert.equal((await fs.stat(agentFile)).size, oversized.length);
});

test('Agent 会话并发保存复用 FIFO 队列，最终文件保持完整有效', async (t) => {
  const { storage, agentFile } = await fixture(t);
  const writes = Array.from({ length: 30 }, (_, index) => storage.saveAgentSession({
    version: 1,
    totalRuns: index + 1,
    active: null,
    history: [makeAgentRun(index)],
  }));
  await Promise.all(writes);

  const raw = JSON.parse(await fs.readFile(agentFile, 'utf8'));
  const loaded = await storage.loadAgentSession();
  assert.equal(raw.totalRuns, 30);
  assert.equal(raw.history[0].id, 'run-29');
  assert.equal(loaded.totalRuns, 30);
  assert.equal(loaded.history[0].stages.length, 2);
});

test('Agent 会话 IPC 与 preload 桥接名称保持一致', async () => {
  const [mainSource, preloadSource] = await Promise.all([
    fs.readFile(new URL('../src/main/main.cjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/main/preload.cjs', import.meta.url), 'utf8'),
  ]);
  assert.match(mainSource, /ipcMain\.handle\('agent-session:get'.*storage\.loadAgentSession\(\)/);
  assert.match(mainSource, /ipcMain\.handle\('agent-session:save'.*storage\.saveAgentSession\(session\)/);
  assert.match(preloadSource, /getAgentSession: \(\) => ipcRenderer\.invoke\('agent-session:get'\)/);
  assert.match(preloadSource, /saveAgentSession: \(session\) => ipcRenderer\.invoke\('agent-session:save', session\)/);
});
