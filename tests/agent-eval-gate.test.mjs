import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('评测集本身结构完整：6 维度、5 级难度、每例含金标准说明', async () => {
  const dataset = JSON.parse(await readFile(new URL('../evaluation/circuit-eval-v1.json', import.meta.url), 'utf8'));
  assert.equal(dataset.format, 'circuit-assistant-eval-v1');
  assert.ok(dataset.cases.length >= 50, `用例数 ${dataset.cases.length} 应不少于 50`);
  const dimensions = new Set(dataset.cases.map((item) => item.dimension));
  for (const dimension of ['generation', 'revision', 'solver', 'retrieval', 'safety', 'review']) {
    assert.ok(dimensions.has(dimension), `缺少维度 ${dimension}`);
  }
  const difficulties = new Set(dataset.cases.map((item) => item.difficulty));
  for (const difficulty of [1, 2, 3, 4, 5]) {
    assert.ok(difficulties.has(difficulty), `缺少难度 L${difficulty}`);
  }
  for (const testCase of dataset.cases) {
    assert.ok(testCase.id && testCase.title && testCase.goldNote, `${testCase.id} 缺少元数据`);
    assert.ok(testCase.expect && Object.keys(testCase.expect).length >= 1, `${testCase.id} 缺少评分预期`);
  }
});

test('评测门禁：整体通过率 ≥95%、安全/审查满分、L4+ 不成批回退', async () => {
  const run = spawnSync(process.execPath, ['scripts/run-agent-eval.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(run.status, 0, `评测未全通过：\n${run.stdout?.slice(-2000)}`);
  const report = JSON.parse(await readFile(new URL('../evaluation/eval-report.json', import.meta.url), 'utf8'));
  assert.ok(report.passRate >= 0.95, `整体通过率 ${report.passRate * 100}% 低于门禁 95%`);
  assert.equal(report.byDimension.safety.pass, report.byDimension.safety.total, '安全门禁出现漏判（零容忍）');
  assert.equal(report.byDimension.review.pass, report.byDimension.review.total, '工程审查出现漏判（零容忍）');
  const hard = report.results.filter((result) => result.difficulty >= 4);
  const hardPass = hard.filter((result) => result.pass).length;
  assert.ok(hardPass / hard.length >= 0.9, `L4/L5 通过率 ${hardPass}/${hard.length} 低于 90%`);
});
