import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AgentRun } from '../src/shared/agent-run.mjs';

test('Agent 运行互斥，步骤完成后才允许完成任务', () => {
  const run = new AgentRun();
  assert.equal(run.begin('设计', [['build', '生成'], ['ai', '增强']]), true);
  assert.equal(run.begin('重复提交', []), false);
  run.stage('build', 'running');
  assert.throws(() => run.stage('ai', 'running'), /已有步骤/);
  assert.throws(() => run.finish('伪完成'), /未完成/);
  run.stage('build', 'completed', '7 项器件');
  run.stage('ai', 'skipped', '本地模式');
  run.finish('生成草案，不代表投板');
  assert.equal(run.active.status, 'completed');
  assert.equal(run.history[0].stages[1].status, 'skipped');
});

test('失败记录保留已完成步骤，标记失败和未执行步骤，并允许重试', () => {
  const run = new AgentRun();
  run.begin('设计', [['a', '检索'], ['b', '生成'], ['c', '审查']]);
  run.stage('a', 'completed');
  run.stage('b', 'running');
  run.finish('工具异常', { failed: true });
  assert.deepEqual(run.active.stages.map((s) => s.status), ['completed', 'failed', 'skipped']);
  assert.equal(run.begin('重试', [['a', '检索']]), true);
  assert.throws(() => run.stage('unknown', 'completed'), /未知步骤/);
});

test('降级不冒充模型成功，历史最多保留8项且快照独立', () => {
  const run = new AgentRun();
  for (let i = 0; i < 10; i++) {
    run.begin(`任务${i}`, [['ai', '模型']]);
    run.stage('ai', 'warning', '失败，保留本地结果');
    run.finish('降级完成');
  }
  assert.equal(run.history.length, 8);
  run.active.title = '修改';
  assert.equal(run.history[0].title, '任务9');
  assert.equal(run.history[0].stages[0].status, 'warning');
});

test('完成任务保存独立结果快照，序列化结果也不共享引用', () => {
  const run = new AgentRun();
  const result = { page: 'designer', plan: { title: 'LED', components: [{ ref: 'R1' }] } };
  run.begin('设计 LED', [['build', '生成']]);
  run.stage('build', 'completed');
  run.finish('完成', { result });

  result.plan.title = '外部修改';
  assert.equal(run.active.result.plan.title, 'LED');
  run.active.result.plan.components[0].ref = 'R2';
  assert.equal(run.history[0].result.plan.components[0].ref, 'R1');

  const session = run.serialize(4);
  assert.deepEqual(Object.keys(session), ['version', 'totalRuns', 'active', 'history']);
  assert.equal(session.version, 1);
  assert.equal(session.totalRuns, 4);
  session.history[0].result.plan.title = '序列化对象修改';
  assert.equal(run.history[0].result.plan.title, 'LED');
});

test('恢复跨重启运行时标记中断，历史去重并限制为8项', () => {
  const session = {
    version: 1,
    totalRuns: 12,
    active: {
      id: 'running-task', title: '未完成设计', status: 'running', startedAt: '2026-09-14T01:00:00.000Z',
      stages: [
        { id: 'a', label: '检索', status: 'completed', detail: '完成' },
        { id: 'b', label: '生成', status: 'running', detail: '处理中' },
        { id: 'c', label: '审查', status: 'pending', detail: '' },
      ],
    },
    history: [
      { id: 'running-task', title: '旧副本', status: 'failed', stages: [] },
      ...Array.from({ length: 10 }, (_, index) => ({ id: `old-${index}`, title: `任务${index}`, status: 'completed', stages: [] })),
    ],
  };
  const run = new AgentRun();
  const restored = run.restore(session);

  assert.deepEqual(restored, { totalRuns: 12, interrupted: true });
  assert.equal(run.active.status, 'failed');
  assert.equal(run.active.interrupted, true);
  assert.match(run.active.summary, /中断.*重新运行/);
  assert.deepEqual(run.active.stages.map((stage) => stage.status), ['completed', 'failed', 'skipped']);
  assert.match(run.active.stages[1].detail, /中断/);
  assert.equal(run.history.length, 8);
  assert.equal(run.history[0].id, 'running-task');
  assert.equal(run.history.filter((entry) => entry.id === 'running-task').length, 1);
  assert.equal(session.active.status, 'running');

  const secondRun = new AgentRun();
  const secondRestore = secondRun.restore(run.serialize(restored.totalRuns));
  assert.deepEqual(secondRestore, { totalRuns: 12, interrupted: false });
  assert.equal(secondRun.history.filter((entry) => entry.id === 'running-task').length, 1);
});

test('选择历史记录产生独立活动快照，清空会通知观察者', () => {
  let changes = 0;
  const run = new AgentRun(() => { changes += 1; });
  for (const title of ['第一项', '第二项']) {
    run.begin(title, [['done', '完成']]);
    run.stage('done', 'completed');
    run.finish(`${title}完成`, { result: { title } });
  }
  const changeCount = changes;
  const older = run.history[1];
  assert.equal(run.select(older.id), true);
  assert.equal(changes, changeCount + 1);
  assert.equal(run.active.title, '第一项');
  run.active.result.title = '已修改';
  assert.equal(run.history[1].result.title, '第一项');
  assert.equal(run.select('不存在'), false);
  assert.equal(changes, changeCount + 1);

  run.clear();
  assert.equal(changes, changeCount + 2);
  assert.equal(run.active, null);
  assert.deepEqual(run.history, []);
});

test('恢复畸形会话时安全回退而不抛错', () => {
  const run = new AgentRun();
  assert.doesNotThrow(() => run.restore(null));
  assert.deepEqual(run.restore({ totalRuns: '错误', active: 42, history: '错误' }), { totalRuns: 0, interrupted: false });
  assert.equal(run.active, null);
  assert.deepEqual(run.history, []);
  assert.doesNotThrow(() => run.restore({
    totalRuns: -10,
    active: { id: null, title: null, status: '未知', stages: [null, 'bad', { status: '未知' }], result: () => {} },
    history: [null, 1, { id: 'safe', title: 3, status: 'completed', stages: null }],
  }));
  assert.equal(run.active.status, 'failed');
  assert.equal(run.history.length, 1);

  const finishRun = new AgentRun();
  finishRun.begin('兼容空选项', []);
  assert.doesNotThrow(() => finishRun.finish('完成', null));
});

test('Agent界面具有可访问的任务入口，保留工程边界与减少动画支持', () => {
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  assert.match(html, /id="agent-prompt" maxlength="1200"/);
  assert.match(html, /for="agent-prompt"/);
  assert.match(html, /不自动覆盖工作室/);
  assert.match(html, /id="agent-run-status" role="status" aria-live="polite"/);
  assert.match(css, /prefers-reduced-motion/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});
