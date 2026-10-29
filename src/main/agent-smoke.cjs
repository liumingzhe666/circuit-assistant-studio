const fs = require('node:fs/promises');
const path = require('node:path');

async function runAgentSmoke(window, argv) {
  const arg = argv.find((value) => value.startsWith('--evidence-dir='));
  if (!arg) throw new Error('Smoke test requires --evidence-dir');
  const output = path.resolve(arg.slice('--evidence-dir='.length));
  await fs.mkdir(output, { recursive: true });
  await Promise.all([
    'ui-smoke-error.log', 'ui-smoke.json', 'agent-workspace.png', 'agent-completed.png',
    'agent-1440.png', 'agent-1120.png', 'studio-1120.png',
  ].map((name) => fs.rm(path.join(output, name), { force: true })));
  await executeGuardSetup();
  const failures = [];
  const checks = [];
  const execute = (fn) => window.webContents.executeJavaScript(`(${fn.toString()})()`);
  async function executeGuardSetup() {
    await window.webContents.executeJavaScript(`window.__smokeErrors = []; window.addEventListener('error', event => window.__smokeErrors.push(event.message)); window.addEventListener('unhandledrejection', event => window.__smokeErrors.push(String(event.reason)));`);
  }
  const waitFor = async (fn) => {
    for (let i = 0; i < 150; i++) {
      if (await execute(fn)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`等待界面超时：${fn.toString()}`);
  };
  const check = (name, passed, detail = null) => {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) failures.push(name);
  };
  const screenshot = async (name) => {
    await waitFor(() => document.querySelector('#toast-stack').children.length === 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
  };
  const resizeWindow = async (width, height) => {
    let actual = window.getSize();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (window.isFullScreen()) window.setFullScreen(false);
      if (window.isMaximized()) window.unmaximize();
      window.setSize(width, height, false);
      await new Promise((resolve) => setTimeout(resolve, 180));
      actual = window.getSize();
      if (Math.abs(actual[0] - width) <= 2 && Math.abs(actual[1] - height) <= 2) return actual;
      if (attempt === 2) {
        window.hide();
        await new Promise((resolve) => setTimeout(resolve, 80));
        window.showInactive();
      }
    }
    return actual;
  };
  window.showInactive();
  await waitFor(() => document.body.dataset.appReady === 'true');
  check('扩充的内置知识可从桌面接口加载', await execute(async () => {
    const knowledge = await window.circuitDesktop.loadKnowledge();
    return knowledge.base.some(entry => entry.id === 'fund-usbc-cc-power')
      && knowledge.advanced.some(entry => entry.id === 'adv-comparator-threshold-budget');
  }));
  check('SQLite 已收录 I2C 官方摘要且可检索', await execute(async () => {
    const hits = await window.circuitDesktop.searchKnowledge('I2C 上拉电阻怎么算', { limit: 3 });
    return hits.some(hit => hit.sourceUrl.includes('/slva689/') && hit.content.includes('0.8473'));
  }));
  check('LDO 检索返回修正后的稳定性来源', await execute(async () => {
    const hits = await window.circuitDesktop.searchKnowledge('LDO 输出电容 ESR', { limit: 3 });
    return hits.some(hit => hit.sourceUrl.includes('/slva115a/'));
  }));
  check('默认打开 Agent 工作台', await execute(() => document.querySelector('#page-agent').classList.contains('active')));
  await screenshot('agent-workspace.png');
  await execute(() => { document.querySelector('#agent-run').click(); });
  check('空需求不启动任务', await execute(() => document.querySelector('#agent-run-status').textContent === '等待任务'));
  await execute(() => {
    document.querySelector('[data-agent-prompt]').click();
    const input = document.querySelector('#agent-prompt');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  });
  await waitFor(() => document.querySelector('#agent-run-status').dataset.status === 'completed');
  check('重复快捷键只生成一次', await execute(() => document.querySelectorAll('.agent-history-item').length === 1));
  check('本地模式如实跳过模型', await execute(() => document.querySelectorAll('.agent-stage.skipped').length === 1));
  check('生成不覆盖工作室', await execute(() => document.querySelectorAll('.editor-component').length === 0));
  await waitFor(async () => (await window.circuitDesktop.getAgentSession()).history.length === 1);
  check('运行记录写入本机', await execute(async () => {
    const session = await window.circuitDesktop.getAgentSession();
    return session.totalRuns === 1 && session.history[0]?.result?.kind === 'plan';
  }));
  await screenshot('agent-completed.png');
  await new Promise((resolve) => {
    window.webContents.once('did-finish-load', resolve);
    window.reload();
  });
  await waitFor(() => document.body.dataset.appReady === 'true');
  await executeGuardSetup();
  check('重载后恢复运行记录', await execute(() => document.querySelectorAll('.agent-history-item').length === 1 && /累计 1 次/.test(document.querySelector('#agent-run-count').textContent)));
  await execute(() => document.querySelector('.agent-history-item').click());
  check('结果入口打开真实原理图', await execute(() => document.querySelector('#page-designer').classList.contains('active') && !!document.querySelector('#schematic-mount svg')));
  await execute(() => document.querySelector('#send-to-studio').click());
  const before = await execute(() => document.querySelectorAll('.editor-component').length);
  check('发送方案到工作室', before > 0, { components: before });
  await execute(() => document.querySelector('.shelf-item').click());
  const afterInventoryClick = await execute(() => document.querySelectorAll('.editor-component').length);
  check('元件物品栏支持点击添加', afterInventoryClick === before + 1, { before, after: afterInventoryClick });
  await execute(() => {
    document.querySelector('.editor-component')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 88 }));
    document.querySelector('[data-page="agent"]').click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  });
  check('其他页面 Delete 不删除画布元件', await execute(() => document.querySelectorAll('.editor-component').length) === afterInventoryClick);
  await execute(() => document.querySelector('#agent-review-project').click());
  await waitFor(() => document.querySelectorAll('.agent-history-item').length === 2);
  check('审查画布产生真实报告', await execute(() => !document.querySelector('#optimizer-report').classList.contains('hidden')));
  await execute(() => {
    document.querySelector('[data-page="designer"]').click();
    document.querySelector('#revision-input').value = '改为 12V 供电';
    document.querySelector('#apply-revision').click();
  });
  await waitFor(() => document.querySelectorAll('.agent-history-item').length === 3);
  check('修订复用工作流并生成新版', await execute(() => /v2/.test(document.querySelector('#revision-version').textContent)));
  await execute(() => {
    document.querySelector('[data-page="agent"]').click();
    const records = document.querySelectorAll('.agent-history-item');
    records[records.length - 1].click();
  });
  check('旧记录恢复自己的结果快照', await execute(() => document.querySelector('#page-designer').classList.contains('active') && /第一版 v1/.test(document.querySelector('#revision-version').textContent)));
  await execute(() => {
    document.querySelector('[data-page="solver"]').click();
    document.querySelector('#problem-input').value = 'V=5V，R=1MΩ，求电流';
    document.querySelector('#solve-button').click();
  });
  check('界面求解兆欧单位正确', await execute(() => /5\s*µA/.test(document.querySelector('.answer-hero').textContent)));
  await execute(() => {
    document.querySelector('#problem-input').value = 'V=7.5V，R=3kΩ，求电阻消耗的功率';
    document.querySelector('#solve-button').click();
  });
  check('求功率不会显示电流答案', await execute(() => /18\.75\s*mW/.test(document.querySelector('.answer-hero').textContent)));
  await execute(() => {
    document.querySelector('#problem-input').value = '电源9V，LED正向压降3V，电流15mA，求限流电阻';
    document.querySelector('#solve-button').click();
  });
  check('界面 LED 计算使用明确的正向压降', await execute(() => /400\s*Ω/.test(document.querySelector('.answer-hero').textContent)));
  await execute(() => document.querySelector('[data-page="agent"]').click());
  for (const { width, height } of [{ width: 1440, height: 920 }, { width: 1120, height: 720 }]) {
    const [actualWidth, actualHeight] = await resizeWindow(width, height);
    const dimensions = await execute(() => {
      const page = document.querySelector('#page-agent');
      const history = document.querySelector('.agent-history-panel').getBoundingClientRect();
      return { scroll: page.scrollWidth, client: page.clientWidth, body: document.body.scrollWidth, viewport: innerWidth, height: innerHeight, historyTop: history.top };
    });
    dimensions.window = { width: actualWidth, height: actualHeight };
    check(`${width}x${height} 窗口尺寸已生效`, Math.abs(actualWidth - width) <= 2 && Math.abs(actualHeight - height) <= 2, dimensions.window);
    check(`${width}px 工作台无横向溢出`, dimensions.scroll <= dimensions.client + 1 && dimensions.body <= dimensions.viewport + 1, dimensions);
    check(`${width}x${height} 首屏可见最近运行入口`, dimensions.historyTop < dimensions.height, dimensions);
    await screenshot(`agent-${width}.png`);
  }
  await execute(() => {
    document.querySelector('[data-page="studio"]').click();
  });
  check('窄屏默认收起属性面板', await execute(() => document.querySelector('#studio-layout').classList.contains('properties-collapsed')));
  await execute(() => {
    document.querySelector('#restore-properties').click();
  });
  check('窄屏属性面板可以重新展开', await execute(() => getComputedStyle(document.querySelector('#properties-panel')).display !== 'none'));
  await execute(() => document.querySelector('#editor-canvas').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 99 })));
  check('点击画布收起窄屏属性面板', await execute(() => document.querySelector('#studio-layout').classList.contains('properties-collapsed')));
  await screenshot('studio-1120.png');
  const runtimeErrors = await execute(() => window.__smokeErrors);
  check('交互期间无未捕获异常', runtimeErrors.length === 0, runtimeErrors);
  const report = { testedAt: new Date().toISOString(), mode: 'isolated Electron, local rules only', checks, passed: failures.length === 0 };
  await fs.writeFile(path.join(output, 'ui-smoke.json'), JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(`界面检查失败：${failures.join('、')}`);
}

module.exports = { runAgentSmoke };
