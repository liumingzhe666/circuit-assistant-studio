const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const { pathToFileURL } = require('node:url');
const storage = require('./storage.cjs');
const ai = require('./ai-provider.cjs');
const { KnowledgeDatabase, SUPPORTED_EXTENSIONS } = require('./knowledge-db.cjs');

function guardDiagnosticStream(stream) {
  stream?.on?.('error', (error) => {
    if (error?.code !== 'EPIPE') throw error;
  });
}

guardDiagnosticStream(process.stdout);
guardDiagnosticStream(process.stderr);

function mainDiagnostic(method, message) {
  const stream = method === 'warn' ? process.stderr : process.stdout;
  if (!stream?.isTTY || stream.destroyed || !stream.writable) return;
  console[method](message);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'circuit', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow;
let knowledgeDb;

// Explicit smoke-test mode uses disposable data and never touches the user's library/settings.
const agentSmoke = process.argv.includes('--agent-smoke');
if (agentSmoke) {
  app.setPath('userData', path.join(app.getPath('temp'), `circuit-agent-smoke-${process.pid}`));
}

async function seedBundledPublicKnowledge() {
  const catalogPath = path.join(app.getAppPath(), 'knowledge', 'public-web-sources.json');
  try {
    const sources = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    if (!Array.isArray(sources)) throw new Error('公开知识清单必须是数组。');
    for (const source of sources) knowledgeDb.importWebSource(source);
  } catch (error) {
    mainDiagnostic('warn', `公开知识清单导入失败：${error.message}`);
  }
}

function sourceToKnowledgeEntry(source) {
  let metadata = {};
  try {
    const parsed = JSON.parse(source.metadata_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
  } catch {
    metadata = {};
  }
  const location = source.page_count > 1 ? `${source.page_count} 页` : '文本资料';
  const status = source.status === 'needs-ocr' ? '需要 OCR' : `${source.chunk_count} 个检索片段`;
  const isWeb = source.source_type === 'web' && source.source_url;
  const authority = metadata.authorityTier ? `权威 ${metadata.authorityTier}` : '';
  return {
    id: `sql-source-${source.id}`,
    sourceId: source.id,
    title: source.title,
    category: isWeb ? '公开网页' : '本地书库',
    level: isWeb ? '进阶' : '用户资料',
    tags: [authority, source.publisher, source.source_type?.toUpperCase(), source.isbn && `ISBN ${source.isbn}`].filter(Boolean),
    summary: [authority, source.authors, source.publisher, location, status].filter(Boolean).join(' · '),
    source: { title: source.original_name, url: isWeb ? source.source_url : '' },
    importedAt: source.imported_at,
    verified: Boolean(isWeb),
    localSource: true,
    rightsStatus: source.rights_status,
    status: source.status,
    authorityTier: metadata.authorityTier || '',
    sourceComparison: metadata.comparison || '',
  };
}

async function collectKnowledgeFiles(rootPath, limit = 200) {
  const root = path.resolve(rootPath);
  const queue = [root];
  const files = [];
  while (queue.length && files.length < limit) {
    const current = queue.shift();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(candidate);
      else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(candidate);
    }
  }
  return files;
}

function localImportOptions() {
  return {
    rightsStatus: 'user-provided',
    rightsNote: '用户从本机明确选择导入；应用只保存检索文本与来源元数据，不复制或上传原始书籍。',
  };
}

function safeLocalPath(requestUrl) {
  const requestPath = decodeURIComponent(new URL(requestUrl).pathname).replace(/^\/+/, '');
  const root = path.resolve(app.getAppPath());
  const candidate = path.resolve(root, requestPath || 'src/renderer/index.html');
  if (!candidate.startsWith(root + path.sep) && candidate !== root) throw new Error('非法本地资源路径');
  return candidate;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#08111e',
    title: '电路助手',
    icon: path.join(app.getAppPath(), 'assets', 'app-icon.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const message = `渲染进程退出：${details.reason}（exitCode=${details.exitCode}）`;
    mainDiagnostic('warn', message);
    try { syncFs.writeFileSync(path.join(app.getPath('temp'), 'circuit-assistant-demo-error.log'), message, 'utf8'); } catch { /* 忽略 */ }
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('circuit://')) event.preventDefault();
  });
  await mainWindow.loadURL('circuit://app/src/renderer/index.html');

  if (agentSmoke) {
    const { runAgentSmoke } = require('./agent-smoke.cjs');
    try {
      await runAgentSmoke(mainWindow, process.argv);
    } catch (error) {
      const evidenceArg = process.argv.find((value) => value.startsWith('--evidence-dir='));
      if (evidenceArg) {
        const evidenceDirectory = path.resolve(evidenceArg.slice('--evidence-dir='.length));
        await fs.mkdir(evidenceDirectory, { recursive: true });
        await fs.writeFile(path.join(evidenceDirectory, 'ui-smoke-error.log'), error?.stack || String(error), 'utf8');
      }
      throw error;
    }
    app.quit();
    return;
  }

  // 演示/回归参数只有在截图模式下才会执行并退出；单独使用时给默认输出，避免应用一直挂着不退出。
  const demoOnly = !process.argv.some((arg) => arg.startsWith('--screenshot='))
    && process.argv.some((arg) => /^--[\w-]+(-demo|demo)$/.test(arg) || arg.startsWith('--place='));
  const screenshotArg = process.argv.find((arg) => arg.startsWith('--screenshot='))
    || (demoOnly ? '--screenshot=artifacts/last-demo.png' : undefined);
  if (screenshotArg) {
    const relative = screenshotArg.slice('--screenshot='.length);
    const output = path.resolve(process.cwd(), relative);
    await fs.mkdir(path.dirname(output), { recursive: true });
    mainWindow.showInactive();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await mainWindow.webContents.executeJavaScript(`document.body.dataset.appReady === 'true'`);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pageArg = process.argv.find((arg) => arg.startsWith('--page='));
    if (pageArg) {
      const page = pageArg.slice('--page='.length).replace(/[^a-z-]/g, '');
      await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]')?.click()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (process.argv.includes('--motor-demo')) {
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const input = document.querySelector('#requirement-input');
          input.value = '生成一个 12V 双电机小车驱动电路，3.3V MCU 控制，支持 PWM 调速和正反转';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#generate-button').click();
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 1600));
    }
    if (process.argv.includes('--market-demo')) {
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          document.querySelector('[data-page="studio"]')?.click();
          await wait(200);
          document.querySelector('[data-inventory-tab="market"]')?.click();
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (process.argv.includes('--studio-e2e-demo')) {
      const e2eResult = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const diagnostics = {};
          const fail = (message) => { throw new Error(message); };
          window.confirm = () => true;
          document.querySelector('[data-page="studio"]')?.click();
          await wait(150);

          // 1. 市场元件：切换页签 → 点击 STM32 卡片 → 应放置带型号的 MCU。
          document.querySelector('[data-inventory-tab="market"]')?.click();
          await wait(120);
          const stm32Card = document.querySelector('[data-market-part="mkt-stm32f103"]');
          if (!stm32Card) fail('市场元件页签里找不到 STM32F103 卡片');
          stm32Card.click();
          await wait(120);
          let mcuNode = [...document.querySelectorAll('.editor-component')][0];
          if (!mcuNode) fail('点击市场元件后没有放置元件');
          const mcuId = mcuNode.dataset.id;
          diagnostics.marketPartPlaced = [...document.querySelectorAll('.editor-component')].length === 1;
          // 放置的元件应带市场型号与封装。
          diagnostics.marketValueOk = document.querySelector('#property-editor #prop-value')?.value === 'STM32F103C8T6';

          // 2. 基础元件页签放置排针，拖到右侧错开。
          document.querySelector('[data-inventory-tab="components"]')?.click();
          await wait(120);
          document.querySelector('[data-component-type="header"]')?.click();
          await wait(120);
          let headerNode = [...document.querySelectorAll('.editor-component')][1];
          if (!headerNode) fail('排针未放置');
          const headerId = headerNode.dataset.id;
          const drag = async (node, dx, dy, pointerId) => {
            const rect = node.getBoundingClientRect();
            const startX = rect.left + rect.width / 2, startY = rect.top + rect.height / 2;
            const canvas = document.querySelector('#editor-canvas');
            node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', button: 0, buttons: 1, clientX: startX, clientY: startY }));
            canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', button: 0, buttons: 1, clientX: startX + dx, clientY: startY + dy }));
            canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', button: 0, buttons: 0, clientX: startX + dx, clientY: startY + dy }));
            await wait(100);
          };
          await drag(headerNode, 260, 150, 11);

          // 3. 连线：MCU R1 → 排针 P1（都是新元件类型的真实引脚）。
          const pinPoint = (componentId, pinId) => {
            const dot = [...document.querySelectorAll('.editor-pin')].find((item) => item.dataset.componentId === componentId && item.dataset.pinId === pinId);
            return dot ? { x: Number(dot.getAttribute('cx')), y: Number(dot.getAttribute('cy')) } : null;
          };
          const clickPin = async (componentId, pinId, pointerId) => {
            const control = [...document.querySelectorAll('.editor-pin-control')].find((item) => item.dataset.componentId === componentId && item.dataset.pinId === pinId);
            if (!control) fail('找不到引脚 ' + componentId + '.' + pinId);
            const dot = control.querySelector('.editor-pin');
            const rect = dot.getBoundingClientRect();
            const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
            control.querySelector('.editor-pin-hit').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y }));
            document.querySelector('#editor-canvas').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', button: 0, buttons: 0, clientX: x, clientY: y }));
            await wait(80);
          };
          document.querySelector('[data-tool="wire"]').click();
          await wait(80);
          await clickPin(mcuId, 'R1', 21);
          await clickPin(headerId, 'P1', 22);
          diagnostics.wireBound = document.querySelectorAll('.editor-wire').length === 1;
          const wireNode = document.querySelector('.editor-wire');
          diagnostics.wireBindingOk = wireNode
            && wireNode.dataset.fromComponent === mcuId && wireNode.dataset.fromPin === 'R1'
            && wireNode.dataset.toComponent === headerId && wireNode.dataset.toPin === 'P1';
          const wireStartBefore = pinPoint(mcuId, 'R1');
          diagnostics.wireDataset = wireNode ? { from: wireNode.dataset.fromComponent, fromPin: wireNode.dataset.fromPin, to: wireNode.dataset.toComponent, toPin: wireNode.dataset.toPin } : null;
          diagnostics.ids = { mcuId, headerId };
          diagnostics.componentIds = [...document.querySelectorAll('.editor-component')].map((node) => node.dataset.id + ':' + (node.getAttribute('transform') || ''));
          document.querySelector('[data-tool="select"]').click();
          await wait(80);

          // 4. 旋转 MCU：导线端点应跟随旋转后的新引脚位置。
          // renderEditor 会重建 DOM：选中前必须重新查询节点，points 只能从 attribute 读取。
          mcuNode = [...document.querySelectorAll('.editor-component')][0];
          const selRect = mcuNode.getBoundingClientRect();
          const downEvent = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 23, pointerType: 'mouse', button: 0, buttons: 1, clientX: selRect.left + 5, clientY: selRect.top + 5 });
          mcuNode.dispatchEvent(downEvent);
          document.querySelector('#editor-canvas').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 23, pointerType: 'mouse', button: 0, buttons: 0, clientX: mcuNode.getBoundingClientRect().left + 5, clientY: mcuNode.getBoundingClientRect().top + 5 }));
          await wait(80);
          document.querySelector('#rotate-component').click();
          await wait(120);
          const rotatedStart = document.querySelector('.editor-wire')?.getAttribute('points')?.trim().split(/\\s+/)[0].split(',').map(Number) || null;
          const rotatedPin = pinPoint(mcuId, 'R1');
          diagnostics.rotateFollowOk = Boolean(rotatedStart && rotatedPin
            && Math.abs(rotatedStart[0] - rotatedPin.x) < 0.01 && Math.abs(rotatedStart[1] - rotatedPin.y) < 0.01);
          // 转回去，方便后续步骤。
          document.querySelector('#rotate-component').click();
          await wait(120);

          // 5. 移动 MCU：导线端点跟随。
          mcuNode = [...document.querySelectorAll('.editor-component')][0];
          await drag(mcuNode, 120, 60, 24);
          const movedStart = document.querySelector('.editor-wire')?.getAttribute('points')?.trim().split(/\\s+/)[0].split(',').map(Number) || null;
          const movedPin = pinPoint(mcuId, 'R1');
          diagnostics.moveFollowOk = Boolean(movedStart && movedPin
            && Math.abs(movedStart[0] - movedPin.x) < 0.01 && Math.abs(movedStart[1] - movedPin.y) < 0.01);

          // 6. 快填值：放置电容并选中，点击常用值芯片。
          document.querySelector('[data-component-type="capacitor"]')?.click();
          await wait(120);
          let capNode = [...document.querySelectorAll('.editor-component')].at(-1);
          capNode.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 25, pointerType: 'mouse', button: 0, buttons: 1, clientX: capNode.getBoundingClientRect().left + 5, clientY: capNode.getBoundingClientRect().top + 5 }));
          document.querySelector('#editor-canvas').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 25, pointerType: 'mouse', button: 0, buttons: 0, clientX: capNode.getBoundingClientRect().left + 5, clientY: capNode.getBoundingClientRect().top + 5 }));
          await wait(100);
          const quickChip = document.querySelector('#quick-values [data-quick-value]');
          diagnostics.quickChipVisible = Boolean(quickChip);
          if (quickChip) {
            quickChip.click();
            await wait(100);
          }
          diagnostics.quickValueApplied = document.querySelector('#property-editor #prop-value')?.value === quickChip?.dataset.quickValue;

          // 7. 删除带导线的 MCU：导线应一并清除。
          mcuNode = [...document.querySelectorAll('.editor-component')][0];
          mcuNode.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 26, pointerType: 'mouse', button: 0, buttons: 1, clientX: mcuNode.getBoundingClientRect().left + 5, clientY: mcuNode.getBoundingClientRect().top + 5 }));
          document.querySelector('#editor-canvas').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 26, pointerType: 'mouse', button: 0, buttons: 0, clientX: mcuNode.getBoundingClientRect().left + 5, clientY: mcuNode.getBoundingClientRect().top + 5 }));
          await wait(80);
          window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Delete' }));
          await wait(100);
          diagnostics.deleteCascades = document.querySelectorAll('.editor-wire').length === 0
            && [...document.querySelectorAll('.editor-component')].every((node) => node.dataset.id !== mcuId);

          // 8. 交点询问 + 撤销：横竖两条线相交，选择“连接”产生结点；Ctrl+Z 撤销后不应残留弹窗。
          document.querySelector('[data-inventory-tab="components"]')?.click();
          await wait(80);
          const place = async (type, dx, dy) => {
            const stage = document.querySelector('#drawing-stage');
            const rect = stage.getBoundingClientRect();
            const data = new DataTransfer();
            data.setData('application/x-circuit-component', type);
            stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.left + rect.width * dx, clientY: rect.top + rect.height * dy }));
            await wait(80);
          };
          await place('resistor', 0.25, 0.3);
          await place('resistor', 0.75, 0.3);
          await place('capacitor', 0.5, 0.62);
          await place('capacitor', 0.5, 0.14);
          document.querySelector('[data-tool="wire"]').click();
          await clickPin([...document.querySelectorAll('.editor-component')].at(-4).dataset.id, 'B', 31);
          await clickPin([...document.querySelectorAll('.editor-component')].at(-3).dataset.id, 'A', 32);
          await clickPin([...document.querySelectorAll('.editor-component')].at(-2).dataset.id, 'TOP', 33);
          await clickPin([...document.querySelectorAll('.editor-component')].at(-1).dataset.id, 'BOTTOM', 34);
          await wait(150);
          diagnostics.crossingAsked = document.querySelector('#wire-crossing-dialog')?.open === true;
          document.querySelector('[data-crossing-choice="connected"]')?.click();
          await wait(150);
          diagnostics.junctionCreated = document.querySelectorAll('.editor-junction').length >= 1;
          window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'z' }));
          await wait(150);
          diagnostics.undoNoGhostDialog = document.querySelector('#wire-crossing-dialog')?.open !== true;
          diagnostics.undoRemovedJunction = document.querySelectorAll('.editor-junction').length === 0;

          // 9. 项目保存与重载。
          document.querySelector('[data-tool="select"]').click();
          document.querySelector('#save-project').click();
          await wait(400);
          const beforeCount = document.querySelectorAll('.editor-component').length;
          document.querySelector('#new-project').click();
          await wait(150);
          const cleared = document.querySelectorAll('.editor-component').length === 0;
          const projectItem = document.querySelector('[data-project-id]');
          if (!projectItem) fail('保存后项目列表为空');
          document.querySelector('[data-inventory-tab="projects"]')?.click();
          await wait(80);
          document.querySelector('[data-project-id]')?.click();
          await wait(250);
          diagnostics.projectRoundTrip = cleared && document.querySelectorAll('.editor-component').length === beforeCount;
          return diagnostics;
        })()
      `);
      const required = ['marketPartPlaced','marketValueOk','wireBound','wireBindingOk','rotateFollowOk','moveFollowOk','quickChipVisible','quickValueApplied','deleteCascades','crossingAsked','junctionCreated','undoNoGhostDialog','undoRemovedJunction','projectRoundTrip'];
      const broken = required.filter((key) => e2eResult?.[key] !== true);
      if (broken.length) throw new Error(`工作室端到端回归失败：${broken.join('、')}；诊断 ${JSON.stringify(e2eResult)}`);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const placeArg = process.argv.find((arg) => arg.startsWith('--place='));
    if (placeArg) {
      const types = placeArg.slice('--place='.length).split(',').map((value) => value.trim()).filter(Boolean).slice(0, 12);
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          document.querySelector('[data-page="studio"]')?.click();
          await wait(150);
          const stage = document.querySelector('#drawing-stage');
          const rect = stage.getBoundingClientRect();
          const types = ${JSON.stringify(types)};
          const columns = 4;
          for (let index = 0; index < types.length; index += 1) {
            const data = new DataTransfer();
            data.setData('application/x-circuit-component', types[index]);
            stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data,
              clientX: rect.left + rect.width * (0.14 + 0.24 * (index % columns)),
              clientY: rect.top + rect.height * (0.2 + 0.3 * Math.floor(index / columns)) }));
            await wait(60);
          }
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (process.argv.includes('--studio-demo')) {
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const stage = document.querySelector('#drawing-stage');
          const rect = stage.getBoundingClientRect();
          for (const [type, dx, dy] of [['source', .25, .42], ['resistor', .43, .42], ['led', .62, .42], ['ground', .78, .58]]) {
            const data = new DataTransfer(); data.setData('application/x-circuit-component', type);
            stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.left + rect.width*dx, clientY: rect.top + rect.height*dy }));
            await wait(80);
          }
          document.querySelector('[data-tool="wire"]').click();
          const count = document.querySelectorAll('.editor-component').length;
          for (let i=0;i<count-1;i++) {
            document.querySelectorAll('.editor-component')[i].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1}));
            await wait(40);
            document.querySelectorAll('.editor-component')[i+1].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1}));
            await wait(60);
          }
          document.querySelector('[data-tool="select"]').click();
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (process.argv.includes('--infinite-canvas-demo')) {
      const canvasResult = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          // 默认页是 Agent 工作台；必须先切到工作室，否则画布 display:none 会导致所有坐标为 0。
          document.querySelector('[data-page="studio"]')?.click();
          await wait(200);
          const stage=document.querySelector('#drawing-stage');
          const canvas=document.querySelector('#editor-canvas');
          const stageRect=stage.getBoundingClientRect();
          const data=new DataTransfer();data.setData('application/x-circuit-component','resistor');
          stage.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:stageRect.left+stageRect.width*.5,clientY:stageRect.top+stageRect.height*.5}));
          await wait(100);
          const component=document.querySelector('.editor-component');
          const componentRect=component.getBoundingClientRect();
          const startX=componentRect.left+componentRect.width/2,startY=componentRect.top+componentRect.height/2;
          // 拖动与平移的位移按“远超断言阈值”选取，在窄屏和宽屏窗口下都能稳定通过。
          component.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:201,pointerType:'mouse',button:0,buttons:1,clientX:startX,clientY:startY}));
          canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:201,pointerType:'mouse',button:0,buttons:1,clientX:startX+900,clientY:startY+120}));
          canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:201,pointerType:'mouse',button:0,buttons:0,clientX:startX+900,clientY:startY+120}));
          await wait(100);
          const transform=document.querySelector('.editor-component')?.getAttribute('transform')||'';
          const componentX=Number(transform.match(/translate\\(([-\\d.]+)/)?.[1]);
          const viewBoxAfterDrag=(canvas.getAttribute('viewBox')||'').split(/\\s+/).map(Number);
          document.querySelector('[data-tool="pan"]').click();
          const canvasRect=canvas.getBoundingClientRect();
          const panStartX=canvasRect.left+canvasRect.width*.7,panStartY=canvasRect.top+canvasRect.height*.55;
          canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:202,pointerType:'mouse',button:0,buttons:1,clientX:panStartX,clientY:panStartY}));
          canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:202,pointerType:'mouse',button:0,buttons:1,clientX:panStartX-1500,clientY:panStartY-40}));
          canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:202,pointerType:'mouse',button:0,buttons:0,clientX:panStartX-1500,clientY:panStartY-40}));
          await wait(100);
          const viewBox=canvas.getAttribute('viewBox').split(/\\s+/).map(Number);
          const grid=document.querySelector('#editor-grid-background');
          return {componentX,viewBox,viewBoxAfterDrag,gridX:Number(grid.getAttribute('x')),gridWidth:Number(grid.getAttribute('width')),canvasWidth:canvasRect.width,stageWidth:stageRect.width};
        })()
      `);
      if (!(canvasResult.componentX>970&&canvasResult.viewBox[0]>1000&&canvasResult.gridWidth>canvasResult.viewBox[2])) {
        throw new Error(`无限画布回归失败：${JSON.stringify(canvasResult)}`);
      }
      mainDiagnostic('log',`Infinite canvas diagnostics: ${JSON.stringify(canvasResult)}`);
      await new Promise((resolve)=>setTimeout(resolve,400));
    }
    if (process.argv.includes('--wire-drag-demo')) {
      const wireResult = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const diagnostics = [];
          document.querySelector('[data-page="studio"]')?.click();
          const stage = document.querySelector('#drawing-stage');
          const canvas = document.querySelector('#editor-canvas');
          const stageRect = stage.getBoundingClientRect();
          for (const [type, dx, dy] of [['resistor', .28, .48], ['diode', .5, .48], ['led', .72, .48]]) {
            const data = new DataTransfer(); data.setData('application/x-circuit-component', type);
            stage.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:data, clientX:stageRect.left+stageRect.width*dx, clientY:stageRect.top+stageRect.height*dy }));
            await wait(80);
          }
          document.querySelector('[data-tool="wire"]').click();
          const connectByDrag = async (fromIndex, toIndex, pointerId) => {
            const components = [...document.querySelectorAll('.editor-component')];
            const fromId=components[fromIndex].dataset.id, toId=components[toIndex].dataset.id;
            const center = (node) => { const rect=node.getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; };
            const toCenter=center(components[toIndex]);
            const fromPin=[...document.querySelectorAll('.editor-pin-control')].filter((pin)=>pin.dataset.componentId===fromId).reduce((best,pin)=>{
              const point=center(pin),distance=Math.hypot(point.x-toCenter.x,point.y-toCenter.y);return !best||distance<best.distance?{pin,point,distance}:best;
            },null);
            const toPin=[...document.querySelectorAll('.editor-pin-control')].filter((pin)=>pin.dataset.componentId===toId).reduce((best,pin)=>{
              const point=center(pin),distance=Math.hypot(point.x-fromPin.point.x,point.y-fromPin.point.y);return !best||distance<best.distance?{pin,point,distance}:best;
            },null);
            const startX=fromPin.point.x, startY=fromPin.point.y;
            // Release slightly beside the endpoint to verify magnetic snapping.
            const endX=toPin.point.x-18, endY=toPin.point.y+6;
            fromPin.pin.querySelector('.editor-pin-hit').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId,pointerType:'mouse',button:0,buttons:1,clientX:startX,clientY:startY}));
            canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId,pointerType:'mouse',button:0,buttons:1,clientX:endX,clientY:endY}));
            const hit = document.elementFromPoint(endX,endY);
            canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId,pointerType:'mouse',button:0,buttons:0,clientX:endX,clientY:endY}));
            await wait(120);
            diagnostics.push({fromIndex,toIndex,hit:hit?.className?.baseVal || hit?.className || hit?.tagName,hitComponent:hit?.closest?.('.editor-component')?.dataset.id || '',wireCount:document.querySelectorAll('.editor-wire').length,hint:document.querySelector('#wire-mode-hint')?.textContent});
          };
          await connectByDrag(0,1,21);
          await connectByDrag(1,2,22);
          return {wireCount:document.querySelectorAll('.editor-wire').length,diagnostics};
        })()
      `);
      if (wireResult.wireCount !== 2) throw new Error(`拖拽连线回归失败：期望 2 条，实际 ${wireResult.wireCount} 条；${JSON.stringify(wireResult.diagnostics)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (process.argv.includes('--wire-click-demo')||process.argv.includes('--wire-preview-demo')) {
      const previewOnly=process.argv.includes('--wire-preview-demo');
      const wireResult = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const previewOnly=${JSON.stringify(previewOnly)};
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          document.querySelector('[data-page="studio"]')?.click();
          const stage = document.querySelector('#drawing-stage');
          const stageRect = stage.getBoundingClientRect();
          for (const [type, dx, dy] of [['resistor', .34, .38], ['led', .68, .66]]) {
            const data = new DataTransfer(); data.setData('application/x-circuit-component', type);
            stage.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:data, clientX:stageRect.left+stageRect.width*dx, clientY:stageRect.top+stageRect.height*dy }));
            await wait(80);
          }
          document.querySelector('[data-tool="wire"]').click();
          const components = [...document.querySelectorAll('.editor-component')];
          const fromId = components[0].dataset.id;
          const toId = components[1].dataset.id;
          const from = [...document.querySelectorAll('.editor-pin-control')].find((pin) => pin.dataset.componentId === fromId && pin.dataset.pinId === 'B');
          const fromRect=from.querySelector('.editor-pin').getBoundingClientRect();
          const fromClient={x:fromRect.left+fromRect.width/2+18,y:fromRect.top+fromRect.height/2+6};
          document.querySelector('#editor-canvas').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:31,pointerType:'mouse',button:0,buttons:1,clientX:fromClient.x,clientY:fromClient.y}));
          document.querySelector('#editor-canvas').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:31,pointerType:'mouse',button:0,buttons:0,clientX:fromClient.x,clientY:fromClient.y}));
          await wait(80);
          const secondStep = document.querySelector('#wire-hint-step')?.textContent;
          const canvas=document.querySelector('#editor-canvas');
          const pinPoint=(componentId,pinId)=>{
            const dot=[...document.querySelectorAll('.editor-pin')].find((item)=>item.dataset.componentId===componentId&&item.dataset.pinId===pinId);
            return {x:Number(dot.getAttribute('cx')),y:Number(dot.getAttribute('cy'))};
          };
          const toPoint=pinPoint(toId,'A');
          const fromPoint=pinPoint(fromId,'B');
          const toClient=(point)=>{const value=canvas.createSVGPoint();value.x=point.x;value.y=point.y;return value.matrixTransform(canvas.getScreenCTM());};
          const canvasClick=async(point,pointerId)=>{
            const client=toClient(point);
            canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId,pointerType:'mouse',button:0,buttons:1,clientX:client.x,clientY:client.y}));
            canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId,pointerType:'mouse',button:0,buttons:0,clientX:client.x,clientY:client.y}));
            await wait(60);
          };
          const midX=Math.round((fromPoint.x+toPoint.x)/20)*10;
          const firstCorner={x:midX,y:fromPoint.y};
          const secondCorner={x:midX,y:toPoint.y};
          const outsideClient=toClient({x:midX,y:fromPoint.y+37});
          canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:98,pointerType:'mouse',button:0,buttons:0,clientX:outsideClient.x,clientY:outsideClient.y}));
          const outsideAutoTargetCount=document.querySelectorAll('.editor-pin.target').length;
          await canvasClick(firstCorner,99);
          await canvasClick(secondCorner,100);
          const targetControl=[...document.querySelectorAll('.editor-pin-control')].find((item)=>item.dataset.componentId===toId&&item.dataset.pinId==='A');
          const targetRect=targetControl.querySelector('.editor-pin').getBoundingClientRect();
          const moveClient={x:targetRect.left+targetRect.width/2-18,y:targetRect.top+targetRect.height/2+6};
          canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:101,pointerType:'mouse',button:0,buttons:0,clientX:moveClient.x,clientY:moveClient.y}));
          const expectedEnd=toPoint;
          const preview=document.querySelector('.wire-preview');
          const previewEnd=document.querySelector('.wire-preview-end');
          const previewPoints=preview ? Array.from({length:preview.points.numberOfItems},(_,index)=>{
            const value=preview.points.getItem(index);return [value.x,value.y];
          }) : [];
          const previewSeen=Boolean(previewPoints.length&&previewEnd);
          const previewFollowsPointer=Boolean(previewEnd
            && Math.abs(Number(previewEnd.getAttribute('cx'))-expectedEnd.x)<.01
            && Math.abs(Number(previewEnd.getAttribute('cy'))-expectedEnd.y)<.01);
          const manualRoutedPreview=previewPoints.length===4
            && previewPoints.slice(1).every((point,index)=>point[0]===previewPoints[index][0]||point[1]===previewPoints[index][1])
            && previewPoints[1][0]===firstCorner.x&&previewPoints[1][1]===firstCorner.y
            && previewPoints[2][0]===secondCorner.x&&previewPoints[2][1]===secondCorner.y
            && Math.abs(previewPoints[3][0]-expectedEnd.x)<.01
            && Math.abs(previewPoints[3][1]-expectedEnd.y)<.01;
          const alignedTargetCount=document.querySelectorAll('.editor-pin.target').length;
          if(!previewOnly){
            canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:102,pointerType:'mouse',button:0,buttons:1,clientX:moveClient.x,clientY:moveClient.y}));
            await wait(100);
          }
          return {wireCount:document.querySelectorAll('.editor-wire').length,secondStep,previewSeen,previewFollowsPointer,manualRoutedPreview,outsideAutoTargetCount,alignedTargetCount,previewPoints,expectedEnd,firstCorner,secondCorner,hint:document.querySelector('#wire-mode-hint')?.textContent};
        })()
      `);
      const expectedWireCount=previewOnly?0:1;
      if (wireResult.wireCount !== expectedWireCount || wireResult.secondStep !== '第 2 步'
        || !wireResult.previewSeen || !wireResult.previewFollowsPointer || !wireResult.manualRoutedPreview
        || wireResult.outsideAutoTargetCount !== 0 || wireResult.alignedTargetCount !== 1) throw new Error(`点击引脚连线回归失败：${JSON.stringify(wireResult)}`);
      mainDiagnostic('log', `Wire click diagnostics: ${JSON.stringify(wireResult)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (process.argv.includes('--wire-multipin-demo')) {
      const multipinResult = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
          document.querySelector('[data-page="studio"]')?.click();
          const stage=document.querySelector('#drawing-stage');
          const canvas=document.querySelector('#editor-canvas');
          const rect=stage.getBoundingClientRect();
          const place=async(type,dx,dy)=>{
            const data=new DataTransfer();data.setData('application/x-circuit-component',type);
            stage.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:rect.left+rect.width*dx,clientY:rect.top+rect.height*dy}));
            await wait(70);
          };
          await place('ic',.3,.48);
          await place('opamp',.7,.48);
          const components=[...document.querySelectorAll('.editor-component')];
          const icId=components[0].dataset.id,opampId=components[1].dataset.id;
          const pinControl=(componentId,pinId)=>[...document.querySelectorAll('.editor-pin-control')]
            .find((item)=>item.dataset.componentId===componentId&&item.dataset.pinId===pinId);
          const markerPoint=(componentId,pinId)=>{
            const dot=pinControl(componentId,pinId)?.querySelector('.editor-pin');
            return dot ? {x:Number(dot.getAttribute('cx')),y:Number(dot.getAttribute('cy'))} : null;
          };
          const markersBeforeWire=[...document.querySelectorAll('.editor-pin-control')].map((item)=>({
            componentId:item.dataset.componentId,pinId:item.dataset.pinId,
            ...markerPoint(item.dataset.componentId,item.dataset.pinId),
          }));
          document.querySelector('[data-tool="wire"]').click();
          let pointerId=180;
          const clickPin=async(componentId,pinId)=>{
            const control=pinControl(componentId,pinId);const dot=control?.querySelector('.editor-pin');
            if(!control||!dot) throw new Error('找不到标记点 '+componentId+'.'+pinId);
            const pinRect=dot.getBoundingClientRect();const x=pinRect.left+pinRect.width/2,y=pinRect.top+pinRect.height/2;
            const id=pointerId++;
            control.querySelector('.editor-pin-hit').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:1,clientX:x,clientY:y}));
            canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:0,clientX:x,clientY:y}));
            await wait(80);
          };
          const canvasClick=async(point)=>{
            const svgPoint=canvas.createSVGPoint();svgPoint.x=point.x;svgPoint.y=point.y;
            const client=svgPoint.matrixTransform(canvas.getScreenCTM());const id=pointerId++;
            canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:1,clientX:client.x,clientY:client.y}));
            canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:0,clientX:client.x,clientY:client.y}));
            await wait(60);
          };
          const connectManual=async(fromId,fromPin,toId,toPin)=>{
            const start=markerPoint(fromId,fromPin),end=markerPoint(toId,toPin);
            const midX=Math.round((start.x+end.x)/20)*10;
            await clickPin(fromId,fromPin);
            await canvasClick({x:midX,y:start.y});
            await canvasClick({x:midX,y:end.y});
            await clickPin(toId,toPin);
          };
          await connectManual(icId,'L1',opampId,'IN_PLUS');
          await connectManual(icId,'L2',opampId,'IN_MINUS');
          const countBeforeSelf=document.querySelectorAll('.editor-wire').length;
          await clickPin(icId,'L1');await clickPin(icId,'L2');
          const countAfterSelf=document.querySelectorAll('.editor-wire').length;
          document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));
          await wait(80);
          const expectedBindings=new Set([
            icId+':L1>'+opampId+':IN_PLUS',
            icId+':L2>'+opampId+':IN_MINUS',
          ]);
          const wires=[...document.querySelectorAll('.editor-wire')].map((wire)=>{
            const key=wire.dataset.fromComponent+':'+wire.dataset.fromPin+'>'+wire.dataset.toComponent+':'+wire.dataset.toPin;
            const points=wire.getAttribute('points').trim().split(/\\s+/).map((value)=>value.split(',').map(Number));
            const start=markerPoint(wire.dataset.fromComponent,wire.dataset.fromPin);
            const end=markerPoint(wire.dataset.toComponent,wire.dataset.toPin);
            const overlaps=Boolean(start&&end&&points[0][0]===start.x&&points[0][1]===start.y&&points.at(-1)[0]===end.x&&points.at(-1)[1]===end.y);
            return {key,overlaps,points};
          });
          const markerKeys=new Set(markersBeforeWire.map((item)=>item.componentId+':'+item.pinId+':'+item.x+','+item.y));
          const independent=markerKeys.size===markersBeforeWire.length
            && markerPoint(icId,'L1').y!==markerPoint(icId,'L2').y
            && markerPoint(opampId,'IN_PLUS').y!==markerPoint(opampId,'IN_MINUS').y;
          return {
            markerCount:markersBeforeWire.length,
            markerPins:markersBeforeWire.map((item)=>item.pinId),
            independent,
            countBeforeSelf,countAfterSelf,
            bindingsCorrect:wires.length===2&&wires.every((wire)=>expectedBindings.has(wire.key)),
            endpointsOverlap:wires.every((wire)=>wire.overlaps),
            wires,
          };
        })()
      `);
      if (multipinResult.markerCount !== 7 || !multipinResult.independent
        || multipinResult.countBeforeSelf !== 2 || multipinResult.countAfterSelf !== 2
        || !multipinResult.bindingsCorrect || !multipinResult.endpointsOverlap) {
        throw new Error(`多引脚连线回归失败：${JSON.stringify(multipinResult)}`);
      }
      mainDiagnostic('log', `Wire multipin diagnostics: ${JSON.stringify(multipinResult)}`);
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
    if (process.argv.includes('--wire-edit-demo')) {
      const wireEditResult = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
          document.querySelector('[data-page="studio"]')?.click();
          const stage=document.querySelector('#drawing-stage');
          const canvas=document.querySelector('#editor-canvas');
          const stageRect=stage.getBoundingClientRect();
          const place=async(type,dx,dy)=>{
            const data=new DataTransfer();data.setData('application/x-circuit-component',type);
            stage.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:stageRect.left+stageRect.width*dx,clientY:stageRect.top+stageRect.height*dy}));
            await wait(70);
          };
          await place('resistor',.28,.4);await place('led',.72,.68);
          document.querySelector('[data-tool="wire"]').click();
          const componentIds=[...document.querySelectorAll('.editor-component')].map((item)=>item.dataset.id);
          let pointerId=240;
          const clickPin=async(componentId,pinId)=>{
            const control=[...document.querySelectorAll('.editor-pin-control')].find((item)=>item.dataset.componentId===componentId&&item.dataset.pinId===pinId);
            const dot=control.querySelector('.editor-pin');const rect=dot.getBoundingClientRect();
            const x=rect.left+rect.width/2,y=rect.top+rect.height/2,id=pointerId++;
            control.querySelector('.editor-pin-hit').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:1,clientX:x,clientY:y}));
            canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:0,clientX:x,clientY:y}));
            await wait(80);
          };
          const markerPoint=(componentId,pinId)=>{
            const dot=[...document.querySelectorAll('.editor-pin')].find((item)=>item.dataset.componentId===componentId&&item.dataset.pinId===pinId);
            return {x:Number(dot.getAttribute('cx')),y:Number(dot.getAttribute('cy'))};
          };
          const canvasClick=async(point)=>{
            const svgPoint=canvas.createSVGPoint();svgPoint.x=point.x;svgPoint.y=point.y;
            const client=svgPoint.matrixTransform(canvas.getScreenCTM());const id=pointerId++;
            canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:1,clientX:client.x,clientY:client.y}));
            canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:0,clientX:client.x,clientY:client.y}));
            await wait(60);
          };
          const startPoint=markerPoint(componentIds[0],'B'),endPoint=markerPoint(componentIds[1],'A');
          const routeX=Math.round((startPoint.x+endPoint.x)/20)*10;
          await clickPin(componentIds[0],'B');
          await canvasClick({x:routeX,y:startPoint.y});
          await canvasClick({x:routeX,y:endPoint.y});
          await clickPin(componentIds[1],'A');
          document.querySelector('[data-tool="select"]').click();
          const readPoints=()=>{
            const polyline=document.querySelector('.editor-wire');
            return Array.from({length:polyline.points.numberOfItems},(_,index)=>{
              const point=polyline.points.getItem(index);return [point.x,point.y];
            });
          };
          const before=readPoints();
          const middle={x:(before[1][0]+before[2][0])/2,y:(before[1][1]+before[2][1])/2};
          const svgPoint=canvas.createSVGPoint();svgPoint.x=middle.x;svgPoint.y=middle.y;
          const clientPoint=svgPoint.matrixTransform(canvas.getScreenCTM());
          const hit=document.querySelector('.editor-wire-hit');
          const selectId=pointerId++;
          hit.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:selectId,pointerType:'mouse',button:0,buttons:1,clientX:clientPoint.x,clientY:clientPoint.y}));
          canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:selectId,pointerType:'mouse',button:0,buttons:0,clientX:clientPoint.x,clientY:clientPoint.y}));
          await wait(80);
          const dragHandle=async(handle,dx,dy)=>{
            if(!handle) throw new Error('缺少导线线段控制点');
            const rect=handle.getBoundingClientRect();const startX=rect.left+rect.width/2,startY=rect.top+rect.height/2;
            const id=pointerId++;
            handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:1,clientX:startX,clientY:startY}));
            canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:1,clientX:startX+dx,clientY:startY+dy}));
            canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:0,clientX:startX+dx,clientY:startY+dy}));
            await wait(100);
          };
          let handles=[...document.querySelectorAll('.editor-wire-segment-handle')];
          const middleHandle=handles.find((item)=>item.classList.contains('vertical'))||handles[Math.floor(handles.length/2)];
          await dragHandle(middleHandle,83,0);
          const afterMiddle=readPoints();
          handles=[...document.querySelectorAll('.editor-wire-segment-handle')];
          const firstHandle=handles[0];
          await dragHandle(firstHandle,firstHandle.classList.contains('vertical')?-47:0,firstHandle.classList.contains('horizontal')?-47:0);
          handles=[...document.querySelectorAll('.editor-wire-segment-handle')];
          const lastHandle=handles.at(-1);
          await dragHandle(lastHandle,lastHandle.classList.contains('vertical')?53:0,lastHandle.classList.contains('horizontal')?53:0);
          const after=readPoints();
          const marker=(componentId,pinId)=>{
            const dot=[...document.querySelectorAll('.editor-pin')].find((item)=>item.dataset.componentId===componentId&&item.dataset.pinId===pinId);
            return [Number(dot.getAttribute('cx')),Number(dot.getAttribute('cy'))];
          };
          const orthogonal=after.slice(1).every((point,index)=>point[0]===after[index][0]||point[1]===after[index][1]);
          const endpointsFixed=JSON.stringify(after[0])===JSON.stringify(marker(componentIds[0],'B'))
            && JSON.stringify(after.at(-1))===JSON.stringify(marker(componentIds[1],'A'));
          const middleMoved=afterMiddle.length>=4&&afterMiddle[1][0]!==before[1][0]&&afterMiddle[1][0]===afterMiddle[2][0];
          const gridAligned=afterMiddle.length>=4&&Math.abs(afterMiddle[1][0]/10-Math.round(afterMiddle[1][0]/10))<.001;
          const handleCount=document.querySelectorAll('.editor-wire-segment-handle').length;
          const allSegmentsEditable=handleCount===after.length-1;
          const edgeSegmentsAdjusted=after.length>afterMiddle.length;
          return {before,afterMiddle,after,orthogonal,endpointsFixed,middleMoved,gridAligned,handleCount,allSegmentsEditable,edgeSegmentsAdjusted};
        })()
      `);
      if (!wireEditResult.orthogonal||!wireEditResult.endpointsFixed||!wireEditResult.middleMoved
        ||!wireEditResult.gridAligned||!wireEditResult.allSegmentsEditable||!wireEditResult.edgeSegmentsAdjusted) {
        throw new Error(`导线编辑回归失败：${JSON.stringify(wireEditResult)}`);
      }
      mainDiagnostic('log',`Wire edit diagnostics: ${JSON.stringify(wireEditResult)}`);
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
    if (process.argv.some((arg)=>['--wire-crossing-demo','--wire-crossing-separate-demo','--wire-crossing-prompt-demo'].includes(arg))) {
      const crossingChoice=process.argv.includes('--wire-crossing-prompt-demo')?'prompt':process.argv.includes('--wire-crossing-separate-demo')?'separate':'connected';
      const crossingResult = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const crossingChoice=${JSON.stringify(crossingChoice)};
          const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
          document.querySelector('[data-page="studio"]')?.click();
          const stage=document.querySelector('#drawing-stage');
          const canvas=document.querySelector('#editor-canvas');
          const rect=stage.getBoundingClientRect();
          const place=async(type,dx,dy)=>{
            const data=new DataTransfer();data.setData('application/x-circuit-component',type);
            stage.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:rect.left+rect.width*dx,clientY:rect.top+rect.height*dy}));
            await wait(60);
          };
          await place('resistor',.27,.5);await place('resistor',.73,.5);
          await place('capacitor',.5,.27);await place('capacitor',.5,.73);
          document.querySelector('[data-tool="wire"]').click();
          const ids=[...document.querySelectorAll('.editor-component')].map((item)=>item.dataset.id);
          let pointerId=60;
          const clickPin=async(componentId,pinId)=>{
            const pin=[...document.querySelectorAll('.editor-pin-control')].find((item)=>item.dataset.componentId===componentId&&item.dataset.pinId===pinId);
            const dot=pin.querySelector('.editor-pin');const pinRect=dot.getBoundingClientRect();
            const x=pinRect.left+pinRect.width/2,y=pinRect.top+pinRect.height/2;
            const id=pointerId++;
            pin.querySelector('.editor-pin-hit').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:1,clientX:x,clientY:y}));
            canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',button:0,buttons:0,clientX:x,clientY:y}));
            await wait(70);
          };
          await clickPin(ids[0],'B');await clickPin(ids[1],'A');
          await clickPin(ids[2],'BOTTOM');await clickPin(ids[3],'TOP');
          await wait(120);
          const dialog=document.querySelector('#wire-crossing-dialog');
          const asked=dialog.open;
          const detail=document.querySelector('#wire-crossing-detail').textContent;
          if(crossingChoice!=='prompt'){
            document.querySelector('[data-crossing-choice="'+crossingChoice+'"]').click();
            await wait(120);
          }
          return {asked,detail,wireCount:document.querySelectorAll('.editor-wire').length,junctionCount:document.querySelectorAll('.editor-junction').length,separateCount:document.querySelectorAll('.wire-no-junction').length};
        })()
      `);
      const choicePassed=crossingChoice==='prompt'||(crossingChoice==='connected'?crossingResult.junctionCount>0:crossingResult.separateCount>0);
      if (!crossingResult.asked||crossingResult.wireCount!==2||!choicePassed) throw new Error(`导线交点询问回归失败：${JSON.stringify(crossingResult)}`);
      mainDiagnostic('log', `Wire crossing diagnostics: ${JSON.stringify(crossingResult)}`);
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
    if (process.argv.includes('--move-demo')) {
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const component = document.querySelector('.editor-component');
          const canvas = document.querySelector('#editor-canvas');
          if (!component || !canvas) return false;
          const rect = component.getBoundingClientRect();
          const startX = rect.left + rect.width / 2;
          const startY = rect.top + rect.height / 2;
          component.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId:7, pointerType:'mouse', button:0, buttons:1, clientX:startX, clientY:startY }));
          canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, cancelable:true, pointerId:7, pointerType:'mouse', button:0, buttons:1, clientX:startX+118, clientY:startY+73 }));
          return canvas.classList.contains('is-dragging');
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (process.argv.includes('--solver-demo')) {
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const input = document.querySelector('#problem-input');
          input.value = 'Vin=12V，R1=10kΩ，R2=5kΩ 构成分压，求 Vout。';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#solve-button').click();
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (process.argv.includes('--optimizer-demo')) {
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          document.querySelector('[data-page="optimizer"]').click();
          for (const value of ['low-noise','reliability']) {
            const goal = document.querySelector('.goal-grid input[value="' + value + '"]');
            if (goal) goal.checked = true;
          }
          document.querySelector('#optimize-button').click();
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (process.argv.includes('--led-demo')) {
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const input = document.querySelector('#requirement-input');
          input.value = '请生成一个电路，要求能够使灯泡点亮';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#generate-button').click();
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    if (process.argv.includes('--motor-demo')) {
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const input = document.querySelector('#requirement-input');
          input.value = '生成一个能够驱动小车的电路';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#generate-button').click();
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (process.argv.includes('--revision-demo')) {
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const input = document.querySelector('#revision-input');
          input.value = '改为 12V 供电，换成白色 LED，去掉开关';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#apply-revision').click();
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    if (process.argv.includes('--bom-demo')) {
      await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-inspector="bom"]')?.click()`);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (process.argv.includes('--demo')) {
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const input = document.querySelector('#requirement-input');
          input.value = '设计一个 12V 输入、5V 2A 输出的同步 Buck 降压电源，用于单片机和传感器供电，要求低纹波。';
          input.dispatchEvent(new Event('input'));
          document.querySelector('#generate-button').click();
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
    const image = await mainWindow.webContents.capturePage();
    await fs.writeFile(output, image.toPNG());
    mainDiagnostic('log', `Screenshot saved: ${output}`);
    app.quit();
    return;
  }
  mainWindow.show();
}

