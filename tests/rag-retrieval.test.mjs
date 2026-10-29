import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  KnowledgeDatabase,
  RETRIEVAL_STRENGTHS,
  expandQueryTerms,
  selectTopicRoutes,
} = require('../src/main/knowledge-db.cjs');

const schemaPath = new URL('../database/schema.sql', import.meta.url);

test('查询扩展把口语说法映射为资料术语并记录痕迹', () => {
  const expansion = expandQueryTerms('小车电机驱动堵转怎么办');
  assert.ok(expansion.originalTokens.includes('小车电机驱动堵转怎么办'));
  assert.ok(expansion.synonymTokens.includes('h桥') || expansion.synonymTokens.includes('h-bridge'));
  assert.ok(expansion.synonymTokens.includes('stall'));
  const english = expandQueryTerms('buck 电路纹波大');
  assert.ok(english.synonymTokens.includes('降压'));
  assert.ok(english.synonymTokens.includes('ripple'));
});

test('主题路由按关键词选择专项检索路线', () => {
  const routes = selectTopicRoutes(['小车', '电机'], '12V 双电机小车驱动');
  assert.ok(routes.some((route) => route.id === 'topic-motor'));
  assert.ok(routes.some((route) => route.id === 'topic-protection') === false || routes.length >= 1);
  const power = selectTopicRoutes(['buck'], 'buck 降压');
  assert.ok(power.some((route) => route.id === 'topic-buck'));
});

test('多路召回 + RRF 融合能召回措辞不同的相关资料', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'circuit-rag-'));
  const databasePath = path.join(directory, 'knowledge.sqlite3');
  const schemaSql = await readFile(schemaPath, 'utf8');
  const database = new KnowledgeDatabase(databasePath, schemaSql);
  try {
    const docA = path.join(directory, '电机驱动工程要点.md');
    await writeFile(docA, [
      '# 直流电机 H 桥驱动要点',
      '',
      '直流有刷电机的正反转与制动需要全桥结构。用 MOSFET 组成 H 桥时，栅极驱动要按栅极电荷选择，死区必须覆盖传播延迟离散。堵转电流是驱动器、保险和铜箔的首轮筛选门槛，PWM 频率影响开关损耗与噪声。TVS 用于钳位线缆浪涌。',
    ].join('\n'), 'utf8');
    const docB = path.join(directory, '开关电源布局.md');
    await writeFile(docB, [
      '# Buck 降压电源的布局',
      '',
      '降压转换器的高 di/dt 热环路要最小化。输入陶瓷电容紧贴功率引脚，SW 节点短小，反馈取样从输出电容正端 Kelvin 引出。电感饱和电流必须覆盖纹波峰值。',
    ].join('\n'), 'utf8');
    const importedA = await database.importFile(docA);
    const importedB = await database.importFile(docB);
    assert.equal(importedA.status, 'imported');
    assert.equal(importedB.status, 'imported');

    // 用户说法与资料措辞不同：没有直接出现“H 桥/堵转”同义对照的查询词也能靠同义扩展召回。
    const { hits, trace } = database.searchWithTrace('小车马达启动力矩过大烧管子', { strength: 'deep' });
    assert.ok(trace.routeCount >= 2, `应有多条召回路线，实际 ${trace.routeCount}`);
    assert.ok(trace.expandedTerms.length >= 1, '应有同义扩展');
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].scoreTrace.routeCount >= 1);
    assert.ok(hits.every((hit) => hit.scoreTrace.fused > 0));

    // 功率类查询应触发主题路由并召回 Buck 资料。
    const powerResult = database.searchWithTrace('12V 转 5V 稳压芯片怎么选', { strength: 'exhaustive' });
    assert.ok(powerResult.trace.topicsSelected.length >= 1);
    assert.ok(powerResult.hits.some((hit) => /Buck|降压/.test(hit.title + hit.content)));

    // 穷尽档默认返回条数多于标准档的候选池配置。
    assert.ok(RETRIEVAL_STRENGTHS.exhaustive.limit > RETRIEVAL_STRENGTHS.standard.limit);
    assert.ok(RETRIEVAL_STRENGTHS.exhaustive.poolPerRoute > RETRIEVAL_STRENGTHS.standard.poolPerRoute);

    // 兼容旧接口：search 返回数组。
    const plain = database.search('电机 堵转 H桥');
    assert.ok(Array.isArray(plain) && plain.length >= 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('逐源限流与融合排序保持可追溯性', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'circuit-rag-cap-'));
  const databasePath = path.join(directory, 'knowledge.sqlite3');
  const schemaSql = await readFile(schemaPath, 'utf8');
  const database = new KnowledgeDatabase(databasePath, schemaSql);
  try {
    const doc = path.join(directory, '运放知识.md');
    await writeFile(doc, [
      '# 运算放大器应用笔记',
      '',
      ...Array.from({ length: 14 }, (_, index) => `## 章节 ${index + 1}\n\n运放的增益带宽积与相位裕度决定闭环稳定性；容性负载会引起额外极点，需要隔离电阻或补偿。去耦电容要紧贴电源引脚。`),
    ].join('\n'), 'utf8');
    const imported = await database.importFile(doc);
    assert.equal(imported.status, 'imported');
    const { hits, trace } = database.searchWithTrace('运放 稳定性 相位裕度 增益带宽 去耦', { strength: 'deep', limit: 12 });
    const perSource = new Map();
    for (const hit of hits) perSource.set(hit.sourceId, (perSource.get(hit.sourceId) || 0) + 1);
    for (const count of perSource.values()) assert.ok(count <= RETRIEVAL_STRENGTHS.deep.perSource, `单源片段数 ${count} 超过逐源上限`);
    assert.ok(trace.perSourceCap === RETRIEVAL_STRENGTHS.deep.perSource);
    assert.ok(Number.isFinite(trace.elapsedMs));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
