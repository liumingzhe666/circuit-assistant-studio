import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  KnowledgeDatabase,
  cjkSearchTerms,
  splitPage,
} = require('../src/main/knowledge-db.cjs');

const schemaPath = new URL('../database/schema.sql', import.meta.url);

test('中文检索词会生成适合 SQLite FTS5 的双字词', () => {
  const terms = cjkSearchTerms('集成电路版图设计与 MOSFET 匹配');
  assert.match(terms, /集成/);
  assert.match(terms, /版图/);
  assert.match(terms, /mosfet/);
});

test('长页面会切块并保留重叠与页码', () => {
  const chunks = splitPage(`第一章 版图基础\n\n${'差分对匹配与保护环。'.repeat(240)}`, 12, 500, 80);
  assert.ok(chunks.length > 3);
  assert.equal(chunks[0].pageStart, 12);
  assert.match(chunks[0].heading, /第一章/);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 520));
});

test('资料导入 SQLite 后可检索、去重并追溯出版社', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'circuit-kb-'));
  const databasePath = path.join(directory, 'knowledge.sqlite3');
  const documentPath = path.join(directory, '集成电路版图设计项目式教程.md');
  const schemaSql = await readFile(schemaPath, 'utf8');
  const database = new KnowledgeDatabase(databasePath, schemaSql);
  try {
    await writeFile(documentPath, '# 集成电路版图设计项目式教程\n\n电子工业出版社\n\n差分对版图需要重视器件匹配、对称放置和公共质心。保护环用于隔离衬底噪声。', 'utf8');
    const imported = await database.importFile(documentPath);
    assert.equal(imported.status, 'imported');
    assert.equal(imported.publisher, '电子工业出版社');
    assert.ok(imported.chunkCount >= 1);

    const hits = database.search('差分对 公共质心 版图', { limit: 5 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].title, '集成电路版图设计项目式教程');
    assert.equal(hits[0].publisher, '电子工业出版社');
    assert.match(hits[0].content, /公共质心/);

    const duplicate = await database.importFile(documentPath);
    assert.equal(duplicate.status, 'duplicate');
    const stats = database.stats();
    assert.equal(Number(stats.source_count), 1);
    assert.equal(Number(stats.chunk_count), imported.chunkCount);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('公开网页摘要会保存 URL、版权备注并进入全文检索', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'circuit-web-kb-'));
  const databasePath = path.join(directory, 'knowledge.sqlite3');
  const schemaSql = await readFile(schemaPath, 'utf8');
  const database = new KnowledgeDatabase(databasePath, schemaSql);
  try {
    const source = {
      title: '开放 PDK 版图验证摘要',
      url: 'https://example.com/open-pdk-rules',
      publisher: '示例 PDK 作者',
      content: '版图必须分别完成设计规则检查 DRC、版图与原理图一致性检查 LVS，以及寄生参数提取 PEX。具体尺寸只适用于对应工艺版本。',
      rightsStatus: 'licensed',
      rightsNote: '测试用开放许可摘要。',
      accessedAt: '2026-08-08',
      metadata: { authorityTier: 'A+', comparison: '以官方资料为准。' },
    };
    const imported = database.importWebSource(source);
    assert.equal(imported.status, 'imported');
    const hit = database.search('版图 DRC LVS PEX', { limit: 1 })[0];
    assert.equal(hit.sourceUrl, source.url);
    assert.equal(hit.sourceType, 'web');
    assert.equal(hit.rightsStatus, 'licensed');
    assert.match(hit.content, /寄生参数提取/);
    assert.equal(hit.authorityTier, 'A+');
    assert.equal(hit.authorityRank, 2);
    assert.match(hit.sourceComparison, /官方资料/);
    assert.match(database.listSources(1).find((item) => item.title === source.title).metadata_json, /\"authorityTier\":\"A\+\"/);

    const generic = database.importWebSource({
      ...source,
      title: '通用版图验证摘要',
      url: 'https://example.com/generic-layout-rules',
      metadata: {},
    });
    assert.equal(generic.status, 'imported');
    const ranked = database.search('版图 DRC LVS PEX', { limit: 2 });
    assert.equal(ranked[0].sourceUrl, source.url);
    assert.equal(ranked[0].authorityTier, 'A+');
    assert.equal(database.importWebSource(source).status, 'duplicate');
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