function registerIpc() {
  ipcMain.handle('settings:get', () => storage.loadSettings());
  ipcMain.handle('settings:save', (_event, value) => storage.saveSettings(value || {}));
  ipcMain.handle('ai:status', async () => ai.getStatus(await storage.loadSettings()));
  ipcMain.handle('ai:analyze-image', async (_event, payload) => {
    if (!payload?.imageDataUrl || payload.imageDataUrl.length > 25_000_000) throw new Error('图片为空或超过 18 MB 限制。');
    return ai.analyzeImage(await storage.loadSettings(), payload);
  });
  ipcMain.handle('ai:enhance-plan', async (_event, payload) => ai.enhancePlan(await storage.loadSettings(), payload || {}));
  ipcMain.handle('ai:solve-problem', async (_event, payload) => ai.solveProblem(await storage.loadSettings(), payload || {}));
  ipcMain.handle('knowledge:load', async () => {
    const basePath = path.join(app.getAppPath(), 'knowledge', 'basic-circuits.json');
    const advancedPath = path.join(app.getAppPath(), 'knowledge', 'advanced-circuits.json');
    const base = JSON.parse(await fs.readFile(basePath, 'utf8'));
    const advanced = JSON.parse(await fs.readFile(advancedPath, 'utf8'));
    const legacyUser = await storage.loadUserKnowledge();
    const sqlSources = knowledgeDb.listSources().map(sourceToKnowledgeEntry);
    return { base, advanced, user: [...sqlSources, ...legacyUser], stats: knowledgeDb.stats() };
  });
  ipcMain.handle('knowledge:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入本地电路书籍与资料（仅限你有权使用的副本）',
      filters: [
        { name: '书籍与文本资料', extensions: ['pdf', 'txt', 'md', 'markdown', 'json'] },
        { name: 'PDF 书籍', extensions: ['pdf'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return { canceled: true, results: [], stats: knowledgeDb.stats() };
    const results = await knowledgeDb.importFiles(result.filePaths, localImportOptions());
    return { canceled: false, results, stats: knowledgeDb.stats() };
  });
  ipcMain.handle('knowledge:import-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '批量导入本地资料文件夹（最多 200 个受支持文件）',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, results: [], stats: knowledgeDb.stats() };
    const filePaths = await collectKnowledgeFiles(result.filePaths[0], 200);
    const results = await knowledgeDb.importFiles(filePaths, localImportOptions());
    return { canceled: false, results, stats: knowledgeDb.stats(), discovered: filePaths.length };
  });
  ipcMain.handle('knowledge:search', (_event, query, options) => {
    const safeQuery = String(query || '').slice(0, 2000);
    return knowledgeDb.search(safeQuery, options || {});
  });
  ipcMain.handle('knowledge:search-debug', (_event, query, options) => {
    const safeQuery = String(query || '').slice(0, 2000);
    const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    return knowledgeDb.searchWithTrace(safeQuery, safeOptions);
  });
  ipcMain.handle('knowledge:save', (_event, entries) => storage.saveUserKnowledge(entries));
  ipcMain.handle('projects:list', () => storage.loadProjects());
  ipcMain.handle('projects:save', (_event, project) => storage.saveProject(project));
  ipcMain.handle('projects:delete', (_event, id) => storage.deleteProject(String(id || '')));
  ipcMain.handle('agent-session:get', () => storage.loadAgentSession());
  ipcMain.handle('agent-session:save', (_event, session) => storage.saveAgentSession(session));
  ipcMain.handle('export:save', async (_event, payload) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: payload.title || '导出电路方案',
      defaultPath: payload.defaultName || 'circuit-plan.json',
      filters: payload.filters || [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, String(payload.data || ''), 'utf8');
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle('external:open', async (_event, value) => {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') throw new Error('只允许打开 HTTPS 链接。');
    await shell.openExternal(url.toString());
    return true;
  });
}

process.on('unhandledRejection', (reason) => { try { syncFs.writeFileSync(path.join(app.getPath('temp'), 'circuit-assistant-demo-error.log'), 'UNHANDLED: ' + (reason?.stack || reason), 'utf8'); } catch {} mainDiagnostic('warn', 'UNHANDLED: ' + (reason?.stack || reason)); });
app.whenReady().then(async () => {
  protocol.handle('circuit', (request) => net.fetch(pathToFileURL(safeLocalPath(request.url)).toString()));
  knowledgeDb = await KnowledgeDatabase.open(
    path.join(app.getPath('userData'), 'circuit-knowledge.sqlite3'),
    path.join(app.getAppPath(), 'database', 'schema.sql'),
  );
  await seedBundledPublicKnowledge();
  registerIpc();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error("CAUGHT-IN-CATCH:", error?.message);
  try { syncFs.writeFileSync(path.join(app.getPath("temp"), "circuit-assistant-demo-error.log"), String(error?.stack || error), "utf8"); } catch (writeError) { console.error("WRITE-FAILED:", writeError.message); }
  console.error("CALLING-APP-EXIT");
  app.exit(1);
  console.error("APP-EXIT-RETURNED");
  return;
  if (agentSmoke || process.argv.some((arg)=>arg.startsWith('--screenshot='))) {
    mainDiagnostic('warn', error?.stack || String(error));
    // 演示/回归在非 TTY 下运行时 stdout 会被 mainDiagnostic 吞掉，落盘一份便于排查。
    // 必须同步写：app.exit 不会等待挂起的异步写盘。
    try { syncFs.writeFileSync(path.join(app.getPath('temp'), 'circuit-assistant-demo-error.log'), error?.stack || String(error), 'utf8'); } catch { /* 忽略写盘失败 */ }
    app.exit(1);
    return;
  }
  throw error;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (knowledgeDb) {
    knowledgeDb.close();
    knowledgeDb = null;
  }
});
