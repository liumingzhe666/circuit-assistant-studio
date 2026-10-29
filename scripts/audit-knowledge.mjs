import assert from 'node:assert/strict';
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { knowledgeSearch } from '../src/shared/core.mjs';

const require = createRequire(import.meta.url);
const { KnowledgeDatabase } = require('../src/main/knowledge-db.cjs');
const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => JSON.parse(readFileSync(path.join(root, 'knowledge', `${name}.json`), 'utf8'));
export const retrievalCases = [
  ['I2C 上拉电阻怎么算', 'fund-i2c-pullup-window', '/slva689/'],
  ['rs-485 终端电阻', 'fund-rs485-termination', '/slla272d/'],
  ['USB-C CC1 CC2 取电', 'fund-usbc-cc-power', '/tusb321.pdf'],
  ['比较器迟滞上下阈值', 'adv-comparator-threshold-budget', '/tidu020a/'],
  ['ADC 过采样 量化噪声', 'adv-adc-noise-oversampling', '/MT-001.pdf'],
  ['ADC 采样混叠 抗混叠滤波', 'fund-sampling-aliasing', '/MT-002.pdf'],
  ['PDN 目标阻抗怎么算', 'expert-decoupling-network', '/swpa222'],
  ['Kelvin 分流电阻测流', 'fund-shunt-kelvin', '/ina180.pdf'],
  ['LDO 输出电容 ESR', 'expert-ldo-stability-thermal', '/slva115a/'],
  ['555 频率容差', 'adv-555-tolerance-budget', '/ne555.pdf'],
  ['Boost 输入电流', 'adv-boost-current-budget', '/slva372d/'],
  ['Buck 纹波峰值', 'adv-buck-ripple-budget', '/slva477b/'],
  ['热阻 θJA ΨJT', 'adv-thermal-metrics-boundary', '/spra953d/'],
];

export function auditKnowledge() {
  const basic = read('basic-circuits');
  const advanced = read('advanced-circuits');
  const sources = read('public-web-sources');
  const entries = [...basic, ...advanced];
  const results = [];
  function check(name, operation) {
    try { results.push({ name, pass: true, detail: operation() }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
  }
  check('内置条目 ID 唯一、字段完整、规则类型合法', () => {
    assert.equal(new Set(entries.map(e => e.id)).size, entries.length);
    const kinds = new Set(['*', 'buck', 'boost', 'ldo', 'opamp', 'timer555', 'rectifier', 'low-side-driver', 'motor-driver', 'led-driver', 'mcu-power', 'rc-filter', 'generic']);
    for (const entry of entries) {
      for (const key of ['id', 'title', 'category', 'summary', 'content']) assert.ok(typeof entry[key] === 'string' && entry[key].trim(), `${entry.id}: ${key}`);
      assert.ok(Array.isArray(entry.tags) && entry.tags.length, entry.id);
      assert.equal(typeof entry.verified, 'boolean', entry.id);
      if (entry.source?.url) assert.equal(new URL(entry.source.url).protocol, 'https:', entry.id);
      for (const kind of entry.rules?.appliesTo || []) assert.ok(kinds.has(kind), `${entry.id}: ${kind}`);
    }
    return entries.length;
  });
  check('公开来源 URL 唯一且含摘要、权利说明和访问时间', () => {
    assert.equal(new Set(sources.map(s => s.url)).size, sources.length);
    for (const source of sources) {
      assert.equal(new URL(source.url).protocol, 'https:');
      assert.ok(source.title && source.content?.length >= 40 && source.rightsNote && source.accessedAt, source.title);
    }
    return sources.length;
  });
  const db = new KnowledgeDatabase(':memory:', readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8'));
  try {
    check('整库首次导入和第二次幂等导入', () => {
      for (const source of sources) assert.equal(db.importWebSource(source).status, 'imported', source.title);
      for (const source of sources) assert.equal(db.importWebSource(source).status, 'duplicate', source.title);
      assert.equal(Number(db.stats().source_count), sources.length);
      return db.stats();
    });
    for (const [query, expectedId, expectedUrl] of retrievalCases) {
      check(`检索：${query}`, () => {
        const builtin = knowledgeSearch(entries, query, 3);
        assert.ok(builtin.some(e => e.id === expectedId), `内置前三未命中 ${expectedId}: ${builtin.map(e => e.id)}`);
        const sql = db.search(query, { limit: 3, strength: 'deep' });
        assert.ok(sql.some(e => e.sourceUrl.includes(expectedUrl)), `SQL 前三未命中 ${expectedUrl}: ${sql.map(e => e.title)}`);
        return { builtin: builtin.map(e => e.id), sql: sql.map(e => ({ title: e.title, url: e.sourceUrl })) };
      });
    }
  } finally { db.close(); }
  return {
    generatedAt: new Date().toISOString(),
    counts: { basic: basic.length, advanced: advanced.length, publicSources: sources.length },
    // Expose legacy provenance gaps without relabeling them as audited sources.
    legacyEntriesWithoutSourceUrl: entries.filter(e => !e.source?.url).map(e => e.id),
    scope: '结构、幂等导入和固定查询检索检查；不自动验证网页可达性、原文语义或实物电路。',
    passed: results.filter(r => r.pass).length, total: results.length, results,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const report = auditKnowledge();
  const outputArg = process.argv.find(arg => arg.startsWith('--output='));
  const output = path.resolve(root, outputArg?.slice('--output='.length) || 'artifacts/knowledge-audit.json');
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Knowledge audit: ${report.passed}/${report.total}; entries=${report.counts.basic + report.counts.advanced}; sources=${report.counts.publicSources}`);
  for (const result of report.results.filter(r => !r.pass)) console.error(`${result.name}: ${result.error}`);
  process.exitCode = report.passed === report.total ? 0 : 1;
}
