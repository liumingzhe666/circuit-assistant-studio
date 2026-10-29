import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../src/main/agent-smoke.cjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dbSource = readFileSync(new URL('../src/main/knowledge-db.cjs', import.meta.url), 'utf8');
const providerSource = readFileSync(new URL('../src/main/ai-provider.cjs', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../src/main/preload.cjs', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main/main.cjs', import.meta.url), 'utf8');
const storageSource = readFileSync(new URL('../src/main/storage.cjs', import.meta.url), 'utf8');

test('0.9.1 版本标识、构建目录和项目导出版本保持一致', () => {
  assert.equal(packageJson.version, '0.9.1');
  assert.equal(packageJson.build.directories.output, 'release-0.9.1');
  assert.equal(packageJson.build.win.signExecutable, false);
  assert.doesNotMatch(packageJson.scripts.dist, /signAndEditExecutable/);
  assert.equal(packageJson.scripts['verify:release'], 'npm run dist && npm run test:packaged');
  assert.match(html, /<title>电路助手 Studio · 0\.9\.1<\/title>/);
  assert.match(html, />Studio 0\.9\.1</);
  assert.match(app, /format:'circuit-assistant-project-v1',version:'0\.9\.1'/);
});

test('画板元件库与市场元件库完整可用', () => {
  const core = readFileSync(new URL('../src/shared/core.mjs', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../src/shared/layout-agent.mjs', import.meta.url), 'utf8');
  assert.match(core, /MARKET_PARTS_LIBRARY/);
  assert.match(core, /symbolType/);
  assert.match(layout, /'tvs-diode', 'photodiode'/);
  assert.match(layout, /'wireless-module'/);
  assert.match(html, /data-inventory-tab="market"/);
  assert.match(html, /id="inventory-market"/);
  assert.match(app, /placeMarketPart/);
  assert.match(app, /renderMarketInventory/);
  assert.match(app, /marketPartId/);
  assert.match(app, /quick-value-row/);
  assert.match(app, /application\/x-circuit-part/);
  assert.match(css, /\.market-group-row/);
  assert.match(css, /\.part-item/);
  assert.match(css, /quick-value-row/);
});

test('RAG 检索强度与追踪面板贯穿主进程与界面', () => {
  assert.match(dbSource, /RETRIEVAL_STRENGTHS/);
  assert.match(dbSource, /searchWithTrace/);
  assert.match(dbSource, /expandQueryTerms/);
  assert.match(dbSource, /TOPIC_ROUTES/);
  assert.match(providerSource, /knowledgeCitations/);
  assert.match(providerSource, /CIRCUIT_DOMAIN_GUIDE/);
  assert.match(providerSource, /allowRemoteKnowledge/);
  assert.match(preloadSource, /searchKnowledgeDebug/);
  assert.match(mainSource, /knowledge:search-debug/);
  assert.match(storageSource, /retrievalStrength/);
  assert.match(html, /id="retrieval-strength"/);
  assert.match(html, /id="retrieval-trace"/);
  assert.match(html, /id="retrieval-strength-select"/);
  assert.match(html, /id="allow-remote-knowledge"/);
  assert.match(app, /searchKnowledgeDebug/);
  assert.match(app, /renderRetrievalTrace/);
  assert.match(app, /localRetrievalTrace/);
  assert.match(app, /activeRetrievalStrength/);
});

test('Agent 工作台使用本机历史、独立结果快照与紧凑首屏', () => {
  assert.doesNotMatch(html, /class="agent-hero"/);
  assert.match(html, /id="agent-history-note">最近 8 次自动保存/);
  assert.match(html, /id="agent-clear-history"/);
  assert.match(app, /desktop\.getAgentSession\(\)/);
  assert.match(app, /desktop\.saveAgentSession\(session\)/);
  assert.match(app, /agentResultSnapshot\('plan', \{ plan, audit \}\)/);
  assert.match(app, /agentResultSnapshot\('optimizer', \{ report \}\)/);
  assert.match(app, /data-agent-history-id/);
  assert.match(css, /\.agent-page \.panel \{[^}]*border-radius: 8px/);
});

test('工作室补齐键盘添加、项目名同步和窄屏抽屉保护', () => {
  assert.match(app, /<button type="button" class="shelf-item" draggable="true"/);
  assert.match(app, /aria-label="添加\$\{esc\(item\.name\)\}"/);
  assert.match(app, /state\.editor\.name=event\.target\.value\.trim\(\)\|\|'未命名电路'/);
  assert.match(app, /syncResponsiveStudioDocks\(true\)/);
  assert.match(app, /window\.innerWidth <= 1220/);
});

test('Electron smoke 覆盖会话重载、最小窗口高度和窄屏面板', () => {
  assert.match(smoke, /重载后恢复运行记录/);
  assert.match(smoke, /width: 1120, height: 720/);
  assert.match(smoke, /首屏可见最近运行入口/);
  assert.match(smoke, /窄屏默认收起属性面板/);
});
