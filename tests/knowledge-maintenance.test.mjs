import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { generateCircuit } from '../src/shared/core.mjs';
import { auditKnowledge } from '../scripts/audit-knowledge.mjs';

const require = createRequire(import.meta.url);
const { KnowledgeDatabase } = require('../src/main/knowledge-db.cjs');
const schema = readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8');
const source = {
  title: '旧标题', url: 'https://example.com/maintained-note', publisher: '旧出版者',
  content: '维护测试：电源分配网络必须核对允许电压波动和瞬态电流，目标阻抗等于电压波动除以瞬态电流，量纲为欧姆。',
  rightsStatus: 'unknown', rightsNote: '测试摘要', metadata: { authorityTier: 'A' },
};

test('实际知识库结构、幂等导入与专项查询同时通过', () => {
  const report = auditKnowledge();
  assert.equal(report.passed, report.total, JSON.stringify(report.results.filter(r => !r.pass), null, 2));
});

test('摘要不变时来源元数据也更新，并保留 sourceId 与导入记录关联', () => {
  const db = new KnowledgeDatabase(':memory:', schema);
  try {
    const first = db.importWebSource(source);
    const next = { ...source, title: '更新后的电源资料', publisher: '新出版者', authors: '作者', isbn: '1234567890',
      accessedAt: '2026-10-19', rightsStatus: 'licensed', rightsNote: '更新后的许可说明',
      metadata: { authorityTier: 'A+', comparison: '经核对的适用边界' } };
    const updated = db.importWebSource(next);
    assert.equal(updated.status, 'updated');
    assert.equal(updated.sourceId, first.sourceId);
    const hit = db.search('目标阻抗')[0];
    assert.equal(hit.title, next.title);
    assert.equal(hit.publisher, next.publisher);
    assert.equal(hit.authorityTier, 'A+');
    assert.equal(hit.rightsStatus, 'licensed');
    assert.equal(db.db.prepare('SELECT rights_note FROM library_sources').get().rights_note, next.rightsNote);
    assert.ok(db.db.prepare('SELECT source_id FROM import_log').all().every(r => r.source_id === first.sourceId));
    assert.equal(db.importWebSource(next).status, 'duplicate');
    assert.equal(Number(db.stats().source_count), 1);
  } finally { db.close(); }
});

test('未提供访问时间的相同摘要仍幂等，正文修订保留来源 ID 并清理旧索引', () => {
  const db = new KnowledgeDatabase(':memory:', schema);
  try {
    const first = db.importWebSource({ ...source, content: source.content + ' 独有旧词quartzold' });
    assert.equal(db.importWebSource({ ...source, content: source.content + ' 独有旧词quartzold' }).status, 'duplicate');
    const updated = db.importWebSource({ ...source, content: source.content + ' 独有新词quartznew' });
    assert.equal(updated.sourceId, first.sourceId);
    assert.equal(db.search('quartzold').length, 0);
    assert.equal(db.search('quartznew')[0].sourceId, first.sourceId);
    assert.equal(Number(db.stats().source_count), 1);
  } finally { db.close(); }
});

test('摘要更新中途失败时保留旧正文、来源和全文索引', () => {
  const db = new KnowledgeDatabase(':memory:', schema);
  try {
    const first = db.importWebSource(source);
    db.db.exec("CREATE TRIGGER fail_chunk BEFORE INSERT ON knowledge_chunks BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => db.importWebSource({ ...source, content: source.content + ' 更新正文' }), /test failure/);
    assert.equal(db.search('目标阻抗')[0].sourceId, first.sourceId);
    assert.equal(db.search('目标阻抗')[0].content, source.content);
  } finally { db.close(); }
});

test('知识规则在截取前按电路类型筛选，避免无关高分条目挤掉有效规则', () => {
  const decoys = Array.from({ length: 9 }, (_, i) => ({
    id: `decoy-${i}`, title: 'buck 降压 电源 环路 EMI 热环路',
    tags: ['buck', '降压', '电源', '环路', 'EMI', '热环路'], verified: true,
    source: { title: '测试来源', url: 'https://example.com/decoy' },
    rules: { appliesTo: ['opamp'], requiredChecks: ['不应混入的运放规则'] },
  }));
  const applicable = { id: 'valid-buck', title: 'buck', tags: ['buck'], verified: true,
    source: { title: '测试来源', url: 'https://example.com/buck' },
    rules: { appliesTo: ['buck'], requiredChecks: ['必须核对最小导通时间'] } };
  const plan = generateCircuit('12V 输入 5V 输出 1A buck', [...decoys, applicable]);
  assert.ok(plan.knowledgeEvidence.some(e => e.id === applicable.id));
  assert.ok(plan.engineeringChecks.includes('必须核对最小导通时间'));
  assert.ok(!plan.engineeringChecks.includes('不应混入的运放规则'));
});

test('书目视图可执行文档中的来源和版权备注查询', () => {
  const db = new KnowledgeDatabase(':memory:', schema);
  try {
    db.importWebSource(source);
    const row = db.db.prepare('SELECT title, source_url, accessed_at, rights_status, rights_note FROM library_catalog').get();
    assert.equal(row.rights_note, source.rightsNote);
  } finally { db.close(); }
});
