import {
  generateCircuit,
  reviseCircuit,
  supervisePlan,
  knowledgeSearch,
  planToCsv,
  planToBundle,
  COMPONENT_LIBRARY,
  MARKET_PARTS_LIBRARY,
  solveCircuitProblem,
  optimizeCircuit,
  calculateEditorDragPosition,
} from '../shared/core.mjs';
import {
  auditEditorConnectivity,
  bindEditorWireEndpoints,
  canConnectEditorPins,
  componentTerminalPoints,
  normalizeEditorWireEndpoints,
  resolveEditorWirePoints,
} from '../shared/layout-agent.mjs';

import { AgentRun } from '../shared/agent-run.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const desktop = window.circuitDesktop;
const WIRE_PIN_SNAP_RADIUS_PX = 26;
const EDITOR_BASE_VIEW = Object.freeze({ w: 1000, h: 680 });
const EDITOR_MIN_ZOOM = .1;
const EDITOR_MAX_ZOOM = 4;

const state = {
  settings: null,
  aiStatus: { provider: 'local-rules', connected: true },
  knowledge: [],
  userKnowledge: [],
  dbStats: { source_count: 0, chunk_count: 0, character_count: 0, publisher_count: 0, needs_ocr_count: 0 },
  dbSearchHits: [],
  knowledgeSearchSequence: 0,
  knowledgeCategory: '全部',
  knowledgeLevel: '全部',
  projects: [],
  plan: null,
  audit: null,
  currentSvg: '',
  zoom: 1,
  image: null,
  editor: {
    id: '', name: '未命名电路', createdAt: '', components: [], wires: [],
    selected: null, selectedKind: '', tool: 'select', zoom: 1,
    viewBox: { x: 0, y: 0, w: 1000, h: 680 }, history: [], future: [],
    dirty: false, wireStart: null, wireDraft: null, wireDrag: null, wireHover: null, wireEdit: null, drag: null, pan: null, spacePressed: false,
    pendingCrossings: [], pendingCrossingTotal: 0,
  },
};

const pageMeta = {
  agent: ['Agent 工作台', '你的电路工程协作空间'],
  studio: ['电路工作室', '原理图编辑与连接'],
  designer: ['智能生成', '参数化电路方案生成'],
  vision: ['电路识图', '图像结构与工程线索识别'],
  solver: ['题目助手', '公式推导与数值求解'],
  optimizer: ['电路优化', '连接、性能与可靠性审查'],
  knowledge: ['知识中枢', '本地工程知识与来源管理'],
  settings: ['AI 与设置', '推理核心与接口配置'],
};

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function iconMarkup(name) {
  return `<svg class="ui-icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function toast(message, type = 'success') {
  const stack=$('#toast-stack');
  const duplicate=[...stack.children].find((item)=>item.dataset.message===message&&item.dataset.type===type);
  if (duplicate) {
    duplicate.classList.remove('repeated');
    requestAnimationFrame(()=>duplicate.classList.add('repeated'));
    return;
  }
  while (stack.children.length>=3) stack.firstElementChild?.remove();
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.dataset.message=message;
  item.dataset.type=type;
  item.innerHTML = `<i>${iconMarkup(type === 'error' ? 'alert' : 'check')}</i><span>${esc(message)}</span>`;
  stack.append(item);
  setTimeout(() => item.remove(), 4200);
}

function navigate(page) {
  if (!pageMeta[page]) return;
  if (page === 'agent') renderAgentWorkspace();
  $$('.nav-item').forEach((button) => {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
  $('#page-breadcrumb').textContent = pageMeta[page][0];
  $('#page-title').textContent = pageMeta[page][1];
  $('.workspace').scrollTo({ top: 0, behavior: 'smooth' });
}

function listHtml(items, extra = '') {
  const clean = (items || []).filter(Boolean);
  return clean.length ? `<ul class="info-list ${extra}">${clean.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="empty-copy">暂无</p>';
}

function evidenceHtml(items) {
  const clean = (items || []).filter((item) => item?.title);
  return clean.length
    ? `<div class="evidence-list">${clean.map((item) => {
      const page = item.pageStart ? ` · 第 ${item.pageStart}${item.pageEnd && item.pageEnd !== item.pageStart ? `-${item.pageEnd}` : ''} 页` : '';
      const source = `${item.sourceTitle || item.publisher || item.category || '本地资料'}${page}`;
      return `<button ${item.url ? `data-plan-source="${esc(item.url)}"` : 'disabled'}><b>${esc(item.title)}</b><span>${esc(source)}${item.url ? ` ${iconMarkup('external')}` : ' · 本机 SQL'}</span></button>`;
    }).join('')}</div>`
    : '<p class="empty-copy">当前没有匹配到专项依据；应以具体器件数据手册为准。</p>';
}

function retrievalTraceHtml(trace) {
  if (!trace) return '';
  const topics = (trace.topicsSelected || []).join('、');
  const expanded = (trace.expandedTerms || []).slice(0, 8).join('、');
  return `<div class="retrieval-summary"><b>${esc(trace.strengthLabel || '深度')}检索</b><span>${trace.routeCount} 路召回 · 候选 ${trace.candidateCount} 片段 · 融合选出 ${trace.selectedCount} 条${topics ? ` · 主题路由：${esc(topics)}` : ''}</span>${expanded ? `<small>同义扩展：${esc(expanded)}</small>` : ''}</div>`;
}

function updateRevisionExamples(plan) {
  const presets = {
    'motor-driver': [
      ['改为 12V 电池供电','电池改 12V'],
      ['单个电机堵转电流为 2.5A','堵转 2.5A'],
      ['改用 5V MCU，并设置 20kHz PWM','5V / 20kHz'],
      ['增加电流检测和 FAULT 故障回读','电流检测'],
    ],
    buck: [['输入范围改为 9V 到 16V','9–16V 输入'],['输出改为 3.3V','输出 3.3V'],['最大负载改为 2A','负载 2A'],['增加输入浪涌与欠压检查','浪涌/欠压']],
    boost: [['输入范围改为 3V 到 5V','3–5V 输入'],['输出改为 12V','输出 12V'],['最大负载改为 1A','负载 1A'],['要求关断时隔离输出','关断隔离']],
    opamp: [['增益改为 11 倍','增益 11×'],['供电改为 5V 单电源','5V 单电源'],['输入频率最高 20kHz','20kHz 带宽'],['负载为 1nF 电容','容性负载']],
    'led-driver': [['改为 12V 供电','改为 12V'],['换成白色 LED','白色 LED'],['电流改为 5mA','5 mA'],['去掉开关','去掉开关']],
  };
  const options = presets[plan.kind] || [['补充输入电压范围','输入范围'],['补充最大负载电流','负载电流'],['增加接口保护','接口保护'],['增加测试点与验证步骤','验证步骤']];
  const buttons = $$('.revision-examples button');
  buttons.forEach((button, index) => {
    button.dataset.revision = options[index][0];
    button.textContent = options[index][1];
  });
  $('#revision-input').placeholder = plan.kind === 'motor-driver'
    ? '例如：12V 电池、堵转电流 2.5A、3.3V MCU、20kHz PWM'
    : '描述要修改的电压、电流、器件、控制方式或验证条件';
}

function setBusy(button, busy) {
  button.classList.toggle('loading', busy);
  button.disabled = busy;
}

function metric(value, unit) {
  return value == null ? '' : `<span>${esc(value)} ${unit}</span>`;
}

function symbolSvg(item) {
  const x = Number(item.x) || 0;
  const y = Number(item.y) || 0;
  const rotate = Number(item.rotate) || 0;
  const ref = item.hideRef ? '' : esc(item.ref);
  const value = item.hideValue ? '' : esc(item.value);
  const combinedLabel = [ref, value].filter(Boolean).join(' · ');
  const stroke = '#d9e7ed';
  const accent = '#62d6ae';
  const muted = '#8198a9';
  const transform = `translate(${x} ${y}) rotate(${rotate})`;
  let shape = '';
  if (item.type === 'terminal') {
    shape = `<circle r="5" fill="${accent}"/><circle r="10" fill="none" stroke="${accent}" stroke-opacity=".24"/>${value || ref ? `<text x="${Number(item.labelX ?? 0)}" y="${Number(item.labelY ?? -18)}" text-anchor="${esc(item.labelAnchor || 'middle')}" fill="${stroke}" font-size="11" font-weight="650" paint-order="stroke" stroke="#0c1b29" stroke-width="4">${value || ref}</text>` : ''}`;
  } else if (item.type === 'resistor') {
    shape = `<path d="M-39 0h13l6-9 10 18 10-18 10 18 10-18 6 9h13" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>${combinedLabel ? `<text x="0" y="-18" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'fuse') {
    shape = `<path d="M-35 0h10M25 0h10" stroke="${stroke}" stroke-width="2"/><rect x="-25" y="-8" width="50" height="16" rx="3" fill="#11283a" stroke="${stroke}" stroke-width="2"/><path d="M-18 0h36" stroke="${accent}" stroke-width="2"/>${combinedLabel ? `<text x="0" y="-17" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'switch') {
    shape = `<path d="M-38 0h14M24 0h14M-20-3L18-16" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/><circle cx="-22" cy="0" r="3" fill="${accent}"/><circle cx="22" cy="0" r="3" fill="${accent}"/>${combinedLabel ? `<text x="0" y="-24" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'capacitor' || item.type === 'electrolytic' || item.type === 'tantalum') {
    const labelX = Number(item.labelX ?? (item.labelSide === 'left' ? -20 : 20));
    const labelY = Number(item.labelY ?? 4);
    const anchor = item.labelSide === 'left' ? 'end' : 'start';
    const labels = [ref, value].filter(Boolean);
    const polarity = item.type !== 'capacitor' ? `<text x="-21" y="-14" fill="${accent}" font-size="14" font-weight="700">+</text>` : '';
    shape = `<path d="M0-30v20M-15-10h30M-15 10h30M0 10v20" fill="none" stroke="${stroke}" stroke-width="2"/>${polarity}${labels.map((label,index)=>`<text x="${labelX}" y="${labels.length > 1 ? labelY - 7 + index * 13 : labelY}" text-anchor="${anchor}" fill="${muted}" font-size="${index ? 8 : 9}" paint-order="stroke" stroke="#0c1b29" stroke-width="4">${label}</text>`).join('')}`;
  } else if (item.type === 'thermistor' || item.type === 'varistor' || item.type === 'photoresistor') {
    const strike = item.type === 'thermistor' ? `<path d="M-28-20L28 20" stroke="${stroke}" stroke-width="1.5"/><text x="30" y="22" fill="${accent}" font-size="8">t°</text>`
      : item.type === 'varistor' ? `<path d="M-28-20L28 20" stroke="${stroke}" stroke-width="1.5"/><text x="29" y="14" fill="${accent}" font-size="9">U</text>`
        : `<path d="M-14-28l10 6M-14-28v9M-14-28h9M6-28l10 6M6-28v9M6-28h9" fill="none" stroke="${accent}" stroke-width="1.4"/>`;
    shape = `<path d="M-39 0h13l6-9 10 18 10-18 10 18 10-18 6 9h13" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>${strike}${combinedLabel ? `<text x="0" y="-34" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'ferrite-bead') {
    shape = `<path d="M-39 0h8c2-14 17-14 19 0 2-14 17-14 19 0 2-14 17-14 19 0h13" fill="none" stroke="${stroke}" stroke-width="2"/><rect x="-26" y="-13" width="52" height="26" rx="4" fill="none" stroke="${accent}" stroke-width="1.4"/>${combinedLabel ? `<text x="0" y="-22" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'tvs-diode') {
    shape = `<path d="M-37 0h13M5 0h32M-24-14v28l26-14z" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/><path d="M5-15l-5 5 5 5M5 5l-5 5 5 5" fill="none" stroke="${stroke}" stroke-width="2"/><path d="M-8-20l10-8m-5 0h5v5M2 20l10 8m-5 0h5v-5" fill="none" stroke="${accent}" stroke-width="1.4"/>${combinedLabel ? `<text x="0" y="-30" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'photodiode') {
    shape = `<path d="M-37 0h13M5 0h32M-24-14v28l26-14z" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/><path d="M5-15v30" fill="none" stroke="${stroke}" stroke-width="2"/><path d="M-12-26l10 8m-5 0h5v-5M2-26l10 8m-5 0h5v-5" fill="none" stroke="${accent}" stroke-width="1.4"/>${combinedLabel ? `<text x="0" y="-34" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'inductor') {
    shape = `<path d="M-39 0h8c2-14 17-14 19 0 2-14 17-14 19 0 2-14 17-14 19 0h13" fill="none" stroke="${stroke}" stroke-width="2"/>${combinedLabel ? `<text x="0" y="-19" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'potentiometer') {
    shape = `<path d="M-39 0h13l6-9 10 18 10-18 10 18 6-9h13M0-30V-16l-7 7" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/><path d="M-3-18 0-15 3-18" fill="none" stroke="${accent}" stroke-width="1.5"/>${combinedLabel ? `<text x="0" y="-38" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'crystal') {
    shape = `<path d="M-39 0h20M19 0h20M-19-15v30M19-15v30" fill="none" stroke="${stroke}" stroke-width="2"/><path d="M-13-15v30M13-15v30" fill="none" stroke="${accent}" stroke-width="2"/>${combinedLabel ? `<text x="0" y="-24" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'transformer') {
    shape = `<path d="M-55-18h17M-55 18h17M38-18h17M38 18h17" fill="none" stroke="${stroke}" stroke-width="2"/><path d="M-28-30c-20 0-20 18 0 18s20 18 0 18-20 18 0 18M28-30c20 0 20 18 0 18s-20 18 0 18 20 18 0 18" fill="none" stroke="${stroke}" stroke-width="2"/><path d="M0-36v72" stroke="${accent}" stroke-width="1.5" stroke-dasharray="3 3"/>${combinedLabel ? `<text x="0" y="-42" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (['diode', 'led', 'zener', 'schottky'].includes(item.type)) {
    const cathode = item.type === 'zener' ? 'M5-15l-5 5 5 5M5 5l-5 5 5 5' : item.type === 'schottky' ? 'M5-15v30M10-15v30' : 'M5-15v30';
    shape = `<path d="M-37 0h13M5 0h32M-24-14v28l26-14z" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/><path d="${cathode}" fill="none" stroke="${stroke}" stroke-width="2"/>${item.type === 'led' ? `<path d="M4-17l14-13m-7 2h7v7M12-7l14-13m-7 2h7v7" fill="none" stroke="${accent}" stroke-width="1.5"/>` : ''}${combinedLabel ? `<text x="0" y="-24" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'bjt') {
    shape = `<path d="M-35 0h15M-5-28v56M-5-20h13M-5 20h13M8-34v16M8 18v16" fill="none" stroke="${stroke}" stroke-width="2"/><path d="M8-18l19-18M8 18l19 18" fill="none" stroke="${stroke}" stroke-width="2"/><path d="M22 27l5 9-10-2z" fill="${accent}"/>${combinedLabel ? `<text x="20" y="-42" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'pmosfet') {
    shape = `<path d="M-35-35v70M-35 0h18M-12-28v18M-12 10v18M-12-19h20v-22M-12 19h20v22M8-41v82" fill="none" stroke="${stroke}" stroke-width="2"/><path d="M-8 0l12-6v12z" fill="${accent}"/><path d="M-1-9l-9-7" fill="none" stroke="${accent}" stroke-width="1.5"/>${combinedLabel ? `<text x="27" y="4" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'opamp') {
    shape = `<path d="M-55-40v80l75-40z" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M-55-20h-18M-55 20h-18M20 0h25" stroke="${stroke}" stroke-width="2"/><text x="-44" y="-14" fill="${accent}" font-size="13">+</text><text x="-44" y="25" fill="${accent}" font-size="15">−</text>${ref ? `<text x="-14" y="-4" text-anchor="middle" fill="${stroke}" font-size="9">${ref}</text>` : ''}${value ? `<text x="-14" y="9" text-anchor="middle" fill="${muted}" font-size="8">${value}</text>` : ''}`;
  } else if (item.type === 'source') {
    shape = `<path d="M-38 0h16M22 0h16" stroke="${stroke}" stroke-width="2"/><circle r="22" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M-7-7h14M0-14v14M-7 10h14" stroke="${accent}" stroke-width="2"/>${combinedLabel ? `<text x="0" y="-31" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'scr' || item.type === 'triac' || item.type === 'igbt') {
    const labels3 = item.type === 'scr' ? ['A', 'K'] : item.type === 'triac' ? ['MT2', 'MT1'] : ['C', 'E'];
    const gateSymbol = item.type === 'triac'
      ? `<path d="M-8 0l12-6v12zM-8 0l12 6v-12z" fill="${accent}"/><path d="M-1-9l-9-7" fill="none" stroke="${accent}" stroke-width="1.5"/>`
      : `<path d="M-8 0l12-6v12z" fill="${accent}"/>${item.type === 'igbt' ? `<path d="M8 6v8M4 14h8" fill="none" stroke="${accent}" stroke-width="1.5"/>` : ''}`;
    shape = `<path d="M-35-35v70M-35 0h18M-12-28v18M-12 10v18M-12-19h20v-22M-12 19h20v22M8-41v82" fill="none" stroke="${stroke}" stroke-width="2"/>${gateSymbol}<text x="14" y="-30" fill="${muted}" font-size="7">${labels3[0]}</text><text x="14" y="38" fill="${muted}" font-size="7">${labels3[1]}</text>${ref ? `<text x="30" y="4" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'push-button') {
    shape = `<path d="M-38 0h14M24 0h14M-20-3l40-12" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/><circle cx="-22" cy="0" r="3" fill="${accent}"/><circle cx="22" cy="0" r="3" fill="${accent}"/><path d="M0-15v-10M-8-25h16" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>${combinedLabel ? `<text x="0" y="22" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'dip-switch') {
    shape = `<rect x="-34" y="-22" width="68" height="44" rx="4" fill="#11283a" stroke="${stroke}" stroke-width="1.8"/><path d="M-22-10h14M8-10h14M-22 10h14M8 10h14" stroke="${stroke}" stroke-width="2"/><path d="M-8-10h4M-8 10h4" stroke="${accent}" stroke-width="2.4"/>${ref ? `<text x="0" y="-27" text-anchor="middle" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'speaker') {
    shape = `<path d="M-38 0h10M28 0h10" stroke="${stroke}" stroke-width="2"/><path d="M-10-14h10l16-12v52l-16-12h-10z" fill="#102638" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/><path d="M20-14q10 14 0 28M27-20q15 20 0 40" fill="none" stroke="${accent}" stroke-width="1.5"/>${combinedLabel ? `<text x="0" y="-32" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'mic') {
    shape = `<path d="M-38 0h10M28 0h10" stroke="${stroke}" stroke-width="2"/><rect x="-14" y="-12" width="28" height="24" rx="6" fill="#102638" stroke="${stroke}" stroke-width="2"/><circle cx="0" cy="0" r="6" fill="none" stroke="${accent}" stroke-width="1.5"/><path d="M0-6v12M-6 0h12" stroke="${accent}" stroke-width="1"/>${combinedLabel ? `<text x="0" y="-24" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'usb-port') {
    shape = `<path d="M-34-24h40l12 10v28l-12 10h-40z" fill="#11283a" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round"/><path d="M-34-18h-11M-34-6h-11M-34 6h-11M-34 18h-11" stroke="${stroke}" stroke-width="2"/><text x="4" y="4" text-anchor="middle" fill="${accent}" font-size="9" font-weight="650">USB</text>${ref ? `<text x="4" y="16" text-anchor="middle" fill="${muted}" font-size="7">${ref}</text>` : ''}`;
  } else if (item.type === 'dc-jack') {
    shape = `<rect x="-34" y="-20" width="66" height="40" rx="5" fill="#11283a" stroke="${stroke}" stroke-width="1.8"/><circle cx="-12" cy="0" r="9" fill="none" stroke="${accent}" stroke-width="2"/><circle cx="-12" cy="0" r="3.5" fill="none" stroke="${stroke}" stroke-width="1.4"/><path d="M-34-14h-6M-34 0h-6M-34 14h-6" stroke="${stroke}" stroke-width="2"/>${ref ? `<text x="14" y="4" text-anchor="middle" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'battery-holder') {
    shape = `<path d="M-38 0h16M22 0h16M-14-18v36M14-18v36" stroke="${stroke}" stroke-width="2"/><path d="M-14-8h28M-14 8h28" stroke="${stroke}" stroke-width="2"/><path d="M-7-13v10M7-13v10" stroke="${accent}" stroke-width="1.5"/>${combinedLabel ? `<text x="0" y="-26" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'jumper') {
    shape = `<path d="M-20 0h-14M20 0h14" stroke="${stroke}" stroke-width="2"/><circle cx="-20" cy="0" r="4" fill="none" stroke="${accent}" stroke-width="2"/><circle cx="20" cy="0" r="4" fill="none" stroke="${accent}" stroke-width="2"/><rect x="-16" y="-9" width="32" height="18" rx="4" fill="#11283a" stroke="${stroke}" stroke-width="1.5"/>${ref ? `<text x="0" y="-14" text-anchor="middle" fill="${muted}" font-size="8">${ref}</text>` : ''}`;
  } else if (item.type === 'header') {
    shape = `<rect x="-8" y="-26" width="46" height="52" rx="4" fill="#11283a" stroke="${stroke}" stroke-width="1.6"/><path d="M-8-18h-9M-8-6h-9M-8 6h-9M-8 18h-9" stroke="${stroke}" stroke-width="2"/><circle cx="16" cy="-18" r="4.5" fill="#0c1b29" stroke="${accent}" stroke-width="1.6"/><circle cx="16" cy="-6" r="4.5" fill="#0c1b29" stroke="${accent}" stroke-width="1.6"/><circle cx="16" cy="6" r="4.5" fill="#0c1b29" stroke="${accent}" stroke-width="1.6"/><circle cx="16" cy="18" r="4.5" fill="#0c1b29" stroke="${accent}" stroke-width="1.6"/>${ref ? `<text x="16" y="-31" text-anchor="middle" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'antenna') {
    shape = `<path d="M0 26v-40" stroke="${stroke}" stroke-width="2"/><path d="M0-14L-16-34M0-14L16-34M0-14V-38" fill="none" stroke="${accent}" stroke-width="1.8" stroke-linecap="round"/><path d="M-22-34q22-14 44 0" fill="none" stroke="${accent}" stroke-width="1.2" stroke-dasharray="3 3"/>${ref ? `<text x="0" y="40" text-anchor="middle" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'stepper') {
    shape = `<path d="M-39-12h17M-39 12h17M22-12h17M22 12h17" stroke="${stroke}" stroke-width="2"/><circle r="22" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M-8-8h16M-8 8h16M-8-8v16M8-8v16" stroke="${accent}" stroke-width="1.5" fill="none"/>${ref ? `<text x="0" y="-4" text-anchor="middle" fill="${stroke}" font-size="9" font-weight="650">${ref}</text>` : ''}${value ? `<text x="0" y="30" text-anchor="middle" fill="${muted}" font-size="8">${value}</text>` : ''}`;
  } else if (item.type === 'servo') {
    shape = `<rect x="-40" y="-24" width="80" height="48" rx="5" fill="#102638" stroke="${stroke}" stroke-width="2"/><circle cx="26" cy="0" r="11" fill="#11283a" stroke="${accent}" stroke-width="1.6"/><path d="M26 0V-11" stroke="${accent}" stroke-width="2.4"/><path d="M-40-15h-5M-40 0h-5M-40 15h-5" stroke="${stroke}" stroke-width="2"/>${ref ? `<text x="-10" y="4" text-anchor="middle" fill="${stroke}" font-size="10" font-weight="650">${ref}</text>` : ''}${value ? `<text x="-10" y="17" text-anchor="middle" fill="${muted}" font-size="7">${value}</text>` : ''}`;
  } else if (item.type === 'fan') {
    shape = `<path d="M-38 0h16M22 0h16" stroke="${stroke}" stroke-width="2"/><circle r="22" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M0-14q7 7 0 14t-14 0q-7-7 0-14t14 0M0 0l12 8M0 0l-12 8M0 0l0 12" fill="none" stroke="${accent}" stroke-width="1.5"/>${combinedLabel ? `<text x="0" y="-30" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'solenoid') {
    shape = `<path d="M-38 0h10M28 0h10" stroke="${stroke}" stroke-width="2"/><rect x="-28" y="-14" width="56" height="28" rx="3" fill="#11283a" stroke="${stroke}" stroke-width="2"/><path d="M-20-14v28M-10-14v28M0-14v28M10-14v28M20-14v28" stroke="${accent}" stroke-width="1.4"/>${ref ? `<text x="0" y="-22" text-anchor="middle" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'ir-receiver') {
    shape = `<rect x="-26" y="-18" width="52" height="36" rx="4" fill="#11283a" stroke="${stroke}" stroke-width="1.8"/><circle cx="12" cy="0" r="9" fill="#0c1b29" stroke="${accent}" stroke-width="2"/><circle cx="12" cy="0" r="3" fill="${accent}"/><path d="M-26-12h-13M-26 0h-13M-26 12h-13" stroke="${stroke}" stroke-width="2"/>${ref ? `<text x="-8" y="-22" text-anchor="middle" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'sensor3' || item.type === 'sensor4') {
    const four = item.type === 'sensor4';
    const width = four ? 72 : 56;
    const left = -width / 2;
    shape = `<rect x="${left}" y="-20" width="${width}" height="40" rx="5" fill="#102638" stroke="${stroke}" stroke-width="1.8"/><path d="M${left} -10h-13M${left} 0h-13M${left} 10h-13${four ? `M${left} 18h-13` : ''}" stroke="${stroke}" stroke-width="2"/><path d="M${left + 8} -12h${width - 20}M${left + 8} 0h${width - 20}M${left + 8} 12h${width - 20}" stroke="${accent}" stroke-width="1" stroke-opacity=".45"/>${ref ? `<text x="0" y="4" text-anchor="middle" fill="${stroke}" font-size="9" font-weight="650">${ref}</text>` : ''}${value ? `<text x="0" y="15" text-anchor="middle" fill="${muted}" font-size="7">${value}</text>` : ''}`;
  } else if (item.type === 'sonar') {
    shape = `<rect x="-45" y="-16" width="90" height="32" rx="5" fill="#102638" stroke="${stroke}" stroke-width="1.8"/><circle cx="-24" cy="0" r="11" fill="#0c1b29" stroke="${accent}" stroke-width="2"/><circle cx="24" cy="0" r="11" fill="#0c1b29" stroke="${accent}" stroke-width="2"/><circle cx="-24" cy="0" r="4" stroke="${accent}" stroke-width="1" fill="none"/><circle cx="24" cy="0" r="4" stroke="${accent}" stroke-width="1" fill="none"/><path d="M-45-10h-7M-45-2h-7M-45 2h-7M-45 10h-7" stroke="${stroke}" stroke-width="2"/>${ref ? `<text x="0" y="-22" text-anchor="middle" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'lcd') {
    shape = `<rect x="-45" y="-30" width="90" height="60" rx="4" fill="#102638" stroke="${stroke}" stroke-width="1.8"/><rect x="-38" y="-22" width="62" height="34" rx="2" fill="#0c1b29" stroke="${accent}" stroke-width="1.2"/><path d="M-32-14h50M-32-6h50M-32 2h50M-32-14v16M-22-14v16M-12-14v16M-2-14v16" stroke="${accent}" stroke-width=".7" stroke-opacity=".55"/><path d="M-45-18h-7M-45-6h-7M-45 6h-7M-45 18h-7" stroke="${stroke}" stroke-width="2"/>${ref ? `<text x="4" y="-34" text-anchor="middle" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'wireless-module') {
    shape = `<rect x="-45" y="-28" width="90" height="56" rx="5" fill="#102638" stroke="${stroke}" stroke-width="1.8"/><path d="M0-28v-10" stroke="${stroke}" stroke-width="2"/><path d="M0-38l-9-8M0-38l9-8" fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round"/><path d="M-45-18h-7M-45-6h-7M-45 6h-7M-45 18h-7" stroke="${stroke}" stroke-width="2"/><path d="M-36-16q13 10 26 0t26 0" fill="none" stroke="${accent}" stroke-width="1.1" stroke-opacity=".5"/>${ref ? `<text x="0" y="4" text-anchor="middle" fill="${stroke}" font-size="9" font-weight="650">${ref}</text>` : ''}${value ? `<text x="0" y="16" text-anchor="middle" fill="${muted}" font-size="7">${value}</text>` : ''}`;
  } else if (item.type === 'ground') {
    shape = `<path d="M0-10v10M-17 0h34M-11 6h22M-5 12h10" stroke="${muted}" stroke-width="2"/>${ref ? `<text x="0" y="28" text-anchor="middle" fill="${muted}" font-size="8">${ref}</text>` : ''}`;
  } else if (item.type === 'mosfet') {
    shape = `<path d="M-35-35v70M-35 0h18M-12-28v18M-12 10v18M-12-19h20v-22M-12 19h20v22M8-41v82" fill="none" stroke="${stroke}" stroke-width="2"/><path d="M-8 0l12-6v12z" fill="${accent}"/>${ref ? `<text x="27" y="4" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'voltage-regulator') {
    shape = `<rect x="-45" y="-30" width="90" height="60" rx="5" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M-45 0h-12M45 0h12M-20 30v12M0 30v12" stroke="${stroke}" stroke-width="2"/><path d="M-25-8h50M-25 8h50" stroke="${accent}" stroke-width="1.5"/><text x="0" y="4" text-anchor="middle" fill="${stroke}" font-size="10" font-weight="650">${ref || 'REG'}</text>${value ? `<text x="0" y="20" text-anchor="middle" fill="${muted}" font-size="8">${value}</text>` : ''}<text x="-54" y="-8" text-anchor="end" fill="${muted}" font-size="7">IN</text><text x="54" y="-8" fill="${muted}" font-size="7">OUT</text><text x="-20" y="52" text-anchor="middle" fill="${muted}" font-size="7">EN</text><text x="0" y="52" text-anchor="middle" fill="${muted}" font-size="7">GND</text>`;
  } else if (item.type === 'comparator') {
    shape = `<path d="M-55-40v80l75-40z" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M-55-20h-18M-55 20h-18M20 0h25M0-40v-12M0 40v12" stroke="${stroke}" stroke-width="2"/><text x="-44" y="-14" fill="${accent}" font-size="13">+</text><text x="-44" y="25" fill="${accent}" font-size="15">−</text>${ref ? `<text x="-14" y="-4" text-anchor="middle" fill="${stroke}" font-size="9">${ref}</text>` : ''}${value ? `<text x="-14" y="9" text-anchor="middle" fill="${muted}" font-size="8">${value}</text>` : ''}`;
  } else if (item.type === 'logic-gate') {
    shape = `<path d="M-45-30h20c30 0 45 13 45 30s-15 30-45 30h-20z" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M-45-12h-12M-45 12h-12M20 0h37M0-30v-12M0 30v12" stroke="${stroke}" stroke-width="2"/><text x="-12" y="5" text-anchor="middle" fill="${accent}" font-size="11" font-weight="650">AND</text>${ref ? `<text x="0" y="-48" text-anchor="middle" fill="${muted}" font-size="9">${ref}</text>` : ''}`;
  } else if (item.type === 'relay') {
    shape = `<rect x="-45" y="-30" width="90" height="60" rx="4" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M-45-18h-17M-45 18h-17M45 0h17M45-18h17M45 18h17" stroke="${stroke}" stroke-width="2"/><path d="M-34-18q18-16 36 0M4-18l18-11" fill="none" stroke="${accent}" stroke-width="2"/><path d="M4 18h18" stroke="${accent}" stroke-width="2"/>${ref ? `<text x="0" y="-3" text-anchor="middle" fill="${stroke}" font-size="10" font-weight="650">${ref}</text>` : ''}${value ? `<text x="0" y="12" text-anchor="middle" fill="${muted}" font-size="8">${value}</text>` : ''}`;
  } else if (item.type === 'battery') {
    shape = `<path d="M-38 0h16M22 0h16M-6-19v38M6-10v20" stroke="${stroke}" stroke-width="2"/><path d="M-11-6h10M-6-11v10" stroke="${accent}" stroke-width="2"/>${combinedLabel ? `<text x="0" y="-28" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'motor') {
    shape = `<path d="M-39 0h17M22 0h17" stroke="${stroke}" stroke-width="2"/><circle r="22" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M-8 0h16M0-8v16" stroke="${accent}" stroke-width="2"/><path d="M-8-14q12 7 16 17" fill="none" stroke="${accent}" stroke-width="1.5"/>${combinedLabel ? `<text x="0" y="-31" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'buzzer') {
    shape = `<path d="M-38 0h16M22 0h16" stroke="${stroke}" stroke-width="2"/><path d="M-20-16v32h16l15 12v-56L-4-16z" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M18-12q16 12 0 24M24-19q25 19 0 38" fill="none" stroke="${accent}" stroke-width="1.5"/>${combinedLabel ? `<text x="0" y="-32" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'testpoint') {
    shape = `<path d="M0-22v10" stroke="${stroke}" stroke-width="2"/><circle cy="0" r="11" fill="#102638" stroke="${accent}" stroke-width="2"/><circle cy="0" r="3" fill="${accent}"/>${combinedLabel ? `<text x="0" y="-29" text-anchor="middle" fill="${muted}" font-size="9">${combinedLabel}</text>` : ''}`;
  } else if (item.type === 'opto') {
    shape = `<rect x="-45" y="-30" width="90" height="60" rx="5" fill="#102638" stroke="${stroke}" stroke-width="2"/><path d="M-45-18h-12M-45 18h-12M45-18h12M45 18h12" stroke="${stroke}" stroke-width="2"/><path d="M-24-10l14 10-14 10zM-5-14v28M8-20c14 8 14 32 0 40" fill="none" stroke="${accent}" stroke-width="1.8"/>${ref ? `<text x="20" y="-4" text-anchor="middle" fill="${stroke}" font-size="9">${ref}</text>` : ''}${value ? `<text x="20" y="10" text-anchor="middle" fill="${muted}" font-size="8">${value}</text>` : ''}`;
  } else {
    const width = item.type === 'connector' ? 64 : item.type === 'ic' ? 90 : 90;
    const height = item.type === 'connector' ? 60 : 60;
    const powerPins = item.powerPins ? `<path d="M0 ${-height/2 - 12}v12M0 ${height/2}v12" stroke="${stroke}" stroke-width="1.5"/>` : '';
    const controlPin = item.controlPin ? `<path d="M20 ${height/2}v12" stroke="${stroke}" stroke-width="1.5"/>` : '';
    const feedbackPin = item.feedbackPin ? `<path d="M24 ${height/2}v12" stroke="${stroke}" stroke-width="1.5"/>` : '';
    shape = `<rect x="${-width/2}" y="${-height/2}" width="${width}" height="${height}" rx="${item.type === 'block' ? 8 : 5}" fill="#11283a" stroke="${stroke}" stroke-width="1.5"/><path d="M${-width/2} -12h-12M${width/2} -12h12M${-width/2} 12h-12M${width/2} 12h12" stroke="${stroke}" stroke-width="1.5"/>${powerPins}${controlPin}${feedbackPin}${ref ? `<text x="0" y="-3" text-anchor="middle" fill="${stroke}" font-size="10" font-weight="650">${ref}</text>` : ''}${value ? `<text x="0" y="12" text-anchor="middle" fill="${accent}" font-size="8">${value}</text>` : ''}`;
  }
  return `<g transform="${transform}" class="schematic-component">${shape}</g>`;
}

function componentIconSvg(definition) {
  const raw = symbolSvg({ type:definition.type, ref:definition.prefix, value:definition.value, x:0, y:0, rotate:0 })
    .replace(/<text[^>]*>[\s\S]*?<\/text>/g, '')
    .replace('class="schematic-component"', 'class="library-symbol-shape"');
  const labels = {
    source:'±', connector:'J', ic:'IC', timer:'555', mcu:'µC', sensor:'S', block:'MOD',
    potentiometer:'RV', electrolytic:'C+', tantalum:'C+', crystal:'Y', transformer:'T',
    schottky:'SD', zener:'ZD', bjt:'Q', mosfet:'Q', pmosfet:'Q', opto:'OC',
    comparator:'CMP', 'voltage-regulator':'REG', 'logic-gate':'AND', battery:'BAT',
    relay:'K', motor:'M', buzzer:'BZ', testpoint:'TP',
    thermistor:'RT', varistor:'RV', photoresistor:'RL', 'ferrite-bead':'FB',
    'tvs-diode':'TVS', photodiode:'PD', scr:'SCR', triac:'TRC', igbt:'IGBT',
    'push-button':'SW', 'dip-switch':'DSW', speaker:'LS', mic:'MIC', jumper:'JP',
    'usb-port':'USB', 'dc-jack':'DC', header:'J', antenna:'ANT',
    stepper:'M', servo:'M', fan:'M', solenoid:'YV', 'ir-receiver':'IR',
    lcd:'LCD', 'wireless-module':'RF', sonar:'US', sensor3:'SNS', sensor4:'SNS',
  };
  const label = labels[definition.type];
  return `<svg viewBox="0 0 96 64" aria-hidden="true" focusable="false"><g transform="translate(48 32) scale(.72)">${raw}</g>${label ? `<text x="48" y="36" text-anchor="middle" class="library-symbol-label">${label}</text>` : ''}</svg>`;
}

function editorSnapshot() {
  return {
    components: structuredClone(state.editor.components),
    wires: structuredClone(state.editor.wires),
    selected: state.editor.selected,
    selectedKind: state.editor.selectedKind,
  };
}

function clearPendingCrossings() {
  state.editor.pendingCrossings = [];
  state.editor.pendingCrossingTotal = 0;
  $('#wire-crossing-dialog')?.close?.();
}

function restoreEditorSnapshot(snapshot) {
  state.editor.components = structuredClone(snapshot.components || []);
  state.editor.wires = structuredClone(snapshot.wires || []);
  state.editor.selected = snapshot.selected || null;
  state.editor.selectedKind = snapshot.selectedKind || '';
  // 撤销/重做可能移除尚未答复交点询问的导线，避免对不存在的新线继续弹窗。
  clearPendingCrossings();
  state.editor.dirty = true;
  renderEditor();
  markEditorDirty();
}

function pushEditorHistory() {
  state.editor.history.push(editorSnapshot());
  if (state.editor.history.length > 60) state.editor.history.shift();
  state.editor.future = [];
}

function undoEditor() {
  const snapshot = state.editor.history.pop();
  if (!snapshot) return;
  state.editor.future.push(editorSnapshot());
  restoreEditorSnapshot(snapshot);
}

function redoEditor() {
  const snapshot = state.editor.future.pop();
  if (!snapshot) return;
  state.editor.history.push(editorSnapshot());
  restoreEditorSnapshot(snapshot);
}

function markEditorDirty() {
  state.editor.dirty = true;
  $('#project-save-state').textContent = '有未保存更改';
  $('#project-save-state').classList.remove('saved');
  $('#opt-project-meta').textContent = `${state.editor.components.length} 个元件 · ${state.editor.wires.length} 条连线`;
}

function nextReference(prefix) {
  if (prefix === 'GND') return 'GND';
  const used = new Set(state.editor.components.map((item) => String(item.ref || '').toUpperCase()));
  let index = 1;
  while (used.has(`${prefix}${index}`.toUpperCase())) index++;
  return `${prefix}${index}`;
}

function addEditorComponent(type, x, y, custom = {}) {
  const definition = COMPONENT_LIBRARY.find((item) => item.type === type) || COMPONENT_LIBRARY.find((item) => item.type === 'block');
  pushEditorHistory();
  const component = {
    id: `cmp-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    type: definition.type,
    ref: nextReference(definition.prefix),
    value: definition.value,
    description: definition.description,
    x: Math.round((Number.isFinite(Number(x)) ? Number(x) : state.editor.viewBox.x + state.editor.viewBox.w / 2) / 10) * 10,
    y: Math.round((Number.isFinite(Number(y)) ? Number(y) : state.editor.viewBox.y + state.editor.viewBox.h / 2) / 10) * 10,
    rotate: 0,
    ...custom,
  };
  state.editor.components.push(component);
  state.editor.selected = component.id;
  state.editor.selectedKind = 'component';
  state.editor.wireStart = null;
  markEditorDirty();
  renderEditor();
  return component;
}

function componentById(id) {
  return state.editor.components.find((item) => item.id === id);
}

function wireStartDetails() {
  if (!state.editor.wireStart) return null;
  return typeof state.editor.wireStart === 'string'
    ? { componentId: state.editor.wireStart, pinId: null }
    : state.editor.wireStart;
}

function componentGrabBounds(item = {}) {
  if (['opamp', 'comparator'].includes(item.type)) return { x:-84, y:-56, width:148, height:112 };
  if (['mosfet', 'pmosfet', 'bjt', 'scr', 'triac', 'igbt'].includes(item.type)) return { x:-52, y:-58, width:104, height:116 };
  if (['voltage-regulator', 'logic-gate', 'relay', 'opto'].includes(item.type)) return { x:-72, y:-56, width:144, height:112 };
  if (item.type === 'transformer') return { x:-70, y:-52, width:140, height:104 };
  if (item.type === 'testpoint') return { x:-28, y:-35, width:56, height:70 };
  if (item.type === 'terminal') return { x:-34, y:-38, width:68, height:76 };
  if (item.type === 'ground') return { x:-42, y:-32, width:84, height:72 };
  if (['ic','connector','block','mcu','timer','sensor','lcd','sonar','wireless-module','sensor4','servo','usb-port','dc-jack','dip-switch','ir-receiver','header','stepper'].includes(item.type)) return { x:-72, y:-56, width:144, height:112 };
  return { x:-66, y:-54, width:132, height:108 };
}

function editorSymbol(item) {
  const selected = state.editor.selectedKind === 'component' && state.editor.selected === item.id;
  const target = state.editor.wireHover?.componentId === item.id;
  const bounds = componentGrabBounds(item);
  return symbolSvg(item)
    .replace('class="schematic-component"', `class="editor-component${selected ? ' selected' : ''}${target ? ' wire-target' : ''}" data-id="${esc(item.id)}"`)
    .replace(/<\/g>$/, `<rect class="selection-box" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" rx="9"/></g>`);
}

function wirePath(wireItem) { console.log("TR:wirePath enter");
  return resolveEditorWirePoints(wireItem, state.editor.components)
    .map(([x,y]) => `${Number(x)},${Number(y)}`).join(' ');
}

function wireLabelPosition(wireItem) {
  const points = resolveEditorWirePoints(wireItem, state.editor.components);
  return {
    x: points[0]?.[0] ?? 0,
    y: (points[0]?.[1] ?? 0) - 8,
  };
}

function editorWireSegments(wireItem) {
  const points = resolveEditorWirePoints(wireItem, state.editor.components);
  return points.slice(0,-1).map((point,index) => {
    const next = points[index+1];
    const vertical = Math.abs(Number(point[0])-Number(next[0])) < .001;
    return {
      x1:Number(point[0]), y1:Number(point[1]), x2:Number(next[0]), y2:Number(next[1]),
      orientation:vertical ? 'vertical' : 'horizontal',
    };
  });
}

function pointOnSegment(value, start, end) {
  return value >= Math.min(start,end)-.001 && value <= Math.max(start,end)+.001;
}

function sameCanvasPoint(a, b) {
  return Math.abs(Number(a?.x)-Number(b?.x)) < .001 && Math.abs(Number(a?.y)-Number(b?.y)) < .001;
}

function sharedBoundPinAtPoint(firstWire, secondWire, point) {
  const bindings = (wireItem) => {
    const points = resolveEditorWirePoints(wireItem,state.editor.components);
    return [
      {componentId:wireItem.from,pinId:wireItem.fromPin,x:points[0]?.[0],y:points[0]?.[1]},
      {componentId:wireItem.to,pinId:wireItem.toPin,x:points.at(-1)?.[0],y:points.at(-1)?.[1]},
    ];
  };
  return bindings(firstWire).some((first) => bindings(secondWire).some((second) =>
    first.componentId && first.componentId===second.componentId && first.pinId && first.pinId===second.pinId
      && sameCanvasPoint(first,point) && sameCanvasPoint(second,point)));
}

function detectWirePairCrossings(newWire, existingWire) {
  const found = [];
  for (const fresh of editorWireSegments(newWire)) {
    for (const existing of editorWireSegments(existingWire)) {
      let crossing = null;
      if (fresh.orientation !== existing.orientation) {
        const vertical = fresh.orientation === 'vertical' ? fresh : existing;
        const horizontal = fresh.orientation === 'horizontal' ? fresh : existing;
        const x=vertical.x1, y=horizontal.y1;
        if (pointOnSegment(x,horizontal.x1,horizontal.x2) && pointOnSegment(y,vertical.y1,vertical.y2)) {
          crossing={x,y,kind:'crossing'};
        }
      } else if (fresh.orientation === 'horizontal' && Math.abs(fresh.y1-existing.y1)<.001) {
        const low=Math.max(Math.min(fresh.x1,fresh.x2),Math.min(existing.x1,existing.x2));
        const high=Math.min(Math.max(fresh.x1,fresh.x2),Math.max(existing.x1,existing.x2));
        if (high>=low-.001) crossing={x:(low+high)/2,y:fresh.y1,kind:high-low>1?'overlap':'touch'};
      } else if (fresh.orientation === 'vertical' && Math.abs(fresh.x1-existing.x1)<.001) {
        const low=Math.max(Math.min(fresh.y1,fresh.y2),Math.min(existing.y1,existing.y2));
        const high=Math.min(Math.max(fresh.y1,fresh.y2),Math.max(existing.y1,existing.y2));
        if (high>=low-.001) crossing={x:fresh.x1,y:(low+high)/2,kind:high-low>1?'overlap':'touch'};
      }
      if (!crossing || sharedBoundPinAtPoint(newWire,existingWire,crossing)) continue;
      const key=`${Math.round(crossing.x*100)/100},${Math.round(crossing.y*100)/100},${crossing.kind}`;
      if (found.some((item)=>item.key===key)) continue;
      found.push({
        ...crossing,
        key,
        with:existingWire.id,
        orientation:fresh.orientation,
        existingOrientation:existing.orientation,
      });
    }
  }
  return found.map(({key,...item})=>item);
}

function findWireCrossings(wireItem) {
  return state.editor.wires
    .filter((existing)=>existing.id!==wireItem.id)
    .flatMap((existing)=>detectWirePairCrossings(wireItem,existing));
}

function resolveStoredCrossing(wireItem, crossing) {
  const existing = state.editor.wires.find((item)=>item.id===crossing.with);
  if (!existing) return null;
  const candidates=detectWirePairCrossings(wireItem,existing);
  if (!candidates.length) return null;
  return candidates.reduce((best,item)=>{
    const distance=Math.hypot(item.x-Number(crossing.x),item.y-Number(crossing.y));
    return !best||distance<best.distance?{...item,distance}:best;
  },null);
}

function wireCrossingMarkerMarkup() {
  const seen = new Set();
  return state.editor.wires.flatMap((wireItem)=>(wireItem.crossings||[]).map((stored)=>{
    const crossing=resolveStoredCrossing(wireItem,stored);
    if (!crossing) return '';
    const key=`${wireItem.id}:${stored.with}:${crossing.x}:${crossing.y}:${Boolean(stored.connected)}`;
    if (seen.has(key)) return '';
    seen.add(key);
    const {x,y,orientation,existingOrientation}=crossing;
    if (stored.connected) return `<circle class="editor-junction" cx="${x}" cy="${y}" r="5"/>`;
    if (crossing.kind!=='crossing') return `<g class="wire-no-junction"><circle class="wire-no-junction-ring" cx="${x}" cy="${y}" r="7"/><path class="wire-no-junction-mark" d="M${x-3} ${y-3}L${x+3} ${y+3}M${x+3} ${y-3}L${x-3} ${y+3}"/></g>`;
    const under = existingOrientation==='vertical' ? `M${x} ${y-10}V${y+10}` : `M${x-10} ${y}H${x+10}`;
    const bridge = orientation==='vertical'
      ? `M${x} ${y-9}Q${x+10} ${y} ${x} ${y+9}`
      : `M${x-9} ${y}Q${x} ${y-10} ${x+9} ${y}`;
    return `<g class="wire-no-junction"><circle class="wire-crossing-mask" cx="${x}" cy="${y}" r="10"/><path class="wire-crossing-under" d="${under}"/><path class="wire-crossing-bridge" d="${bridge}"/></g>`;
  })).join('');
}

function showPendingCrossingDialog() {
  const pending=state.editor.pendingCrossings[0];
  const dialog=$('#wire-crossing-dialog');
  if (!pending||!dialog) return;
  const current=state.editor.pendingCrossingTotal-state.editor.pendingCrossings.length+1;
  const existing=state.editor.wires.find((item)=>item.id===pending.crossing.with);
  const typeLabel=pending.crossing.kind==='overlap'?'重叠':'相交';
  $('#wire-crossing-progress').textContent=`交点 ${current} / ${state.editor.pendingCrossingTotal}`;
  $('#wire-crossing-detail').textContent=`新导线与${existing?.net?`网络 ${existing.net}`:'已有导线'}在 X ${Math.round(pending.crossing.x)}、Y ${Math.round(pending.crossing.y)} ${typeLabel}。请选择这里是否属于同一电气网络。`;
  if (!dialog.open) dialog.showModal();
}

function queueWireCrossingDecisions(wireItem, crossings) {
  if (!crossings.length) return;
  state.editor.pendingCrossings=crossings.map((crossing)=>({wireId:wireItem.id,crossing}));
  state.editor.pendingCrossingTotal=crossings.length;
  requestAnimationFrame(showPendingCrossingDialog);
}

function resolvePendingWireCrossing(connected) {
  const pending=state.editor.pendingCrossings.shift();
  if (!pending) return;
  const wireItem=state.editor.wires.find((item)=>item.id===pending.wireId);
  // 导线可能在等待答复期间被删除；此时不应产生一次“无变化”的撤销历史。
  if (wireItem) {
    pushEditorHistory();
    wireItem.crossings=wireItem.crossings||[];
    wireItem.crossings.push({...pending.crossing,connected:Boolean(connected)});
  }
  renderEditor();
  if (state.editor.pendingCrossings.length) showPendingCrossingDialog();
  else {
    $('#wire-crossing-dialog')?.close();
    state.editor.pendingCrossingTotal=0;
    if (wireItem) toast(connected?'已添加电气结点。':'已标记为跨线不连接。');
  }
}

function projectForAnalysis() {
  return { components: state.editor.components, wires: state.editor.wires };
}

function renderProjectChecks() {
  const analysis = optimizeCircuit(projectForAnalysis(), []);
  const connectivity = auditEditorConnectivity(state.editor);
  const passes = [];
  if (state.editor.components.length) passes.push({ title: '项目结构', detail: `${state.editor.components.length} 个元件已进入画布。` });
  if (state.editor.wires.length && connectivity.continuous) passes.push({ title: '端点连通', detail: `${state.editor.wires.length} 条连线连续，未发现悬空端点。` });
  const connectivityWarning = state.editor.wires.length && !connectivity.continuous
    ? `<div class="mini-audit-item warn"><i>${iconMarkup('alert')}</i><div><b>发现断线</b><span>${connectivity.danglingEndpoints} 处端点或线段未闭合，请重新连接到可见引脚。</span></div></div>`
    : '';
  $('#project-checks').innerHTML = `
    <div class="audit-score"><div class="score-ring">${analysis.score}</div><div><b>${esc(analysis.grade)}</b><span>实时结构检查</span></div></div>
    <div class="mini-audit">${passes.map((item) => `<div class="mini-audit-item pass"><i>${iconMarkup('check')}</i><div><b>${esc(item.title)}</b><span>${esc(item.detail)}</span></div></div>`).join('')}${connectivityWarning}${analysis.recommendations.slice(0,8).map((item) => `<div class="mini-audit-item warn"><i>${iconMarkup('alert')}</i><div><b>${esc(item.title)}</b><span>${esc(item.detail)}</span></div></div>`).join('')}</div>
    <button class="secondary-button full-width" id="open-full-optimizer">打开完整优化报告</button>`;
  $('#open-full-optimizer')?.addEventListener('click', () => navigate('optimizer'));
}

function renderPropertyEditor() {
  const target = $('#property-editor');
  if (!state.editor.selected) {
    target.innerHTML = `<div class="no-selection"><span>${iconMarkup('cursor')}</span><h3>未选择对象</h3><p>点击画布中的元件以编辑位号、参数和说明。</p></div>`;
    return;
  }
  if (state.editor.selectedKind === 'wire') {
    const wire = state.editor.wires.find((item) => item.id === state.editor.selected);
    target.innerHTML = wire ? `<div class="selected-summary"><span>${iconMarkup('wire')}</span><div><b>连接线</b><small>${esc(wire.from || '自由线')} → ${esc(wire.to || '自由线')}</small></div></div><div class="property-form"><label><span>网络名</span><input id="prop-net" value="${esc(wire.net || '')}" placeholder="例如 VCC、GND、SCL"></label><div class="property-actions"><button class="primary-button compact" id="apply-wire">应用</button><button class="secondary-button" id="remove-selected-wire">删除</button></div></div>` : '';
    $('#apply-wire')?.addEventListener('click', () => { pushEditorHistory(); wire.net = $('#prop-net').value.trim().slice(0,40); markEditorDirty(); renderEditor(); });
    $('#remove-selected-wire')?.addEventListener('click', deleteEditorSelection);
    return;
  }
  const item = componentById(state.editor.selected);
  if (!item) { state.editor.selected = null; renderPropertyEditor(); return; }
  const definition = COMPONENT_LIBRARY.find((entry) => entry.type === item.type);
  const QUICK_VALUES = {
    resistor: ['100Ω','1kΩ','4.7kΩ','10kΩ','47kΩ','100kΩ'],
    potentiometer: ['1kΩ','10kΩ','50kΩ','100kΩ'],
    capacitor: ['22pF','100nF','1µF','10µF'],
    electrolytic: ['10µF/25V','47µF/25V','100µF/25V','470µF/25V'],
    tantalum: ['1µF/16V','10µF/16V','22µF/10V'],
    inductor: ['4.7µH','10µH','22µH','100µH'],
    'ferrite-bead': ['120Ω@100MHz','600Ω@100MHz'],
    crystal: ['8 MHz','16 MHz','32.768 kHz'],
  };
  const quickValues = QUICK_VALUES[item.type];
  target.innerHTML = `<div class="selected-summary"><span class="summary-symbol">${definition ? componentIconSvg(definition) : esc(item.type)}</span><div><b>${esc(definition?.name || item.type)}</b><small>${esc(item.id)}</small></div></div><div class="property-form">
    <label><span>位号</span><input id="prop-ref" value="${esc(item.ref)}"></label>
    <label><span>参数 / 型号</span><input id="prop-value" value="${esc(item.value)}"></label>
    ${quickValues ? `<div class="quick-value-row" id="quick-values">${quickValues.map((value) => `<button type="button" data-quick-value="${esc(value)}">${esc(value)}</button>`).join('')}</div>` : ''}
    <label><span>封装建议</span><input id="prop-footprint" value="${esc(item.footprint || '')}" placeholder="例如 R_0603_1608Metric"></label>
    <label><span>工程说明</span><textarea id="prop-description">${esc(item.description || '')}</textarea></label>
    <div class="property-actions"><button class="primary-button compact" id="apply-property">应用修改</button><button class="secondary-button" id="remove-selected-component">删除</button></div>
  </div>`;
  $('#apply-property').addEventListener('click', () => {
    pushEditorHistory();
    item.ref = $('#prop-ref').value.trim().slice(0,20) || item.ref;
    item.value = $('#prop-value').value.trim().slice(0,80);
    item.footprint = $('#prop-footprint').value.trim().slice(0,120);
    item.description = $('#prop-description').value.trim().slice(0,400);
    markEditorDirty(); renderEditor();
  });
  if (quickValues) {
    $('#quick-values')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-quick-value]');
      if (!chip) return;
      pushEditorHistory();
      item.value = chip.dataset.quickValue;
      markEditorDirty(); renderEditor();
    });
  }
  $('#remove-selected-component').addEventListener('click', deleteEditorSelection);
}

function pointDistanceToWireSegment(point, start, end) {
  const dx=end[0]-start[0];
  const dy=end[1]-start[1];
  if (!dx&&!dy) return Math.hypot(point.x-start[0],point.y-start[1]);
  const ratio=Math.max(0,Math.min(1,((point.x-start[0])*dx+(point.y-start[1])*dy)/(dx*dx+dy*dy)));
  return Math.hypot(point.x-(start[0]+ratio*dx),point.y-(start[1]+ratio*dy));
}

function editableWireSegments(wireItem) {
  const points=resolveEditorWirePoints(wireItem,state.editor.components);
  return points.slice(0,-1).map((start,index)=>{
    const end=points[index+1];
    const orientation=start[0]===end[0]?'vertical':start[1]===end[1]?'horizontal':'';
    return {index,start,end,orientation};
  }).filter((segment)=>segment.orientation);
}

function wireSegmentHandleMarkup() {
  if (state.editor.tool!=='select'||state.editor.selectedKind!=='wire') return '';
  const wireItem=state.editor.wires.find((item)=>item.id===state.editor.selected);
  if (!wireItem) return '';
  return editableWireSegments(wireItem).map((segment)=>{
    const x=(segment.start[0]+segment.end[0])/2;
    const y=(segment.start[1]+segment.end[1])/2;
    return `<g class="editor-wire-segment-handle ${segment.orientation}" data-wire-id="${esc(wireItem.id)}" data-segment-index="${segment.index}" transform="translate(${x} ${y})"><title>拖动调整线段位置</title><circle r="8"/><path d="M-3 0H3M0-3V3"/></g>`;
  }).join('');
}

function closestEditableWireSegment(wireItem,point) {
  return editableWireSegments(wireItem).reduce((best,segment)=>{
    const distance=pointDistanceToWireSegment(point,segment.start,segment.end);
    return !best||distance<best.distance?{...segment,distance}:best;
  },null);
}

function beginWireSegmentEdit(wireId,segmentIndex,event) {
  const wireItem=state.editor.wires.find((item)=>item.id===wireId);
  const route=wireItem&&resolveEditorWirePoints(wireItem,state.editor.components);
  const segment=route&&route[segmentIndex]&&route[segmentIndex+1]
    ? {start:route[segmentIndex],end:route[segmentIndex+1]}
    : null;
  const orientation=segment&&(segment.start[0]===segment.end[0]?'vertical':segment.start[1]===segment.end[1]?'horizontal':'');
  if (!wireItem||!orientation||segmentIndex<0||segmentIndex>=route.length-1) return false;
  state.editor.wireEdit={
    wireId,
    segmentIndex,
    orientation,
    pointerId:event.pointerId,
    startClientX:event.clientX,
    startClientY:event.clientY,
    route:structuredClone(route),
    originalStoredPoints:Array.isArray(wireItem.points)?structuredClone(wireItem.points):null,
    futureBefore:structuredClone(state.editor.future),
    moved:false,
  };
  $('#editor-canvas').classList.add('is-wire-editing');
  return true;
}

function updateWireSegmentEdit(event) {
  const edit=state.editor.wireEdit;
  if (!edit||edit.pointerId!==event.pointerId) return false;
  const distance=Math.hypot(event.clientX-edit.startClientX,event.clientY-edit.startClientY);
  if (!edit.moved&&distance<3) return true;
  const wireItem=state.editor.wires.find((item)=>item.id===edit.wireId);
  if (!wireItem) return true;
  if (!edit.moved) {
    pushEditorHistory();
    edit.moved=true;
  }
  const point=canvasPoint(event);
  const original=structuredClone(edit.route);
  const snapped=edit.orientation==='vertical'
    ? Math.round(point.x/10)*10
    : Math.round(point.y/10)*10;
  let points;
  if (edit.segmentIndex===0) {
    const start=original[0],end=original[1];
    const first=edit.orientation==='vertical'?[snapped,start[1]]:[start[0],snapped];
    const second=edit.orientation==='vertical'?[snapped,end[1]]:[end[0],snapped];
    points=[start,first,second,...original.slice(1)];
  } else if (edit.segmentIndex===original.length-2) {
    const start=original.at(-2),end=original.at(-1);
    const first=edit.orientation==='vertical'?[snapped,start[1]]:[start[0],snapped];
    const second=edit.orientation==='vertical'?[snapped,end[1]]:[end[0],snapped];
    points=[...original.slice(0,-1),first,second,end];
  } else {
    points=original;
    if (edit.orientation==='vertical') {
      points[edit.segmentIndex][0]=snapped;
      points[edit.segmentIndex+1][0]=snapped;
    } else {
      points[edit.segmentIndex][1]=snapped;
      points[edit.segmentIndex+1][1]=snapped;
    }
  }
  wireItem.points=points;
  renderEditor();
  $('#grid-status').textContent=`调整导线中 · 线段吸附到 ${Math.round(snapped)}`;
  return true;
}

function renderEditor() { console.log("TR:renderEditor enter");
  const wireMarkup = state.editor.wires.map((item) => {
    const label = wireLabelPosition(item);
    const path = wirePath(item);
    const binding = `data-from-component="${esc(item.from || '')}" data-from-pin="${esc(item.fromPin || '')}" data-to-component="${esc(item.to || '')}" data-to-pin="${esc(item.toPin || '')}"`;
    return `<polyline class="editor-wire-hit" data-id="${esc(item.id)}" ${binding} points="${path}"/><polyline class="editor-wire${state.editor.selectedKind === 'wire' && state.editor.selected === item.id ? ' selected' : ''}" data-id="${esc(item.id)}" ${binding} points="${path}"/><text class="editor-wire-label" data-wire-label-id="${esc(item.id)}" x="${label.x}" y="${label.y}">${esc(item.net || '')}</text>`;
  }).join('');
  $('#editor-wire-layer').innerHTML = wireMarkup;
  $('#editor-crossing-layer').innerHTML = wireCrossingMarkerMarkup();
  $('#editor-component-layer').innerHTML = state.editor.components.map(editorSymbol).join('');
  const startDetails = wireStartDetails();
  const start = componentById(startDetails?.componentId);
  const startPin = start && componentTerminalPoints(start).find((pin) => pin.id === startDetails?.pinId);
  const wireToolActive = state.editor.tool === 'wire';
  const pins = state.editor.components.flatMap((component) => componentTerminalPoints(component).map((pin) => {
      const active = component.id === startDetails?.componentId && pin.id === startDetails?.pinId;
      const target = component.id === state.editor.wireHover?.componentId && pin.id === state.editor.wireHover?.pinId;
      const label = `${component.ref || component.type} · 引脚 ${pin.id}`;
      return `<g class="editor-pin-control${wireToolActive ? ' wire-enabled' : ''}" data-component-id="${esc(component.id)}" data-pin-id="${esc(pin.id)}" aria-label="${esc(label)}"><circle class="editor-pin-hit" cx="${pin.x}" cy="${pin.y}" r="14"/><circle class="editor-pin${active ? ' active' : ''}${target ? ' target' : ''}" data-component-id="${esc(component.id)}" data-pin-id="${esc(pin.id)}" cx="${pin.x}" cy="${pin.y}" r="5"/></g>`;
    })).join('');
  const origin = start && !startPin ? `<circle class="editor-wire-origin" cx="${start.x}" cy="${start.y}" r="17"/>` : '';
  const wireHandles=wireSegmentHandleMarkup();
  const draftPoints=state.editor.wireDraft?.points||[];
  const draftPreview=draftPoints.length>1
    ? `<polyline class="wire-preview" points="${draftPoints.map((point)=>point.join(',')).join(' ')}"/><circle class="wire-preview-end" cx="${draftPoints.at(-1)[0]}" cy="${draftPoints.at(-1)[1]}" r="7"/>`
    : '';
  $('#editor-overlay-layer').innerHTML = `${pins}${wireHandles}${draftPreview}${origin}${startPin ? `<circle class="editor-pin-start" cx="${startPin.x}" cy="${startPin.y}" r="10"/>` : ''}`;
  const wireHint = $('#wire-mode-hint');
  wireHint.classList.toggle('wire-active', wireToolActive);
  wireHint.classList.toggle('has-start', Boolean(start));
  if (!wireToolActive&&state.editor.selectedKind==='wire') {
    $('#wire-hint-step').textContent = '导线编辑';
    $('#wire-hint-title').textContent = '调整线路';
    $('#wire-hint-text').textContent = '拖动导线中间的绿色控制点调整线段位置；线段会吸附网格，器件端点保持固定。';
    $('#wire-hint-shortcuts').textContent = 'Delete 删除 · Esc 取消拖动';
  } else if (!wireToolActive) {
    $('#wire-hint-step').textContent = '操作提示';
    $('#wire-hint-title').textContent = '怎样连线';
    $('#wire-hint-text').textContent = '点“连线” → 点第一个元件的绿色标记点 → 沿虚线移动 → 点另一个元件的标记点。';
    $('#wire-hint-shortcuts').textContent = 'W 连线 · V 选择 · Esc 取消';
  } else if (start) {
    $('#wire-hint-step').textContent = '第 2 步';
    $('#wire-hint-title').textContent = '选择终点';
    $('#wire-hint-text').textContent = '线头跟随鼠标；靠近绿色端点会自动吸附并补齐最后转角，点击或松开完成连接。';
    $('#wire-hint-shortcuts').textContent = '空格切换先横/先竖 · Esc 取消';
  } else {
    $('#wire-hint-step').textContent = '第 1 步';
    $('#wire-hint-title').textContent = state.editor.components.length < 2 ? '先放入两个元件' : '选择起点';
    $('#wire-hint-text').textContent = state.editor.components.length < 2
      ? '从左侧物品栏拖入至少两个元件，再点击第一个元件的绿色标记点。'
      : '点击第一个元件的绿色标记点开始，再连接到另一个元件；同一元件不能自连。';
    $('#wire-hint-shortcuts').textContent = '端点附近可吸附 · 单击或拖拽';
  }
  if (state.editor.tool === 'wire') $('#grid-status').textContent = start ? '起点已选 · 线头跟随鼠标，靠近端点自动吸附' : '连线 · 端点附近自动吸附';
  else if (state.editor.selectedKind==='wire') $('#grid-status').textContent='导线已选 · 拖动绿色控制点调整中间线段';
  $('#canvas-empty').classList.toggle('hidden', state.editor.components.length > 0);
  const connectivity = auditEditorConnectivity(state.editor);
  $('#canvas-count').textContent = `${state.editor.components.length} 个元件 · ${state.editor.wires.length} 条连线${state.editor.wires.length ? ` · ${connectivity.continuous ? '连通 ✓' : `${connectivity.danglingEndpoints} 处断开`}` : ''}`;
  syncEditorViewport();
  $('#studio-zoom-label').textContent = `${Math.round(state.editor.zoom*100)}%`;
  renderPropertyEditor();
  renderProjectChecks();
  $('#opt-project-meta').textContent = `${state.editor.components.length} 个元件 · ${state.editor.wires.length} 条连线`;
}

function syncEditorViewport() {
  const canvas = $('#editor-canvas');
  const view = state.editor.viewBox;
  canvas.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  const overscan = { x: view.x - view.w, y: view.y - view.h, w: view.w * 3, h: view.h * 3 };
  for (const id of ['editor-canvas-background','editor-grid-background']) {
    const background = $(`#${id}`);
    if (!background) continue;
    background.setAttribute('x', overscan.x);
    background.setAttribute('y', overscan.y);
    background.setAttribute('width', overscan.w);
    background.setAttribute('height', overscan.h);
  }
  $('#studio-zoom-label').textContent = `${Math.round(state.editor.zoom*100)}%`;
}

function editorContentBounds(padding = 90) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const include=(x,y)=>{
    x=Number(x);y=Number(y);
    if (!Number.isFinite(x)||!Number.isFinite(y)) return;
    minX=Math.min(minX,x);minY=Math.min(minY,y);
    maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
  };
  state.editor.components.forEach((item)=>{
    include(Number(item.x)-55,Number(item.y)-45);
    include(Number(item.x)+55,Number(item.y)+45);
  });
  state.editor.wires.forEach((wireItem)=>resolveEditorWirePoints(wireItem,state.editor.components).forEach((point)=>include(point[0],point[1])));
  if (![minX,minY,maxX,maxY].every(Number.isFinite)) return { x:0, y:0, w:EDITOR_BASE_VIEW.w, h:EDITOR_BASE_VIEW.h };
  minX-=padding;maxX+=padding;minY-=padding;maxY+=padding;
  return { x:minX, y:minY, w:Math.max(200,maxX-minX), h:Math.max(160,maxY-minY) };
}

function normalizedEditorViewport(viewport) {
  const zoom = Math.max(EDITOR_MIN_ZOOM,Math.min(EDITOR_MAX_ZOOM,Number(viewport?.zoom)||1));
  const fallbackW=EDITOR_BASE_VIEW.w/zoom, fallbackH=EDITOR_BASE_VIEW.h/zoom;
  return {
    zoom,
    viewBox:{
      x:Number.isFinite(Number(viewport?.viewBox?.x))?Number(viewport.viewBox.x):0,
      y:Number.isFinite(Number(viewport?.viewBox?.y))?Number(viewport.viewBox.y):0,
      w:Number.isFinite(Number(viewport?.viewBox?.w))&&Number(viewport.viewBox.w)>0?Number(viewport.viewBox.w):fallbackW,
      h:Number.isFinite(Number(viewport?.viewBox?.h))&&Number(viewport.viewBox.h)>0?Number(viewport.viewBox.h):fallbackH,
    },
  };
}

function canvasPoint(event) {
  const svg = $('#editor-canvas');
  const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
  const result = point.matrixTransform(svg.getScreenCTM().inverse());
  return { x: result.x, y: result.y };
}

function editorComponentNode(id) {
  return $$('.editor-component').find((node) => node.dataset.id === id);
}

function refreshConnectedWireNodes(componentId) {
  state.editor.wires.forEach((wireItem) => {
    if (wireItem.from !== componentId && wireItem.to !== componentId) return;
    const wireNode = $$('.editor-wire').find((node) => node.dataset.id === wireItem.id);
    const hitNode = $$('.editor-wire-hit').find((node) => node.dataset.id === wireItem.id);
    const path = wirePath(wireItem);
    if (wireNode) wireNode.setAttribute('points', path);
    if (hitNode) hitNode.setAttribute('points', path);
    const labelNode = $$('.editor-wire-label').find((node) => node.dataset.wireLabelId === wireItem.id);
    if (labelNode) {
      const label = wireLabelPosition(wireItem);
      labelNode.setAttribute('x', label.x);
      labelNode.setAttribute('y', label.y);
    }
  });
}

function updateEditorDragPreview(item, position) {
  const node = editorComponentNode(item.id);
  if (node) {
    node.setAttribute('transform', `translate(${position.x} ${position.y}) rotate(${Number(item.rotate) || 0})`);
    node.classList.add('dragging');
  }
  refreshConnectedWireNodes(item.id);
  // 结点/跨线标记跟随拖动实时重算；没有记录过交点时跳过，避免大图拖动时的 O(wires²) 开销。
  if (state.editor.wires.some((wireItem) => wireItem.crossings?.length)) {
    $('#editor-crossing-layer').innerHTML = wireCrossingMarkerMarkup();
  }
  componentTerminalPoints(item).forEach((pin) => {
    const control = $(`.editor-pin-control[data-component-id="${CSS.escape(item.id)}"][data-pin-id="${CSS.escape(pin.id)}"]`);
    control?.querySelectorAll('circle').forEach((circle) => {
      circle.setAttribute('cx', pin.x);
      circle.setAttribute('cy', pin.y);
    });
  });
  const { x, y, snappedX, snappedY } = position;
  const view = state.editor.viewBox;
  const labelX = Math.min(view.x + view.w - 112, Math.max(view.x + 8, x + 14));
  const labelY = Math.min(view.y + view.h - 28, Math.max(view.y + 24, y - 14));
  $('#editor-overlay-layer').innerHTML = `
    <path class="drag-guide" d="M${view.x} ${snappedY}H${view.x + view.w}M${snappedX} ${view.y}V${view.y + view.h}"/>
    <circle class="drag-snap-point" cx="${snappedX}" cy="${snappedY}" r="5"/>
    <g class="drag-coordinate" transform="translate(${labelX} ${labelY})"><rect width="104" height="22" rx="5"/><text x="52" y="15" text-anchor="middle">X ${Math.round(snappedX)} · Y ${Math.round(snappedY)}</text></g>`;
  $('#canvas-coordinates').textContent = `X ${Math.round(x)} · Y ${Math.round(y)}`;
  $('#grid-status').textContent = `移动中 · 松开吸附到 ${Math.round(snappedX)}, ${Math.round(snappedY)}`;
}

function clearEditorPointerVisuals() {
  const canvas = $('#editor-canvas');
  canvas.classList.remove('is-dragging', 'is-panning');
  editorComponentNode(state.editor.drag?.id)?.classList.remove('dragging');
  $('#editor-overlay-layer').innerHTML = '';
  $('#grid-status').textContent = '无限网格 · 滚轮移动视角';
}

function setEditorTool(tool) {
  const changed = state.editor.tool !== tool;
  state.editor.tool = tool;
  state.editor.wireStart = null;
  state.editor.wireDraft = null;
  state.editor.wireDrag = null;
  state.editor.wireHover = null;
  state.editor.wireEdit = null;
  $('#editor-canvas').classList.remove('is-wire-dragging','is-wire-editing');
  $$('.canvas-tool').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  // 只替换工具类名，避免整类覆盖清掉 is-panning / space-pan-ready 等状态类。
  for (const active of ['select', 'wire', 'pan']) $('#editor-canvas').classList.toggle(`tool-${active}`, active === tool);
  renderEditor();
  if (changed && tool === 'wire') toast('已进入连线模式：依次点击两个不同元件的绿色标记点。');
}

function rotateEditorSelection() {
  if (state.editor.selectedKind !== 'component') return;
  const item = componentById(state.editor.selected); if (!item) return;
  pushEditorHistory(); item.rotate = ((Number(item.rotate)||0)+90)%360; markEditorDirty(); renderEditor();
}

function deleteEditorSelection() {
  if (!state.editor.selected) return;
  pushEditorHistory();
  if (state.editor.selectedKind === 'component') {
    const id = state.editor.selected;
    state.editor.components = state.editor.components.filter((item) => item.id !== id);
    state.editor.wires = state.editor.wires.filter((item) => item.from !== id && item.to !== id);
  } else state.editor.wires = state.editor.wires.filter((item) => item.id !== state.editor.selected);
  const remainingWireIds=new Set(state.editor.wires.map((item)=>item.id));
  state.editor.wires.forEach((item)=>{item.crossings=(item.crossings||[]).filter((crossing)=>remainingWireIds.has(crossing.with));});
  state.editor.selected = null; state.editor.selectedKind = ''; state.editor.wireStart = null; state.editor.wireDraft = null; state.editor.wireEdit = null;
  markEditorDirty(); renderEditor();
}

function setStudioZoom(nextZoom, anchor = null) {
  const view=state.editor.viewBox;
  const next=Math.max(EDITOR_MIN_ZOOM,Math.min(EDITOR_MAX_ZOOM,Number(nextZoom)||1));
  const focus=anchor||{x:view.x+view.w/2,y:view.y+view.h/2};
  const ratioX=(focus.x-view.x)/view.w;
  const ratioY=(focus.y-view.y)/view.h;
  const w=EDITOR_BASE_VIEW.w/next, h=EDITOR_BASE_VIEW.h/next;
  state.editor.zoom=next;
  state.editor.viewBox={x:focus.x-ratioX*w,y:focus.y-ratioY*h,w,h};
  syncEditorViewport();
}

function updateStudioZoom(delta) {
  setStudioZoom(state.editor.zoom+delta);
}

function fitStudioCanvas() {
  if (!state.editor.components.length&&!state.editor.wires.length) {
    state.editor.zoom=1;
    state.editor.viewBox={x:0,y:0,w:EDITOR_BASE_VIEW.w,h:EDITOR_BASE_VIEW.h};
    syncEditorViewport();
    return;
  }
  const bounds=editorContentBounds();
  const zoom=Math.max(EDITOR_MIN_ZOOM,Math.min(EDITOR_MAX_ZOOM,Math.min(EDITOR_BASE_VIEW.w/bounds.w,EDITOR_BASE_VIEW.h/bounds.h)));
  const w=EDITOR_BASE_VIEW.w/zoom, h=EDITOR_BASE_VIEW.h/zoom;
  state.editor.zoom=zoom;
  state.editor.viewBox={x:bounds.x+bounds.w/2-w/2,y:bounds.y+bounds.h/2-h/2,w,h};
  syncEditorViewport();
}

function blankProject(force = false) {
  if (!force && state.editor.dirty && !window.confirm('当前项目有未保存更改，仍要新建吗？')) return;
  Object.assign(state.editor, { id:'', name:'未命名电路', createdAt:'', components:[], wires:[], selected:null, selectedKind:'', zoom:1, viewBox:{x:0,y:0,w:EDITOR_BASE_VIEW.w,h:EDITOR_BASE_VIEW.h}, history:[], future:[], dirty:false, wireStart:null, wireDraft:null, wireDrag:null, wireHover:null, wireEdit:null, drag:null, pan:null, spacePressed:false, pendingCrossings:[], pendingCrossingTotal:0 });
  clearPendingCrossings();
  $('#project-name').value = state.editor.name;
  $('#project-save-state').textContent = '尚未保存'; $('#project-save-state').classList.remove('saved');
  renderEditor();
}

async function saveCurrentProject() {
  const button = $('#save-project'); setBusy(button,true);
  try {
    state.editor.name = $('#project-name').value.trim() || '未命名电路';
    const saved = await desktop.saveProject({ id: state.editor.id, name: state.editor.name, createdAt: state.editor.createdAt, components: state.editor.components, wires: state.editor.wires, viewport:{zoom:state.editor.zoom,viewBox:{...state.editor.viewBox}} });
    state.editor.id = saved.id; state.editor.createdAt = saved.createdAt; state.editor.dirty = false;
    $('#project-save-state').textContent = '已保存到本机'; $('#project-save-state').classList.add('saved');
    state.projects = await desktop.listProjects(); renderProjectInventory(); toast('项目已保存到本机工作空间。');
  } finally { setBusy(button,false); }
}

function loadProject(project) {
  if (state.editor.dirty && !window.confirm('当前项目有未保存更改，仍要打开其他项目吗？')) return;
  const components = structuredClone(project.components || []);
  const originalWires = structuredClone(project.wires || []);
  const wires = normalizeEditorWireEndpoints(originalWires, components);
  const migrated = JSON.stringify(wires) !== JSON.stringify(originalWires);
  const viewport=normalizedEditorViewport(project.viewport);
  Object.assign(state.editor, { id:project.id, name:project.name, createdAt:project.createdAt, components, wires, selected:null, selectedKind:'', zoom:viewport.zoom, viewBox:viewport.viewBox, history:[], future:[], dirty:migrated, wireStart:null, wireDraft:null, wireDrag:null, wireHover:null, wireEdit:null, drag:null, pan:null, spacePressed:false, pendingCrossings:[], pendingCrossingTotal:0 });
  clearPendingCrossings();
  $('#project-name').value = project.name;
  $('#project-save-state').textContent = migrated ? '旧端点已迁移 · 待保存' : '已保存到本机';
  $('#project-save-state').classList.toggle('saved', !migrated);
  renderEditor(); navigate('studio');
  if (migrated) toast('旧项目的外壳锚点已迁移到真实引脚，请保存项目。');
}

function renderProjectInventory() {
  $('#inventory-projects').innerHTML = state.projects.length ? `<div class="project-list">${state.projects.map((project) => `<article class="project-list-item" data-project-id="${esc(project.id)}"><b>${esc(project.name)}</b><small>${(project.components||[]).length} 个元件 · ${new Date(project.updatedAt).toLocaleString('zh-CN')}</small><button data-delete-project="${esc(project.id)}" title="删除项目">${iconMarkup('x')}</button></article>`).join('')}</div>` : `<div class="no-selection"><span>${iconMarkup('book')}</span><h3>还没有保存项目</h3><p>保存后会出现在这个可收纳项目栏中。</p></div>`;
}

function renderComponentInventory() {
  const query = $('#component-search')?.value.trim().toLowerCase() || '';
  const filtered = COMPONENT_LIBRARY.filter((item) => `${item.name} ${item.type} ${item.value} ${item.icon || ''} ${item.description || ''} ${(item.aliases || []).join(' ')}`.toLowerCase().includes(query));
  const groups = [...new Set(filtered.map((item) => item.category))];
  $('#inventory-components').innerHTML = groups.map((group) => `<section class="inventory-group"><h3>${esc(group)}</h3><div class="component-shelf">${filtered.filter((item) => item.category===group).map((item) => `<button type="button" class="shelf-item" draggable="true" data-component-type="${esc(item.type)}" title="点击添加到视图中央，或拖动到指定位置：${esc(item.description)}" aria-label="添加${esc(item.name)}"><span class="shelf-symbol">${componentIconSvg(item)}</span><b>${esc(item.name)}</b><small>${esc(item.value)}</small></button>`).join('')}</div></section>`).join('') || `<div class="no-selection"><span>${iconMarkup('search')}</span><h3>没有匹配的元件</h3><p>换个关键词，或到“市场元件”页签搜索具体型号。</p></div>`;
  // 限定在元件页签内绑定，避免误选市场元件卡片造成重复事件。
  $$('#inventory-components .shelf-item').forEach((item) => {
    let dragging = false;
    item.addEventListener('dragstart', (event) => {
      dragging = true;
      event.dataTransfer.setData('application/x-circuit-component', item.dataset.componentType);
      event.dataTransfer.effectAllowed='copy';
    });
    item.addEventListener('dragend', () => setTimeout(() => { dragging = false; }, 0));
    item.addEventListener('click', () => {
      if (dragging) return;
      addEditorComponent(item.dataset.componentType, state.editor.viewBox.x + state.editor.viewBox.w / 2, state.editor.viewBox.y + state.editor.viewBox.h / 2);
    });
  });
}

let marketGroup = '全部';
const MARKET_GROUPS = ['全部', ...new Set(MARKET_PARTS_LIBRARY.map((part) => part.group))];

function marketPartById(id) {
  return MARKET_PARTS_LIBRARY.find((part) => part.id === id);
}

function placeMarketPart(part, x, y) {
  const definition = COMPONENT_LIBRARY.find((item) => item.type === part.symbolType) || COMPONENT_LIBRARY.find((item) => item.type === 'ic');
  addEditorComponent(definition.type, x, y, {
    value: part.value || part.part,
    footprint: part.footprint,
    description: `${part.name} · ${part.specs || ''}。${part.description || ''}价格与库存以立创商城等供应商为准。`.slice(0, 400),
    marketPartId: part.id,
  });
}

function renderMarketInventory() {
  const query = $('#component-search')?.value.trim().toLowerCase() || '';
  const groupFiltered = marketGroup === '全部' ? MARKET_PARTS_LIBRARY : MARKET_PARTS_LIBRARY.filter((part) => part.group === marketGroup);
  const filtered = query
    ? groupFiltered.filter((part) => `${part.part} ${part.name} ${part.group} ${part.value} ${part.footprint} ${part.specs || ''} ${part.description || ''}`.toLowerCase().includes(query))
    : groupFiltered;
  // 分组芯片与列表一起渲染，避免列表 innerHTML 覆盖独立分组容器；点击用委托绑定。
  $('#inventory-market').innerHTML = `<div class="market-group-row">${MARKET_GROUPS.map((group) => `<button class="${group === marketGroup ? 'active' : ''}" data-market-group="${esc(group)}">${esc(group)}</button>`).join('')}</div>${filtered.length ? `<div class="market-list">${filtered.map((part) => {
    const definition = COMPONENT_LIBRARY.find((item) => item.type === part.symbolType);
    return `<button type="button" class="shelf-item part-item" draggable="true" data-market-part="${esc(part.id)}" title="${esc(part.part)} · ${esc(part.specs || '')}：${esc(part.description || '')}" aria-label="添加${esc(part.part)}"><span class="shelf-symbol">${definition ? componentIconSvg(definition) : ''}</span><span class="part-info"><b>${esc(part.part)}</b><small>${esc(part.name)}</small><i>${esc(part.footprint)}</i></span></button>`;
  }).join('')}</div><p class="market-note">共 ${filtered.length} 件 · 价格与库存以立创商城等供应商为准</p>` : `<div class="no-selection"><span>${iconMarkup('search')}</span><h3>没有匹配的型号</h3><p>支持型号、名称、封装与用途搜索，例如“降压”“STM32”“SOP-8”。</p></div>`}`;
  $$('#inventory-market .part-item').forEach((item) => {
    let dragging = false;
    item.addEventListener('dragstart', (event) => {
      dragging = true;
      event.dataTransfer.setData('application/x-circuit-component', marketPartById(item.dataset.marketPart)?.symbolType || 'ic');
      event.dataTransfer.setData('application/x-circuit-part', item.dataset.marketPart);
      event.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dragend', () => setTimeout(() => { dragging = false; }, 0));
    item.addEventListener('click', () => {
      if (dragging) return;
      const part = marketPartById(item.dataset.marketPart);
      if (part) placeMarketPart(part, state.editor.viewBox.x + state.editor.viewBox.w / 2, state.editor.viewBox.y + state.editor.viewBox.h / 2);
    });
  });
}

function renderAllInventories() {
  renderComponentInventory();
  renderMarketInventory();
}

function sendPlanToStudio() {
  if (!state.plan) return;
  if (state.editor.dirty && !window.confirm('工作室有未保存更改，仍要载入生成方案吗？')) return;
  const bomByRef = new Map((state.plan.components || []).map((item) => [item.ref, item]));
  const components = (state.plan.schematic?.components || []).map((item,index) => {
    const bom = bomByRef.get(item.ref) || bomByRef.get(String(item.ref || '').split('.')[0]);
    return { ...structuredClone(item), ...(bom ? { value:['terminal','ground'].includes(item.type) ? item.value : bom.value || item.value, footprint:bom.footprint, description:`${bom.role}；首次上电前复核型号、极性与额定值。` } : { description:'由智能生成方案导入，器件型号与引脚待复核。' }), id:`plan-${Date.now()}-${index}` };
  });
  const wireDrafts = (state.plan.schematic?.wires || []).map((item,index) => ({ ...structuredClone(item), id:`wire-${Date.now()}-${index}`, net:item.net || item.label || '' }));
  const wires = normalizeEditorWireEndpoints(bindEditorWireEndpoints(wireDrafts, components), components);
  Object.assign(state.editor,{id:'',name:state.plan.title,createdAt:'',components,wires,selected:null,selectedKind:'',history:[],future:[],dirty:true,wireStart:null,wireDraft:null,wireDrag:null,wireHover:null,wireEdit:null,drag:null,pan:null,spacePressed:false,pendingCrossings:[],pendingCrossingTotal:0,zoom:1,viewBox:{x:0,y:0,w:EDITOR_BASE_VIEW.w,h:EDITOR_BASE_VIEW.h}});
  $('#project-name').value = state.plan.title; markEditorDirty(); renderEditor(); fitStudioCanvas(); navigate('studio'); toast('方案已发送到工作室，可继续拖拽、连线和编辑属性。');
}

function editorExportSvg() {
  const wires = state.editor.wires.map((item) => `<polyline points="${wirePath(item)}" fill="none" stroke="#79a7ba" stroke-width="2"/>`).join('');
  const components = state.editor.components.map(symbolSvg).join('');
  const bounds=editorContentBounds(70);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}"><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.w}" height="${bounds.h}" fill="#091725"/>${wires}${components}<text x="${bounds.x+18}" y="${bounds.y+bounds.h-16}" fill="#607589" font-size="10">${esc(state.editor.name)} · 电路助手 Studio 概念图</text></svg>`;
}

async function exportStudioProject() {
  const bundle = JSON.stringify({format:'circuit-assistant-project-v1',version:'0.9.1',project:{id:state.editor.id,name:$('#project-name').value,components:state.editor.components,wires:state.editor.wires,viewport:{zoom:state.editor.zoom,viewBox:state.editor.viewBox}},notice:'参考设计项目，进入 EDA 前需绑定真实符号、引脚和封装，并完成额定值与网络复核。'},null,2);
  const result = await desktop.saveExport({title:'导出电路助手项目',defaultName:`${($('#project-name').value||'电路项目').replace(/[\\/:*?"<>|]/g,'-')}.circuit.json`,filters:[{name:'电路助手项目',extensions:['json']}],data:bundle});
  if (!result.canceled) toast(`项目已导出：${result.filePath}`);
}

async function exportStudioSvg() {
  if (!state.editor.components.length) { toast('画布为空，请先放置元件。','error'); return; }
  const safeName = ($('#project-name').value || '电路图').replace(/[\\/:*?"<>|]/g,'-');
  const result = await desktop.saveExport({
    title:'导出可缩放电路图纸',
    defaultName:`${safeName}.svg`,
    filters:[{name:'SVG 矢量图纸',extensions:['svg']}],
    data:editorExportSvg(),
  });
  if (!result.canceled) toast(`图纸已导出：${result.filePath}`);
}

function renderSchematic(plan) {
  const wireItems = plan.schematic?.wires || [];
  const continuity = plan.schematic?.layout?.connectivity;
  const wires = wireItems.map((item) => {
    const points = item.points.map(([x, y]) => `${Number(x)},${Number(y)}`).join(' ');
    const junctions = (item.junctions || []).map(([x,y]) => `<circle cx="${Number(x)}" cy="${Number(y)}" r="2.6" fill="#62d6ae"/>`).join('');
    const label = item.label ? `<text x="${Number(item.labelX ?? item.points.at(-1)?.[0])}" y="${Number(item.labelY ?? item.points.at(-1)?.[1])}" text-anchor="${esc(item.labelAnchor || 'start')}" fill="#62d6ae" font-size="8" font-weight="650" paint-order="stroke" stroke="#0c1b29" stroke-width="4">${esc(item.label)}</text>` : '';
    return `<polyline points="${points}" fill="none" stroke="#79a7ba" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${junctions}${label}`;
  }).join('');
  const bridges = wireItems.flatMap((item) => item.bridges || []).map(([x,y]) => `
    <circle cx="${Number(x)}" cy="${Number(y)}" r="6.5" fill="#0c1b29"/>
    <path d="M${Number(x) - 6} ${Number(y)} A6 6 0 0 1 ${Number(x) + 6} ${Number(y)}" fill="none" stroke="#79a7ba" stroke-width="2" stroke-linecap="square"/>`
  ).join('');
  const components = (plan.schematic?.components || []).map(symbolSvg).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 450" role="img" aria-label="${esc(plan.title)}">
    <rect width="560" height="450" rx="12" fill="#0c1b29"/>
    <g opacity=".12"><path d="M20 25h520M20 75h520M20 125h520M20 175h520M20 225h520M20 275h520M20 325h520M20 375h520M20 425h520M25 20v410M75 20v410M125 20v410M175 20v410M225 20v410M275 20v410M325 20v410M375 20v410M425 20v410M475 20v410M525 20v410" stroke="#7895aa" stroke-width=".5"/></g>
    <text x="20" y="24" fill="#526d80" font-size="8" letter-spacing="1.5">CIRCUIT ASSISTANT · REFERENCE DESIGN SCHEMATIC</text>
    <text x="540" y="24" text-anchor="end" fill="${continuity?.continuous === false ? '#ffb86b' : '#62d6ae'}" font-size="8" font-weight="650">${continuity?.continuous === false ? '发现布线断点' : '连续布线校验 · PASS'}</text>
    <g>${wires}</g><g>${bridges}</g><g>${components}</g>
    <text x="540" y="432" text-anchor="end" fill="#476274" font-size="8">VERIFY RATINGS · ERC/DRC · TEST BEFORE POWER-UP</text>
  </svg>`;
}

function renderPlan(plan, audit) {
  state.plan = plan;
  state.audit = audit;
  state.zoom = 1;
  state.currentSvg = renderSchematic(plan);
  $('#result-title').textContent = plan.title;
  const evidence = [...(plan.knowledgeEvidence || []), ...(plan.localKnowledgeEvidence || [])];
  $('#result-subtitle').textContent = `第 ${plan.revisionNumber || 1} 版 · 参数完整度 ${plan.parameterCompleteness || 0}% · ${evidence.length} 条工程依据 · 置信度 ${Math.round(plan.confidence * 100)}%`;
  const layout = plan.schematic?.layout;
  $('.canvas-toolbar > span').innerHTML = `<i class="green-dot"></i>${layout ? '排版智能体优化稿' : '第一版参考原理图'}`;
  $('#schematic-topology').textContent = layout?.connectivity?.checked
    ? `连续布线校验 · ${layout.connectivity.danglingEndpoints} 个悬空端点`
    : layout ? `排版智能体 · 可读性 ${layout.score} 分` : plan.topology;
  $('#schematic-summary').textContent = layout
    ? `${plan.topology} · 正交布线 · ${layout.connectivity?.connectedPins || 0}/${layout.connectivity?.requiredPins || 0} 个${plan.kind === 'motor-driver' ? '关键引脚' : '布线端点'}已连接 · 已隐藏 ${layout.hiddenLabels} 处冗余标识`
    : `${plan.components.length} 项 BOM · ${plan.connections.length} 条网络说明 · 上电前复核`;
  $('#revision-version').textContent = plan.revisionNumber > 1 ? `修订版 v${plan.revisionNumber}` : '第一版 v1';
  updateRevisionExamples(plan);
  $('#schematic-mount').innerHTML = state.currentSvg;
  $('#schematic-mount').style.transform = 'scale(1)';
  $('#zoom-label').textContent = '100%';

  const specs = [
    metric(plan.specs.inputVoltage, 'V 输入'), metric(plan.specs.outputVoltage, 'V 输出'),
    metric(plan.specs.current, 'A'), metric(plan.specs.frequency, 'Hz'), metric(plan.specs.gain, '× 增益'),
  ].filter(Boolean).join('');
  const enhancement = plan.aiEnhancement;
  $('#inspector-overview').innerHTML = `
    <div class="summary-box"><b>${esc(plan.topology)}</b><p>${esc(plan.function)}</p><div class="metric-line">${specs || '<span>参数待补充</span>'}</div></div>
    ${plan.intentSummary ? `<div class="info-section"><h3>需求理解</h3><div class="summary-box"><p>${esc(plan.intentSummary)}</p></div></div>` : ''}
    ${(plan.clarifyingQuestions || []).length ? `<div class="info-section needs-confirmation"><h3>定型前需要确认</h3>${listHtml(plan.clarifyingQuestions, 'warning-list')}</div>` : ''}
    ${(plan.designBasis || []).length ? `<div class="info-section design-basis"><h3>为什么选择这套第一版</h3>${listHtml(plan.designBasis)}</div>` : ''}
    <div class="info-section"><h3>关键假设</h3>${listHtml([...(plan.assumptions || []), ...(enhancement?.assumptions || [])])}</div>
    <div class="info-section"><h3>计算依据</h3>${listHtml(plan.equations)}</div>
    <div class="info-section"><h3>专项工程校核</h3>${listHtml([...(plan.engineeringChecks || []), ...(enhancement?.designChecks || [])])}</div>
    <div class="info-section"><h3>PCB 布局要点</h3>${listHtml([...(plan.pcbTips || []), ...(enhancement?.pcbAdvice || [])])}</div>
    ${enhancement ? `<div class="info-section"><h3>扩展推理补充</h3>${listHtml([enhancement.summary, ...(enhancement.mustConfirm || [])])}</div>` : ''}
    <div class="info-section"><h3>验证计划</h3>${listHtml(plan.verificationPlan?.length ? plan.verificationPlan : plan.nextSteps)}</div>
    <div class="info-section"><h3>可追溯工程依据</h3>${retrievalTraceHtml(plan.localRetrievalTrace)}${evidenceHtml(evidence)}</div>`;

  $('#inspector-bom').innerHTML = `<table class="bom-table"><thead><tr><th>位号</th><th>建议值/器件</th><th>用途</th></tr></thead><tbody>${plan.components.map((item) => `<tr><td>${esc(item.ref)}</td><td>${esc(item.value)}<br><small>${esc(item.footprint)}</small></td><td>${esc(item.role)}</td></tr>`).join('')}</tbody></table><div class="info-section"><h3>连接说明</h3>${listHtml(plan.connections)}</div>`;

  const icon = { pass: 'check', warn: 'alert', fail: 'x' };
  $('#inspector-audit').innerHTML = `<div class="audit-score"><div class="score-ring">${audit.score}</div><div><b>${esc(audit.decision)}</b><span>工程校验 · ${audit.checks.length} 项检查</span></div></div>${audit.checks.map((check) => `<div class="audit-check ${check.status}"><i>${iconMarkup(icon[check.status])}</i><div><b>${esc(check.title)}</b><span>${esc(check.detail)}</span></div></div>`).join('')}<div class="boundary-note"><span>${iconMarkup('alert')}</span><p>${esc(audit.disclaimer)}</p></div>`;
  $('#result-shell').classList.remove('hidden');
  setTimeout(() => { if ($('#page-designer').classList.contains('active')) $('#result-shell').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
}

async function retrieveLocalKnowledge(query, limit = 8) {
  try {
    return await desktop.searchKnowledge(query, { limit });
  } catch (error) {
    toast(`本地 SQL 知识检索未完成：${error.message}`, 'error');
    return [];
  }
}

function attachLocalEvidence(plan, hits) {
  plan.localKnowledgeEvidence = (hits || []).map((item) => ({
    id: item.id,
    sourceId: item.sourceId,
    chunkId: item.chunkId,
    title: item.heading || item.title,
    sourceTitle: item.title,
    publisher: item.publisher,
    url: item.sourceUrl || '',
    pageStart: item.pageStart,
    pageEnd: item.pageEnd,
    maturity: '用户本地资料；需结合器件数据手册复核',
    local: true,
  }));
}

let agentRunTotal = 0;
let agentPersistenceReady = false;
let agentPersistencePromise = Promise.resolve();
let queuedAgentSession = '';
let agentPersistenceWarningShown = false;
const agentStatusLabels = { pending: '待执行', running: '执行中', completed: '已完成', skipped: '已跳过', warning: '已降级', failed: '失败' };

function persistAgentSession({ force = false } = {}) {
  if (!agentPersistenceReady) return Promise.resolve();
  const session = agentRun.serialize(agentRunTotal);
  const encoded = JSON.stringify(session);
  if (!force && encoded === queuedAgentSession) return agentPersistencePromise;
  queuedAgentSession = encoded;
  agentPersistencePromise = agentPersistencePromise
    .then(() => desktop.saveAgentSession(session))
    .then(() => { agentPersistenceWarningShown = false; })
    .catch((error) => {
      queuedAgentSession = '';
      if (!agentPersistenceWarningShown) toast(`运行记录未能保存：${error.message}`, 'error');
      agentPersistenceWarningShown = true;
    });
  return agentPersistencePromise;
}

function onAgentRunChange() {
  renderAgentWorkspace();
  void persistAgentSession();
}

const agentRun = new AgentRun(onAgentRunChange);
const generationStages = [['knowledge', '检索工程知识'], ['build', '生成与排版'], ['model', '可选模型增强'], ['audit', '独立工程审查']];

function formatAgentTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function agentResultSnapshot(kind, payload) {
  return JSON.parse(JSON.stringify({ kind, ...payload }));
}

function restoreAgentResult(run) {
  const result = run?.result;
  try {
    if (result?.kind === 'plan' && result.plan && result.audit) {
      renderPlan(structuredClone(result.plan), structuredClone(result.audit));
      navigate('designer');
      toast('已恢复该次运行的方案与审查结果。');
      return true;
    }
    if (result?.kind === 'optimizer' && result.report) {
      renderOptimizer(structuredClone(result.report));
      navigate('optimizer');
      toast('已恢复该次运行的优化报告。');
      return true;
    }
  } catch (error) {
    toast(`历史结果无法恢复：${error.message}`, 'error');
    return false;
  }
  toast('这条记录没有可恢复的结果快照。', 'error');
  return false;
}

function renderAgentWorkspace() {
  const run = agentRun.active;
  const busy = run?.status === 'running';
  for (const id of ['agent-run', 'generate-button', 'apply-revision', 'agent-review-project', 'optimize-button']) {
    const button = $(`#${id}`);
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  }
  $('#agent-top-status').textContent = busy ? '执行中' : '就绪';
  $('#agent-engine').textContent = '本地确定性工具';
  $('#agent-model-status').textContent = state.aiStatus.provider === 'local-rules' ? '未使用大模型 · 离线可用' : state.aiStatus.connected ? `${state.aiStatus.label} · 已连接` : '模型未连接 · 使用本地工具';
  $('#agent-knowledge-count').textContent = `${state.knowledge.length} 个条目 / 来源`;
  $('#agent-project-count').textContent = `${state.editor.components.length} 个元件`;
  $('#agent-project-name').textContent = $('#project-name').value || '未命名电路';
  $('#agent-run-count').textContent = `累计 ${agentRunTotal} 次`;
  $('#agent-history-note').textContent = agentRun.history.length ? `${agentRun.history.length} 条记录保存在本机` : '最近 8 次自动保存';
  $('#agent-export-history').disabled = busy || !agentRun.history.length;
  $('#agent-clear-history').disabled = busy || !agentRun.history.length;
  $('#agent-history').innerHTML = agentRun.history.map((entry) => {
    const action = entry.result ? '恢复结果' : '查看轨迹';
    return `<button type="button" class="agent-history-item" data-agent-history-id="${esc(entry.id)}" aria-current="${entry.id === run?.id}"><span class="history-dot ${entry.status}"></span><span class="agent-history-copy"><b>${esc(entry.title)}</b><p>${esc(entry.summary || '没有结果摘要')}</p><small>${esc(formatAgentTimestamp(entry.startedAt))} · ${agentStatusLabels[entry.status] || '状态未知'}</small></span><span class="agent-history-open">${action}${iconMarkup('arrow-right')}</span></button>`;
  }).join('') || '<p class="empty-copy">还没有运行记录。开始一个任务后会显示结果摘要。</p>';
  if (!run) {
    $('#agent-execution-title').textContent = '执行轨迹';
    $('#agent-run-status').textContent = '等待任务';
    $('#agent-run-status').dataset.status = 'idle';
    $('#agent-stages').innerHTML = '<li class="agent-idle"><span class="agent-idle-icon">↗</span><h4>从一条清晰需求开始</h4><p>这里记录实际工具调用与结果，不展示虚构的思考过程或进度。</p></li>';
    $('#agent-outcome').classList.add('hidden');
    $('#agent-outcome').textContent = '';
    $('#agent-view-result').classList.add('hidden');
    return;
  }
  $('#agent-execution-title').textContent = run.title.startsWith('修订：') ? '执行轨迹 · 方案修订' : run.page === 'optimizer' ? '执行轨迹 · 电路审查' : '执行轨迹 · 方案生成';
  $('#agent-run-status').textContent = agentStatusLabels[run.status] || '状态未知';
  $('#agent-run-status').dataset.status = run.status;
  $('#agent-stages').innerHTML = run.stages.map((stage, i) => `<li class="agent-stage ${stage.status}"><i>${stage.status === 'completed' ? iconMarkup('check') : String(i + 1).padStart(2, '0')}</i><div><b>${esc(stage.label)}</b><small>${esc(stage.detail || agentStatusLabels[stage.status])}</small></div><span>${agentStatusLabels[stage.status]}</span></li>`).join('');
  $('#agent-outcome').classList.toggle('hidden', !run.summary);
  $('#agent-outcome').textContent = run.summary || '';
  $('#agent-view-result').classList.toggle('hidden', !run.result);
  $('#agent-view-result').textContent = run.result ? '恢复本次结果 →' : '查看本次结果 →';
}

async function executeDesign(requirement, basePlan = null) {
  if (!agentRun.begin(basePlan ? `修订：${requirement}` : requirement, generationStages)) return false;
  agentRunTotal += 1;
  void persistAgentSession();
  try {
    agentRun.stage('knowledge', 'running', `多路召回检索 · ${RETRIEVAL_STRENGTH_LABELS[activeRetrievalStrength()]}`);
    let knowledgeContext = [];
    let retrievalTrace = null;
    try {
      const retrieval = await desktop.searchKnowledgeDebug(`${basePlan?.requirement || ''} ${requirement}`.trim(), { limit: 8, strength: activeRetrievalStrength() });
      knowledgeContext = retrieval.hits || [];
      retrievalTrace = retrieval.trace || null;
      const routeInfo = retrievalTrace?.routeCount ? `${retrievalTrace.routeCount} 路召回 · 候选 ${retrievalTrace.candidateCount} 片段` : '';
      agentRun.stage('knowledge', 'completed', `融合选出 ${knowledgeContext.length} 个本地片段${routeInfo ? `（${routeInfo}）` : ''}`);
    } catch (error) {
      try {
        knowledgeContext = await desktop.searchKnowledge(`${basePlan?.requirement || ''} ${requirement}`.trim(), { limit: 8 });
        agentRun.stage('knowledge', 'completed', `召回 ${knowledgeContext.length} 个本地片段（单路回退）`);
      } catch (innerError) {
        agentRun.stage('knowledge', 'warning', `本地检索失败，使用内置知识：${innerError.message}`);
      }
    }
    agentRun.stage('build', 'running', '确定性模板、参数计算与正交排版');
    const plan = basePlan ? reviseCircuit(basePlan, requirement, state.knowledge) : generateCircuit(requirement, state.knowledge);
    attachLocalEvidence(plan, knowledgeContext);
    if (retrievalTrace) {
      plan.localRetrievalTrace = {
        strength: retrievalTrace.strength,
        strengthLabel: retrievalTrace.strengthLabel,
        routeCount: retrievalTrace.routeCount,
        candidateCount: retrievalTrace.candidateCount,
        selectedCount: retrievalTrace.selectedCount,
        expandedTerms: (retrievalTrace.expandedTerms || []).slice(0, 12),
        topicsSelected: retrievalTrace.topicsSelected || [],
      };
    }
    agentRun.stage('build', 'completed', `${plan.components.length} 项器件 · ${plan.knowledgeEvidence?.length || 0} 条工程依据`);
    if (state.settings?.provider !== 'local-rules' && state.aiStatus.connected) {
      agentRun.stage('model', 'running', `调用 ${state.aiStatus.label}`);
      try {
        const enhancement = await desktop.enhancePlan({ requirement: plan.requirement, plan, knowledgeContext });
        if (enhancement) {
          plan.aiEnhancement = enhancement;
          plan.source = `${plan.source} + ${state.aiStatus.label}`;
          plan.warnings.push(...(enhancement.warnings || []));
        }
        agentRun.stage('model', enhancement ? 'completed' : 'skipped', enhancement ? '模型建议已附加，数值仍由本地工具计算' : '未返回增强结果，保留本地方案');
      } catch (error) {
        agentRun.stage('model', 'warning', `模型调用失败，保留本地方案：${error.message}`);
        toast('扩展推理未完成，已保留本地方案。', 'error');
      }
    } else {
      agentRun.stage('model', 'skipped', state.settings?.provider === 'local-rules' ? '本地模式，不调用大模型' : '模型未连接，不调用外部服务');
    }
    agentRun.stage('audit', 'running', '核对参数、连接与安全边界');
    const audit = supervisePlan(plan, plan.requirement);
    const resultSnapshot = agentResultSnapshot('plan', { plan, audit });
    renderPlan(plan, audit);
    agentRun.stage('audit', 'completed', `${audit.checks.length} 项检查 · ${audit.decision}`);
    agentRun.finish(`${plan.topology} · ${plan.components.length} 项器件。${audit.decision}；完成运行不代表允许投板。`, { result: resultSnapshot });
    await persistAgentSession();
    toast(basePlan ? `修订版 v${plan.revisionNumber} 已生成。` : '方案与审查已生成，可查看结果后发送到工作室。');
    return true;
  } catch (error) {
    agentRun.finish(`任务失败：${error.message}。原有方案未被本次失败替换。`, { failed: true });
    await persistAgentSession();
    toast(error.message, 'error');
    return false;
  }
}

async function generate(origin = 'designer') {
  if (agentRun.active?.status === 'running') return;
  const input = origin === 'agent' ? $('#agent-prompt') : $('#requirement-input');
  const requirement = input.value.trim();
  if (requirement.length < 6) {
    toast('请先描述电路用途和至少一个关键参数。', 'error');
    input.focus();
    return;
  }
  if (await executeDesign(requirement)) {
    $('#requirement-input').value = requirement;
    $('#requirement-input').dispatchEvent(new Event('input'));
    $('#revision-input').value = '';
  }
}

async function applyRevision() {
  if (agentRun.active?.status === 'running') return;
  if (!state.plan) { toast('请先生成第一版电路。','error'); return; }
  const input = $('#revision-input');
  const request = input.value.trim();
  if (request.length < 3) { toast('请描述要修改的电压、器件、参数或控制方式。','error'); input.focus(); return; }
  if (await executeDesign(request, structuredClone(state.plan))) input.value = '';
}

async function exportData(kind) {
  if (!state.plan) return;
  let payload;
  if (kind === 'svg') payload = { title: '导出原理图草案', defaultName: '电路助手-原理图草案.svg', filters: [{ name: 'SVG 矢量图', extensions: ['svg'] }], data: state.currentSvg };
  if (kind === 'bom') payload = { title: '导出 BOM', defaultName: '电路助手-BOM.csv', filters: [{ name: 'CSV 表格', extensions: ['csv'] }], data: `\ufeff${planToCsv(state.plan)}` };
  if (kind === 'bundle') payload = { title: '导出 PCB 交接包', defaultName: '电路助手-PCB交接包.json', filters: [{ name: 'JSON 交换文件', extensions: ['json'] }], data: planToBundle(state.plan, state.audit) };
  const result = await desktop.saveExport(payload);
  if (!result.canceled) toast(`已保存：${result.filePath}`);
}

function updateZoom(delta) {
  state.zoom = Math.max(.6, Math.min(1.8, state.zoom + delta));
  $('#schematic-mount').style.transform = `scale(${state.zoom})`;
  $('#zoom-label').textContent = `${Math.round(state.zoom * 100)}%`;
}

function updateProviderUI(status) {
  state.aiStatus = status;
  $('#provider-label').textContent = status.label || '本地规则核心';
  $('#provider-detail').textContent = status.detail || '';
  $('#provider-light').classList.toggle('off', !status.connected);
  $('#designer-engine').textContent = status.provider === 'local-rules' ? '专家知识增强' : status.connected ? '扩展推理已连接' : '专家知识备用';
  $('#vision-mode-hint').textContent = status.provider === 'local-rules' || !status.connected ? '本地视觉启发式 + 工程复核' : `${status.label} · 视觉识别`;
  const settingBadge = $('#settings-connection');
  settingBadge.textContent = status.connected ? status.detail || '已连接' : '连接失败';
  settingBadge.classList.toggle('connected', status.connected);
  renderAgentWorkspace();
}

async function refreshStatus() {
  try { updateProviderUI(await desktop.getAiStatus()); }
  catch (error) { updateProviderUI({ provider: state.settings?.provider || 'local-rules', connected: false, label: 'AI 未连接', detail: error.message }); }
}

function selectProvider(value) {
  $$('.provider-option').forEach((label) => {
    const selected = $('input', label).value === value;
    label.classList.toggle('selected', selected);
    $('input', label).checked = selected;
  });
  $('#ollama-settings').classList.toggle('hidden', value !== 'ollama');
  $('#remote-settings').classList.toggle('hidden', value !== 'openai-compatible');
}

function collectSettings() {
  const temperature = Number($('#ai-temperature').value);
  const numCtx = Number($('#ollama-num-ctx').value);
  const entries = Number($('#knowledge-max-entries').value);
  return {
    provider: $('input[name="provider"]:checked').value,
    ollamaBaseUrl: $('#ollama-url').value.trim(),
    ollamaModel: $('#ollama-model').value.trim(),
    remoteBaseUrl: $('#remote-url').value.trim(),
    remoteModel: $('#remote-model').value.trim(),
    remoteApiKey: $('#remote-key').value,
    retrievalStrength: $('#retrieval-strength-select').value,
    aiTemperature: Number.isFinite(temperature) ? temperature : 0.15,
    ollamaNumCtx: Number.isFinite(numCtx) ? numCtx : 8192,
    knowledgeMaxEntries: Number.isFinite(entries) ? entries : 12,
    allowRemoteKnowledge: $('#allow-remote-knowledge').checked,
  };
}

async function saveSettings(showToast = true) {
  try {
    state.settings = await desktop.saveSettings(collectSettings());
    await refreshStatus();
    if (showToast) toast('AI 设置已安全保存。');
    return true;
  } catch (error) {
    toast(error.message, 'error');
    return false;
  }
}

function applySettings(settings) {
  state.settings = settings;
  selectProvider(settings.provider);
  $('#ollama-url').value = settings.ollamaBaseUrl;
  $('#ollama-model').value = settings.ollamaModel;
  $('#remote-url').value = settings.remoteBaseUrl;
  $('#remote-model').value = settings.remoteModel;
  $('#remote-key').value = settings.remoteApiKey;
  $('#retrieval-strength-select').value = settings.retrievalStrength || 'deep';
  $('#ai-temperature').value = Number(settings.aiTemperature ?? 0.15);
  $('#ollama-num-ctx').value = Number(settings.ollamaNumCtx ?? 8192);
  $('#knowledge-max-entries').value = String(Number(settings.knowledgeMaxEntries ?? 12));
  $('#allow-remote-knowledge').checked = settings.allowRemoteKnowledge === true;
  syncRetrievalStrengthUI();
}

const RETRIEVAL_STRENGTH_LABELS = { standard: '标准检索', deep: '深度检索', exhaustive: '穷尽检索' };

function activeRetrievalStrength() {
  const value = state.settings?.retrievalStrength;
  return ['standard', 'deep', 'exhaustive'].includes(value) ? value : 'deep';
}

function syncRetrievalStrengthUI() {
  const strength = activeRetrievalStrength();
  $$('#retrieval-strength button').forEach((button) => button.classList.toggle('active', button.dataset.strength === strength));
  const statusBadge = $('#retrieval-status');
  if (statusBadge) {
    statusBadge.textContent = RETRIEVAL_STRENGTH_LABELS[strength] || '深度检索';
    statusBadge.classList.toggle('connected', true);
  }
}

function renderKnowledge() {
  const allKnowledge = [...state.knowledge, ...state.dbSearchHits];
  const levelOf = (entry) => entry.category === '用户资料' ? '用户资料' : entry.level || '基础';
  const levelSource = state.knowledgeLevel === '全部' ? allKnowledge : allKnowledge.filter((entry) => levelOf(entry) === state.knowledgeLevel);
  const categories = ['全部', ...new Set(levelSource.map((entry) => entry.category || '其他'))];
  if (!categories.includes(state.knowledgeCategory)) state.knowledgeCategory = '全部';
  $('#knowledge-filters').innerHTML = categories.map((category) => `<button class="${category === state.knowledgeCategory ? 'active' : ''}" data-category="${esc(category)}">${esc(category)}</button>`).join('');
  const query = $('#knowledge-search').value.trim();
  const source = state.knowledgeCategory === '全部' ? levelSource : levelSource.filter((entry) => entry.category === state.knowledgeCategory);
  const entries = query ? knowledgeSearch(source, query, 100) : source;
  const initials = { '电路基础':'基', '电源':'源', '模拟':'模', '数字':'数', '驱动':'驱', '时序':'时', 'PCB':'板', '安全':'安', '用户资料':'入' };
  $('#knowledge-list').innerHTML = entries.length ? entries.map((entry) => `
    <article class="knowledge-item">
      <span class="knowledge-category">${initials[entry.category] || '知'}</span>
      <div class="knowledge-main"><h3>${esc(entry.title)}<span class="knowledge-level-badge">${esc(levelOf(entry))}</span>${entry.scoreTrace ? `<span class="score-badge" title="RRF 融合分 ${entry.scoreTrace.fused} · ${entry.scoreTrace.routeCount} 路命中">融合 ${entry.scoreTrace.routeCount} 路</span>` : ''}</h3><p>${esc(entry.summary)}</p><div class="knowledge-tags">${(entry.tags || []).slice(0,5).map((tag) => `<span>${esc(tag)}</span>`).join('')}</div></div>
      <button class="source-button" data-source="${esc(entry.source?.url || '')}" ${entry.source?.url ? '' : 'disabled'}>${entry.source?.url ? `来源 ${iconMarkup('external')}` : entry.localSource || entry.localSearchHit ? '本地 SQL' : entry.verified ? '已校验' : '待验证'}</button>
    </article>`).join('') : '<div class="vision-placeholder"><h3>没有匹配条目</h3><p>换一个关键词或导入本地资料。</p></div>';
  $('#stat-entries').textContent = Number(state.dbStats.chunk_count || 0) + state.knowledge.filter((entry) => !entry.localSource).length;
  $('#stat-categories').textContent = new Set(state.knowledge.map((entry) => entry.category)).size;
  $('#stat-verified').textContent = state.knowledge.filter((entry) => entry.verified).length;
  if ($('#learning-status')) $('#learning-status').textContent = `${state.dbStats.source_count || 0} 份本地资料 · ${state.dbStats.chunk_count || 0} 个 SQL 片段`;
  const advanced = state.knowledge.filter((entry) => levelOf(entry)==='进阶').length;
  $('#advanced-count').textContent = `${advanced} 个专题`;
  $$('#knowledge-levels button').forEach((button)=>button.classList.toggle('active',button.dataset.level===state.knowledgeLevel));
}

async function loadKnowledge() {
  const data = await desktop.loadKnowledge();
  state.userKnowledge = data.user || [];
  state.dbStats = data.stats || state.dbStats;
  state.knowledge = [...(data.base || []).map((entry)=>({...entry,level:entry.level||'基础'})), ...(data.advanced || []).map((entry)=>({...entry,level:'进阶'})), ...state.userKnowledge];
  renderKnowledge();
}

async function importKnowledge(mode = 'files') {
  const button = mode === 'folder' ? $('#import-knowledge-folder') : $('#import-knowledge');
  setBusy(button, true);
  try {
    const report = mode === 'folder' ? await desktop.importKnowledgeFolder() : await desktop.importKnowledge();
    if (report.canceled) return;
    await loadKnowledge();
    const imported = report.results.filter((item) => item.status === 'imported').length;
    const duplicate = report.results.filter((item) => item.status === 'duplicate').length;
    const needsOcr = report.results.filter((item) => item.status === 'needs-ocr').length;
    const failed = report.results.filter((item) => item.status === 'error').length;
    const detail = [
      `${imported} 份已入库`,
      duplicate ? `${duplicate} 份重复` : '',
      needsOcr ? `${needsOcr} 份需 OCR` : '',
      failed ? `${failed} 份失败` : '',
    ].filter(Boolean).join('，');
    toast(detail, failed || needsOcr ? 'error' : 'success');
  } finally {
    setBusy(button, false);
  }
}

let knowledgeSearchTimer;
function renderRetrievalTrace(trace) {
  const panel = $('#retrieval-trace');
  if (!panel) return;
  if (!trace || trace.empty) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  const routes = (trace.routes || []).map((route) => {
    const terms = (route.terms || []).slice(0, 6).join(' ');
    return `<div class="trace-route"><b>${esc(route.label)}</b><span>${esc(terms)}</span><i>${route.hitCount} 命中</i></div>`;
  }).join('');
  const expanded = (trace.expandedTerms || []).slice(0, 10).join('、');
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="trace-head"><b>${esc(trace.strengthLabel || '深度')}检索</b><span>${trace.routeCount} 路召回 · 候选 ${trace.candidateCount} 片段 · 融合后取 ${trace.selectedCount} 条 · ${trace.elapsedMs} ms</span></div>
    ${expanded ? `<div class="trace-expanded">同义扩展：${esc(expanded)}</div>` : ''}
    <div class="trace-routes">${routes}</div>`;
}

function scheduleKnowledgeSearch() {
  clearTimeout(knowledgeSearchTimer);
  knowledgeSearchTimer = setTimeout(async () => {
    const query = $('#knowledge-search').value.trim();
    const sequence = ++state.knowledgeSearchSequence;
    if (query.length < 2) {
      state.dbSearchHits = [];
      renderRetrievalTrace(null);
      renderKnowledge();
      return;
    }
    try {
      const { hits, trace } = await desktop.searchKnowledgeDebug(query, { limit: 30, strength: activeRetrievalStrength() });
      if (sequence !== state.knowledgeSearchSequence) return;
      state.dbSearchHits = hits.map((item) => ({
        id: item.id,
        title: `${item.title}${item.pageStart ? ` · 第 ${item.pageStart} 页` : ''}`,
        category: '本地书库',
        level: '用户资料',
        tags: [item.publisher, item.heading].filter(Boolean),
        summary: item.content,
        content: item.content,
        source: { title: item.title, url: item.sourceUrl || '' },
        localSource: true,
        localSearchHit: true,
        verified: false,
        scoreTrace: item.scoreTrace,
      }));
      renderRetrievalTrace(trace);
    } catch (error) {
      if (sequence !== state.knowledgeSearchSequence) return;
      state.dbSearchHits = [];
      renderRetrievalTrace(null);
      toast(`本地 SQL 知识检索未完成：${error.message}`, 'error');
    }
    renderKnowledge();
  }, 180);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function setImage(file) {
  if (!file || !file.type.startsWith('image/')) { toast('请选择 PNG、JPG、WEBP 或 BMP 图片。', 'error'); return; }
  if (file.size > 18 * 1024 * 1024) { toast('图片超过 18 MB。', 'error'); return; }
  const dataUrl = await fileToDataUrl(file);
  const image = new Image();
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = dataUrl; });
  state.image = { file, dataUrl, width: image.naturalWidth, height: image.naturalHeight, image };
  $('#image-preview').src = dataUrl;
  $('#drop-zone').classList.add('has-image');
  $('#file-strip').classList.remove('hidden');
  $('#file-name').textContent = file.name;
  $('#file-meta').textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${(file.size / 1024).toFixed(1)} KB`;
  $('#analyze-button').disabled = false;
  $('#vision-results').classList.add('hidden');
  $('#vision-placeholder').classList.remove('hidden');
  $('#vision-confidence').textContent = '待分析';
}

function clearImage() {
  state.image = null;
  $('#image-input').value = '';
  $('#image-preview').removeAttribute('src');
  $('#drop-zone').classList.remove('has-image');
  $('#file-strip').classList.add('hidden');
  $('#analyze-button').disabled = true;
  $('#vision-results').classList.add('hidden');
  $('#vision-placeholder').classList.remove('hidden');
  $('#vision-confidence').textContent = '待分析';
}

function localImageAnalysis(imageState) {
  const canvas = $('#analysis-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const scale = Math.min(1, 520 / Math.max(imageState.width, imageState.height));
  canvas.width = Math.max(1, Math.round(imageState.width * scale));
  canvas.height = Math.max(1, Math.round(imageState.height * scale));
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(imageState.image, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const gray = new Uint8Array(canvas.width * canvas.height);
  let dark = 0, saturated = 0, transitions = 0;
  for (let i=0,p=0;i<data.length;i+=4,p++) {
    const r=data[i], g=data[i+1], b=data[i+2];
    const value = Math.round(.299*r+.587*g+.114*b); gray[p]=value;
    if (value < 170) dark++;
    if (Math.max(r,g,b)-Math.min(r,g,b) > 70) saturated++;
  }
  for (let y=1;y<canvas.height;y+=2) for (let x=1;x<canvas.width;x+=2) {
    const p=y*canvas.width+x;
    if (Math.abs(gray[p]-gray[p-1])>65) transitions++;
    if (Math.abs(gray[p]-gray[p-canvas.width])>65) transitions++;
  }
  const pixels = canvas.width*canvas.height;
  const darkRatio=dark/pixels, saturation=saturated/pixels, edgeDensity=transitions/(pixels/2);
  const filename=imageState.file.name.toLowerCase();
  const hints = [
    [/buck|降压/, 'Buck 降压电源'], [/boost|升压/, 'Boost 升压电源'], [/555|osc|振荡/, '定时/振荡电路'],
    [/op.?amp|运放|amplifier|放大/, '运算放大器电路'], [/rectifier|bridge|整流/, '整流滤波电路'],
    [/relay|motor|mosfet|继电器|电机/, '功率开关/驱动电路'], [/mcu|stm32|esp32|单片机/, 'MCU 控制电路'],
  ];
  const filenameHint = hints.find(([pattern]) => pattern.test(filename));
  const looksSchematic = darkRatio > .012 && darkRatio < .42 && edgeDensity > .018 && saturation < .18;
  const circuitType = filenameHint?.[1] || (looksSchematic ? '电路原理图 / 功能框图' : saturation > .2 ? 'PCB 或电路实物图片' : '未确认的技术图像');
  const confidence = filenameHint ? .55 : looksSchematic ? .34 : .22;
  return {
    circuitType,
    function: filenameHint ? `文件名和图像结构指向“${filenameHint[1]}”，仍需视觉模型读取元件与网络后确认。` : '本地像素分析只能确认图像是否具有电路图特征，不能可靠推断具体功能。请接入支持视觉的本地模型，或提供关键器件/端口信息。',
    confidence,
    blocks: [`图像尺寸 ${imageState.width} × ${imageState.height}`, `暗色线条占比 ${(darkRatio*100).toFixed(1)}%`, `边缘密度 ${(edgeDensity*100).toFixed(1)}%`],
    components: filenameHint ? ['尚未读取到可靠器件标号'] : [],
    signalFlow: '未建立可验证的网络拓扑。',
    evidence: [looksSchematic ? '白色/浅色背景上存在较多高对比线条与符号结构' : '未检测到典型原理图的稳定结构特征', saturation > .2 ? '彩色区域较多，可能是 PCB/实物而非原理图' : '图像颜色较少'],
    uncertainties: ['未执行 OCR 与元件符号语义识别', '无法从像素统计验证网络连接', '候选功能不能作为设计结论'],
    risks: ['低置信度结果不得用于器件选型或 PCB 投板'],
    nextSteps: ['接入 Ollama 视觉模型重新分析', '提供清晰原图并确保器件标号可读', '人工确认输入、输出、电源和关键芯片'],
    engine: '本地视觉启发式',
  };
}

function renderVision(result) {
  const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  $('#vision-confidence').textContent = `${Math.round(confidence*100)}% 置信`;
  $('#vision-placeholder').classList.add('hidden');
  const results = $('#vision-results');
  results.classList.remove('hidden');
  results.innerHTML = `
    <div class="recognition-hero"><span class="label">${esc(result.engine || state.aiStatus.label || '识别结果')}</span><h3>${esc(result.circuitType || '未知电路')}</h3><p>${esc(result.function || '未返回功能说明')}</p></div>
    <div class="vision-columns">
      <div class="vision-card"><h4>可见模块 / 元件</h4>${listHtml([...(result.blocks || []), ...(result.components || [])])}</div>
      <div class="vision-card"><h4>判断依据</h4>${listHtml(result.evidence)}</div>
      <div class="vision-card warning"><h4>不确定项</h4>${listHtml(result.uncertainties, 'warning-list')}</div>
      <div class="vision-card warning"><h4>风险与下一步</h4>${listHtml([...(result.risks || []), ...(result.nextSteps || [])], 'warning-list')}</div>
    </div>
    <div class="info-section"><h3>信号 / 能量路径</h3><div class="summary-box"><p>${esc(result.signalFlow || '未识别')}</p></div></div>`;
}

async function analyzeImage() {
  if (!state.image) return;
  const button = $('#analyze-button'); setBusy(button,true);
  let result;
  try {
    if (state.settings?.provider !== 'local-rules' && state.aiStatus.connected) {
      try {
        result = await desktop.analyzeImage({ imageDataUrl: state.image.dataUrl, fileName: state.image.file.name });
        result.engine = state.aiStatus.label;
      } catch (error) {
        toast(`视觉模型分析失败，已降级到本地保守识别：${error.message}`, 'error');
      }
    }
    if (!result) result = localImageAnalysis(state.image);
    renderVision(result);
  } catch (error) {
    toast(error.message, 'error');
  } finally { setBusy(button,false); }
}

function renderSolver(result) {
  $('#solver-placeholder').classList.add('hidden');
  $('#solver-result').classList.remove('hidden');
  $('#solver-confidence').textContent = `${Math.round((Number(result.confidence)||0)*100)}% 置信`;
  $('#solver-source').textContent = result.source || '电路助手求解器';
  const detailed = $('#show-detailed-steps').checked;
  $('#solver-result').innerHTML = `
    <div class="answer-hero"><span>最终答案</span><h3>${esc(result.answer)}</h3></div>
    <div class="answer-section"><h4>识别题型</h4><div class="summary-box"><b>${esc(result.title)}</b></div></div>
    <div class="answer-section"><h4>已知量</h4><div class="known-chip-row">${(result.knowns||[]).length ? result.knowns.map((item)=>`<span>${esc(item)}</span>`).join('') : '<span>待补充</span>'}</div></div>
    <div class="answer-section"><h4>使用公式</h4><div class="formula-box">${esc(result.formula)}</div></div>
    ${detailed ? `<div class="answer-section"><h4>代入与推导</h4><ol class="solution-steps">${(result.steps||[]).map((step)=>`<li>${esc(step)}</li>`).join('')}</ol></div>` : ''}
    ${(result.warnings||[]).length ? `<div class="info-section"><h3>适用边界</h3>${listHtml(result.warnings,'warning-list')}</div>` : ''}
    ${result.explanation ? `<div class="info-section"><h3>AI 辅助讲解</h3><div class="summary-box"><p>${esc(result.explanation)}</p></div></div>` : ''}`;
  const matches = knowledgeSearch(state.knowledge, `${result.title} ${result.formula}`, 4);
  $('#solver-knowledge-matches').innerHTML = matches.length ? matches.map((item)=>`<button class="knowledge-match" data-knowledge-query="${esc(item.title)}">${esc(item.title)}</button>`).join('') : '<span class="muted-copy">没有匹配条目</span>';
}

async function solveProblemUI() {
  const question = $('#problem-input').value.trim();
  if (question.length < 5) { toast('请先输入完整题目或已知量。','error'); return; }
  const button = $('#solve-button'); setBusy(button,true);
  try {
    let result = solveCircuitProblem(question);
    if (state.settings?.provider !== 'local-rules' && state.aiStatus.connected) {
      try {
        const knowledgeContext = knowledgeSearch(state.knowledge, question, 6).map((entry) => ({
          title: entry.title,
          content: entry.content || entry.summary || '',
          pageStart: null,
          pageEnd: null,
          authorityTier: entry.level === '进阶' ? 'A' : '',
        }));
        const aiResult = await desktop.solveProblem({ question, localResult: result, knowledgeContext });
        if (aiResult) {
          result.explanation = aiResult.explanation || aiResult.summary || '';
          result.modelAdvice = aiResult.modelAdvice;
          result.warnings = [...new Set([...(result.warnings || []), ...(aiResult.warnings || [])])];
        }
      } catch (error) {
        console.warn('扩展 AI 讲解不可用：', error);
        toast('扩展 AI 讲解暂不可用，已保留本地公式求解结果。','error');
      }
    }
    renderSolver(result);
    toast(result.kind === 'needs-ai' ? '需要补充条件后才能给出可信数值。' : '题目已完成公式复核。', result.kind === 'needs-ai' ? 'error':'success');
  } finally { setBusy(button,false); }
}

function optimizerInput() {
  const source = $('input[name="opt-source"]:checked').value;
  if (source === 'plan' && state.plan) {
    return {
      components: (state.plan.components||[]).map((item)=>({ ...item, type: item.ref?.startsWith('C')?'capacitor':item.ref?.startsWith('U')?'ic':item.ref?.startsWith('J')?'connector':'' })),
      wires: (state.plan.connections||[]).map((text,index)=>({id:`plan-wire-${index}`,text})),
    };
  }
  return projectForAnalysis();
}

function renderOptimizer(report) {
  $('#optimizer-placeholder').classList.add('hidden');
  $('#optimizer-report').classList.remove('hidden');
  $('#optimizer-grade').textContent = report.grade;
  const labels = {high:'高优先级',medium:'中优先级',low:'建议'};
  $('#optimizer-report').innerHTML = `<div class="optimization-score"><b>${report.score}</b><div><span>${esc(report.grade)}</span><small>${report.stats.components} 个元件 · ${report.stats.wires} 条连线 · ${report.stats.goals} 个优化目标</small></div></div><div class="recommendation-list">${report.recommendations.map((item)=>`<article class="recommendation-card"><span class="priority-badge ${item.priority}">${labels[item.priority]}</span><div><h4>${esc(item.area)} · ${esc(item.title)}</h4><p>${esc(item.detail)}</p>${item.tradeoff?`<small>权衡：${esc(item.tradeoff)}</small>`:''}</div></article>`).join('')}</div><div class="boundary-note"><span>${iconMarkup('alert')}</span><p>${esc(report.disclaimer)}</p></div>`;
}

function runOptimizer() {
  if (agentRun.active?.status === 'running') return;
  const source = $('input[name="opt-source"]:checked').value;
  if (source === 'plan' && !state.plan) { toast('还没有智能生成方案，请先生成或改选工作室项目。','error'); return; }
  const goals = $$('.goal-grid input:checked').map((input)=>input.value);
  const input = optimizerInput();
  if (!input.components.length) { toast('分析对象为空，请先在工作室放置元件或生成方案。','error'); return; }
  if (!agentRun.begin('审查当前电路', [['snapshot', '读取电路快照'], ['review', '连接与可靠性审查']])) return;
  agentRunTotal += 1;
  void persistAgentSession();
  try {
    agentRun.stage('snapshot', 'completed', `${input.components.length} 个元件 · ${input.wires.length} 条连接`);
    agentRun.stage('review', 'running', '执行本地检查，不修改电路');
    const report = optimizeCircuit(input, goals);
    const resultSnapshot = agentResultSnapshot('optimizer', { report });
    renderOptimizer(report);
    agentRun.stage('review', 'completed', `${report.recommendations.length} 条建议`);
    agentRun.finish(`${report.grade} · ${report.recommendations.length} 条建议；当前电路未修改。`, { page: 'optimizer', result: resultSnapshot });
    toast('优化报告已生成；高优先级项目应先处理。');
  } catch (error) {
    agentRun.finish(error.message, { failed: true, page: 'optimizer' });
    toast(error.message, 'error');
  }
}

function startWireDraft(component,pinId) {
  const pin=component&&componentTerminalPoints(component).find((item)=>item.id===pinId);
  if (!pin) return null;
  const axis=Math.abs(pin.normal?.[1]||0)>Math.abs(pin.normal?.[0]||0)?'vertical':'horizontal';
  state.editor.wireDraft={points:[[pin.x,pin.y]],axis};
  return state.editor.wireDraft;
}

function wireDraftPreviewEnd(point) {
  return point?[point.x,point.y]:null;
}

function wireDraftCorner(point) {
  const draft=state.editor.wireDraft;
  const last=draft?.points?.at(-1);
  if (!last) return null;
  return draft.axis==='horizontal'?[point.x,last[1]]:[last[0],point.y];
}

function wireDraftPreviewPoints(point) {
  const draft=state.editor.wireDraft;
  const corner=wireDraftCorner(point);
  const end=wireDraftPreviewEnd(point);
  if (!draft||!corner||!end) return [];
  return [...structuredClone(draft.points),corner,end]
    .filter((item,index,items)=>!index||Math.abs(item[0]-items[index-1][0])>.001||Math.abs(item[1]-items[index-1][1])>.001);
}

function commitWireDraftPoint(point) {
  const draft=state.editor.wireDraft;
  const next=wireDraftCorner(point);
  const last=draft?.points?.at(-1);
  if (!draft||!next||!last||Math.hypot(next[0]-last[0],next[1]-last[1])<1) return false;
  draft.points.push([Math.round(next[0]*100)/100,Math.round(next[1]*100)/100]);
  draft.axis=draft.axis==='horizontal'?'vertical':'horizontal';
  renderEditor();
  $('#grid-status').textContent=`转角已放置 · 当前绘制${draft.axis==='horizontal'?'水平':'垂直'}线段`;
  return true;
}

function toggleWireDraftAxis() {
  const draft=state.editor.wireDraft;
  if (!draft) return;
  draft.axis=draft.axis==='horizontal'?'vertical':'horizontal';
  renderEditor();
  $('#grid-status').textContent=`已切换为${draft.axis==='horizontal'?'水平':'垂直'}线段`;
}

function completionPointsForTarget(targetPin) {
  const draft=state.editor.wireDraft;
  const last=draft?.points?.at(-1);
  if (!draft||!last||!targetPin) return null;
  const target=[targetPin.x,targetPin.y];
  const corner=draft.axis==='horizontal'?[target[0],last[1]]:[last[0],target[1]];
  return [...structuredClone(draft.points),corner,target]
    .filter((item,index,items)=>!index||Math.abs(item[0]-items[index-1][0])>.001||Math.abs(item[1]-items[index-1][1])>.001);
}

function wireTargetAtClientPoint(event, start = wireStartDetails()) {
  // 命中圈半径 14px，而密集引脚元件（USB/排针/传感器等）引脚间距只有 12px：
  // 相邻引脚的透明命中圈会盖住点击点。因此 elementFromPoint 命中的引脚必须
  // 真的贴着点击点（≤7px），否则交给按画布距离的精确扫描，最近的引脚获胜。
  const node = document.elementFromPoint?.(event.clientX,event.clientY) || event.target;
  const control = node?.closest?.('.editor-pin-control');
  const componentId = control?.dataset.componentId;
  const pinId = control?.dataset.pinId;
  if (componentId&&pinId&&(!start||canConnectEditorPins(start,{componentId,pinId}))) {
    const component = componentById(componentId);
    const pin = component && componentTerminalPoints(component).find((item)=>item.id===pinId);
    const hitCanvas=$('#editor-canvas');
    const hitMatrix=hitCanvas.getScreenCTM?.();
    let clientDistance = Number.POSITIVE_INFINITY;
    if (component&&pin&&hitMatrix) {
      const hitPoint=hitCanvas.createSVGPoint();
      hitPoint.x=pin.x;
      hitPoint.y=pin.y;
      const clientPoint=hitPoint.matrixTransform(hitMatrix);
      clientDistance=Math.hypot(event.clientX-clientPoint.x,event.clientY-clientPoint.y);
    }
    if (component&&pin&&clientDistance<=7) return {componentId,pinId,pin,distancePx:0};
  }

  const canvas=$('#editor-canvas');
  const matrix=canvas.getScreenCTM?.();
  if (!matrix||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY)) return null;
  return state.editor.components.reduce((nearest,component)=>{
    return componentTerminalPoints(component).reduce((best,pin)=>{
      const target={componentId:component.id,pinId:pin.id};
      if (start&&!canConnectEditorPins(start,target)) return best;
      const svgPoint=canvas.createSVGPoint();
      svgPoint.x=pin.x;
      svgPoint.y=pin.y;
      const clientPoint=svgPoint.matrixTransform(matrix);
      const distancePx=Math.hypot(event.clientX-clientPoint.x,event.clientY-clientPoint.y);
      if (distancePx>WIRE_PIN_SNAP_RADIUS_PX||(best&&best.distancePx<=distancePx)) return best;
      return {...target,pin,distancePx};
    },nearest);
  },null);
}

function updateWireHover(target) {
  state.editor.wireHover = target ? {componentId:target.componentId,pinId:target.pinId,pin:target.pin} : null;
  $$('.editor-component').forEach((node)=>node.classList.toggle('wire-target',node.dataset.id===target?.componentId));
  $$('.editor-pin').forEach((node)=>node.classList.toggle('target',node.dataset.componentId===target?.componentId&&node.dataset.pinId===target?.pinId));
}

function completeEditorWire(toId, toPinId) {
  const start = wireStartDetails();
  const toComponent=componentById(toId);
  const toPin=toComponent&&componentTerminalPoints(toComponent).find((item)=>item.id===toPinId);
  if (!start?.pinId || !toPin || !componentById(start.componentId)) return false;
  if (!canConnectEditorPins(start, {componentId:toId,pinId:toPinId})) {
    toast('只能连接两个不同元件的端点；同一元件的引脚不能互连。','error');
    return false;
  }
  const manualPoints=completionPointsForTarget(toPin);
  const draft = {id:`wire-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,from:start.componentId,fromPin:start.pinId,to:toId,toPin:toPinId,net:'',...(manualPoints?{points:manualPoints}:{})};
  const points = manualPoints||resolveEditorWirePoints(draft,state.editor.components);
  if (points.length < 2) return false;
  pushEditorHistory();
  const [connected] = bindEditorWireEndpoints([{...draft,points}],state.editor.components);
  const crossings=findWireCrossings(connected);
  state.editor.wires.push(connected);
  queueWireCrossingDecisions(connected,crossings);
  state.editor.wireStart=null;
  state.editor.wireDraft=null;
  state.editor.wireHover=null;
  state.editor.selected=toId;
  state.editor.selectedKind='component';
  markEditorDirty();
  return true;
}

function onEditorPointerDown(event) { console.log("TR:down enter", event.pointerId);
  if (window.innerWidth <= 1220 && !$('#studio-layout').classList.contains('properties-collapsed')) {
    setStudioDockCollapsed('properties', true);
    return;
  }
  const pinNode = event.target.closest('.editor-pin-control');
  const wireHandleNode = event.target.closest('.editor-wire-segment-handle');
  const componentNode = pinNode ? editorComponentNode(pinNode.dataset.componentId) : event.target.closest('.editor-component');
  const wireNode = event.target.closest('.editor-wire,.editor-wire-hit');
  console.log("TR:canvasPoint-done");
  const point = canvasPoint(event);
  const canvas = $('#editor-canvas');
  const wantsPan = state.editor.tool === 'pan' || event.button === 1 || (state.editor.spacePressed && event.button === 0);
  if (wantsPan) {
    event.preventDefault();
    console.log("TR:capture-done");
  try { canvas.setPointerCapture?.(event.pointerId); } catch {}
    state.editor.pan = { pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, origin:{...state.editor.viewBox} };
    canvas.classList.add('is-panning');
    return;
  }
  if (event.button !== 0) return;
  event.preventDefault();
  try { canvas.setPointerCapture?.(event.pointerId); } catch {}
  if (wireHandleNode&&state.editor.tool==='select') {
    const wireId=wireHandleNode.dataset.wireId;
    const segmentIndex=Number(wireHandleNode.dataset.segmentIndex);
    state.editor.selected=wireId;
    state.editor.selectedKind='wire';
    beginWireSegmentEdit(wireId,segmentIndex,event);
    renderEditor();
    return;
  }
  if (state.editor.tool==='wire') {
    const start=wireStartDetails();
    const snapTarget=wireTargetAtClientPoint(event,start);
    if (snapTarget) {
      const {componentId:id,pinId}=snapTarget;
      const component=componentById(id);
      if (!start) {
        state.editor.wireStart={componentId:id,pinId};
        state.editor.selected=id;
        state.editor.selectedKind='component';
        startWireDraft(component,pinId);
        state.editor.wireDrag={pointerId:event.pointerId,startClientX:event.clientX,startClientY:event.clientY,moved:false};
        state.editor.wireHover=null;
      } else {
        completeEditorWire(id,pinId);
      }
      renderEditor();
      return;
    }
  }
  console.log("TR:component-branch");
  if (componentNode) {
    const id = componentNode.dataset.id;
    if (state.editor.tool === 'wire') {
      toast(state.editor.wireStart?'请靠近另一个元件的绿色端点完成连接。':'请从绿色端点附近开始连线。','error');
      return;
    }
    state.editor.selected=id; state.editor.selectedKind='component';
    if (state.editor.tool === 'select') {
      const item=componentById(id);
      state.editor.drag={
        id,
        pointerId:event.pointerId,
        startX:point.x,
        startY:point.y,
        startClientX:event.clientX,
        startClientY:event.clientY,
        originX:item.x,
        originY:item.y,
        snappedX:item.x,
        snappedY:item.y,
        moved:false,
        futureBefore:structuredClone(state.editor.future),
      };
    }
  console.log("TR:before-wire-branch");
    renderEditor(); return;
  }
  if (wireNode && state.editor.tool === 'select') {
    const wireItem=state.editor.wires.find((item)=>item.id===wireNode.dataset.id);
    const segment=wireItem&&closestEditableWireSegment(wireItem,point);
    state.editor.selected=wireNode.dataset.id;
    state.editor.selectedKind='wire';
    if (segment&&segment.distance<=18) beginWireSegmentEdit(wireItem.id,segment.index,event);
    renderEditor();
    return;
  }
  if (state.editor.tool === 'pan') {
    state.editor.pan={startX:event.clientX,startY:event.clientY,origin:{...state.editor.viewBox}}; return;
  }
  if (state.editor.tool === 'wire') {
    if (state.editor.wireStart&&commitWireDraftPoint(point)) return;
    toast(state.editor.wireStart?'终点必须是另一个元件的绿色标记点；按 Esc 可取消。':'请先点击一个元件的绿色标记点。','error');
    renderEditor();
    return;
  }
  state.editor.selected=null; state.editor.selectedKind=''; state.editor.wireStart=null; state.editor.wireHover=null; renderEditor();
}

function onEditorPointerMove(event) {
  const point = canvasPoint(event);
  $('#canvas-coordinates').textContent=`X ${Math.round(point.x)} · Y ${Math.round(point.y)}`;
  if (updateWireSegmentEdit(event)) return;
  const wireDrag = state.editor.wireDrag;
  if (wireDrag && wireDrag.pointerId === event.pointerId && !wireDrag.moved) {
    const distance = Math.hypot(event.clientX-wireDrag.startClientX,event.clientY-wireDrag.startClientY);
    if (distance >= 4) {
      wireDrag.moved=true;
      $('#editor-canvas').classList.add('is-wire-dragging');
      $('#grid-status').textContent='拖到目标元件或引脚后松开';
    }
  }
  if (state.editor.drag) {
    const drag = state.editor.drag;
    if (drag.pointerId !== event.pointerId) return;
    const item=componentById(drag.id); if (!item) return;
    if (!drag.moved) {
      const distance = Math.hypot(event.clientX-drag.startClientX,event.clientY-drag.startClientY);
      if (distance < 3) return;
      pushEditorHistory();
      drag.moved=true;
      $('#editor-canvas').classList.add('is-dragging');
    }
    const position = calculateEditorDragPosition({
      originX:drag.originX,
      originY:drag.originY,
      startX:drag.startX,
      startY:drag.startY,
      currentX:point.x,
      currentY:point.y,
      minX:Number.NEGATIVE_INFINITY,
      maxX:Number.POSITIVE_INFINITY,
      minY:Number.NEGATIVE_INFINITY,
      maxY:Number.POSITIVE_INFINITY,
    });
    item.x=position.x;
    item.y=position.y;
    drag.snappedX=position.snappedX;
    drag.snappedY=position.snappedY;
    updateEditorDragPreview(item,position);
  } else if (state.editor.pan) {
    if (state.editor.pan.pointerId !== event.pointerId) return;
    const rect=$('#editor-canvas').getBoundingClientRect();
    const dx=(event.clientX-state.editor.pan.startX)*state.editor.viewBox.w/rect.width;
    const dy=(event.clientY-state.editor.pan.startY)*state.editor.viewBox.h/rect.height;
    state.editor.viewBox.x=state.editor.pan.origin.x-dx;
    state.editor.viewBox.y=state.editor.pan.origin.y-dy;
    syncEditorViewport();
    $('#grid-status').textContent='正在移动无限画布';
  } else if (state.editor.tool === 'wire' && state.editor.wireStart) {
    const start = wireStartDetails();
    const component = componentById(start?.componentId);
    const pin = component && componentTerminalPoints(component).find((item) => item.id === start.pinId);
    if (pin) {
      const hoveredTarget = wireTargetAtClientPoint(event,start);
      const target = hoveredTarget&&completionPointsForTarget(hoveredTarget.pin)?hoveredTarget:null;
      updateWireHover(target);
      const draftEnd=wireDraftPreviewEnd(point)||[pin.x,pin.y];
      const previewPoints=(target?completionPointsForTarget(target.pin):[...structuredClone(state.editor.wireDraft?.points||[[pin.x,pin.y]]),draftEnd])
        .filter((item,index,items)=>!index||item[0]!==items[index-1][0]||item[1]!==items[index-1][1]);
      const previewEndPoint=target?[target.pin.x,target.pin.y]:draftEnd;
      const endX=previewEndPoint[0],endY=previewEndPoint[1];
      let preview = $('#editor-overlay-layer .wire-preview');
      if (!preview) {
        preview = document.createElementNS('http://www.w3.org/2000/svg','polyline');
        preview.setAttribute('class','wire-preview');
        $('#editor-overlay-layer').append(preview);
      }
      preview.setAttribute('points',previewPoints.map((item)=>item.join(',')).join(' '));
      let previewEnd=$('#editor-overlay-layer .wire-preview-end');
      if (!previewEnd) {
        previewEnd=document.createElementNS('http://www.w3.org/2000/svg','circle');
        previewEnd.setAttribute('class','wire-preview-end');
        previewEnd.setAttribute('r','7');
        $('#editor-overlay-layer').append(previewEnd);
      }
      previewEnd.setAttribute('cx',endX);
      previewEnd.setAttribute('cy',endY);
      $('#grid-status').textContent = target
        ? `已吸附 ${componentById(target.componentId)?.ref || '目标'} 的绿色端点 · 点击或松开完成`
        : `正在绘制${state.editor.wireDraft?.axis==='horizontal'?'水平':'垂直'}线段 · 靠近绿色端点自动吸附`;
    }
  } else if (state.editor.tool === 'wire') {
    const target = wireTargetAtClientPoint(event,null);
    updateWireHover(target);
    $('#grid-status').textContent = target
      ? `已吸附 ${componentById(target.componentId)?.ref || '元件'} 的绿色端点 · 按下开始连线`
      : '连线 · 靠近绿色端点即可吸附';
  }
}

function onEditorWheel(event) {
  event.preventDefault();
  if (event.ctrlKey||event.metaKey) {
    const anchor=canvasPoint(event);
    setStudioZoom(state.editor.zoom*Math.exp(-event.deltaY*.0015),anchor);
    $('#grid-status').textContent='围绕指针缩放画布';
    return;
  }
  const rect=$('#editor-canvas').getBoundingClientRect();
  const unit=event.deltaMode===1?16:event.deltaMode===2?rect.height:1;
  const horizontal=(event.deltaX+(event.shiftKey?event.deltaY:0))*unit;
  const vertical=(event.shiftKey?0:event.deltaY)*unit;
  state.editor.viewBox.x+=horizontal*state.editor.viewBox.w/rect.width;
  state.editor.viewBox.y+=vertical*state.editor.viewBox.h/rect.height;
  syncEditorViewport();
  $('#grid-status').textContent='无限网格 · 滚轮移动视角';
}

function finishEditorPointer(event, cancelled = false) {
  const drag = state.editor.drag;
  const pan = state.editor.pan;
  const wireDrag = state.editor.wireDrag;
  const wireEdit = state.editor.wireEdit;
  if (wireEdit&&wireEdit.pointerId===event.pointerId) {
    const wireItem=state.editor.wires.find((item)=>item.id===wireEdit.wireId);
    if (wireItem&&wireEdit.moved) {
      if (cancelled) {
        if (wireEdit.originalStoredPoints) wireItem.points=wireEdit.originalStoredPoints;
        else delete wireItem.points;
        state.editor.history.pop();
        state.editor.future=wireEdit.futureBefore;
      } else {
        wireItem.crossings=[];
        queueWireCrossingDecisions(wireItem,findWireCrossings(wireItem));
        markEditorDirty();
      }
    }
    state.editor.wireEdit=null;
    $('#editor-canvas').classList.remove('is-wire-editing');
    renderEditor();
  }
  if (wireDrag && wireDrag.pointerId === event.pointerId) {
    let completed = false;
    if (cancelled) { state.editor.wireStart=null; state.editor.wireDraft=null; }
    else if (wireDrag.moved) {
      const target = wireTargetAtClientPoint(event,wireStartDetails());
      if (target) completed=completeEditorWire(target.componentId,target.pinId);
    }
    state.editor.wireDrag=null;
    if (!completed) state.editor.wireHover=null;
    $('#editor-canvas').classList.remove('is-wire-dragging');
    renderEditor();
    if (completed) toast('连线已建立，端点已绑定到元件引脚。');
    else if (wireDrag.moved && !cancelled) $('#grid-status').textContent='未进入端点吸附范围 · 起点已保留，可继续点击终点';
  }
  if (drag && drag.pointerId === event.pointerId) {
    const item = componentById(drag.id);
    if (item && drag.moved) {
      if (cancelled) {
        item.x=drag.originX;
        item.y=drag.originY;
        state.editor.history.pop();
        state.editor.future=drag.futureBefore;
      } else {
        item.x=drag.snappedX;
        item.y=drag.snappedY;
        markEditorDirty();
      }
    }
    clearEditorPointerVisuals();
    state.editor.drag=null;
    renderEditor();
  }
  if (pan && pan.pointerId === event.pointerId) {
    if (cancelled) state.editor.viewBox={...pan.origin};
    state.editor.pan=null;
    $('#editor-canvas').classList.remove('is-panning');
    syncEditorViewport();
    $('#grid-status').textContent='无限网格 · 滚轮移动视角';
  }
  try { $('#editor-canvas').releasePointerCapture?.(event.pointerId); } catch {}
}

function onEditorPointerUp(event) {
  finishEditorPointer(event,false);
}

function onEditorPointerCancel(event) {
  finishEditorPointer(event,true);
}

let studioNarrowViewport = null;
function setStudioDockCollapsed(kind, collapsed) {
  if (!['inventory', 'properties'].includes(kind)) return;
  $('#studio-layout').classList.toggle(`${kind}-collapsed`, collapsed);
  $(`#restore-${kind}`).classList.toggle('hidden', !collapsed);
}

function syncResponsiveStudioDocks(force = false) {
  const narrow = window.innerWidth <= 1220;
  if (narrow && (force || studioNarrowViewport !== true)) setStudioDockCollapsed('properties', true);
  studioNarrowViewport = narrow;
}

function bindEvents() {
  $('#open-agent').addEventListener('click', () => navigate('agent'));
  $('#agent-run').addEventListener('click', () => generate('agent'));
  $('#agent-prompt').addEventListener('input', (event) => { $('#agent-input-count').textContent = `${event.target.value.length} / 1200 · Ctrl + Enter 运行`; });
  $('#agent-prompt').addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); generate('agent'); } });
  $$('[data-agent-prompt]').forEach((button) => button.addEventListener('click', () => { $('#agent-prompt').value = button.dataset.agentPrompt; $('#agent-prompt').dispatchEvent(new Event('input')); $('#agent-prompt').focus(); }));
  $$('[data-agent-go]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.agentGo)));
  $('#agent-view-result').addEventListener('click', () => restoreAgentResult(agentRun.active));
  $('#agent-review-project').addEventListener('click', () => {
    const radio = $('input[name="opt-source"][value="project"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    runOptimizer();
  });
  $('#agent-export-history').addEventListener('click', async () => {
    try {
      const result = await desktop.saveExport({ title: '导出 Agent 会话记录', defaultName: 'agent-session.json', filters: [{ name: 'JSON', extensions: ['json'] }], data: JSON.stringify({ ...agentRun.serialize(agentRunTotal), exportedAt: new Date().toISOString() }, null, 2) });
      if (!result.canceled) toast('运行记录已导出。');
    } catch (error) { toast(error.message, 'error'); }
  });
  $('#agent-clear-history').addEventListener('click', async () => {
    if (!agentRun.history.length || !window.confirm('确定清空本机 Agent 运行记录吗？此操作不可撤销。')) return;
    agentRunTotal = 0;
    agentRun.clear();
    await persistAgentSession({ force: true });
    toast('本机运行记录已清空。');
  });
  $('#agent-history').addEventListener('click', (event) => {
    const button = event.target.closest('[data-agent-history-id]');
    if (!button) return;
    const entry = agentRun.history.find((item) => item.id === button.dataset.agentHistoryId);
    if (!entry || !agentRun.select(entry.id)) return;
    if (entry.result) restoreAgentResult(entry);
    else $('.agent-run-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
  $('[data-go="settings"]').addEventListener('click', () => navigate('settings'));
  $('#open-settings').addEventListener('click', () => navigate('settings'));
  $('#requirement-input').addEventListener('input', (event) => { event.target.value = event.target.value.slice(0,1200); $('#character-count').textContent = `${event.target.value.length} / 1200`; });
  $$('.quick-examples button').forEach((button) => button.addEventListener('click', () => { $('#requirement-input').value = button.dataset.example; $('#requirement-input').dispatchEvent(new Event('input')); }));
  $('#generate-button').addEventListener('click', generate);
  $('#requirement-input').addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') generate(); });
  $('#apply-revision').addEventListener('click', applyRevision);
  $('#revision-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') applyRevision(); });
  $$('.revision-examples button').forEach((button) => button.addEventListener('click', () => { $('#revision-input').value = button.dataset.revision; $('#revision-input').focus(); }));
  $('#export-svg').addEventListener('click', () => exportData('svg'));
  $('#export-bom').addEventListener('click', () => exportData('bom'));
  $('#export-bundle').addEventListener('click', () => exportData('bundle'));
  $('#send-to-studio').addEventListener('click', sendPlanToStudio);
  $('#zoom-in').addEventListener('click', () => updateZoom(.1));
  $('#zoom-out').addEventListener('click', () => updateZoom(-.1));
  $$('.tabbar button').forEach((button) => button.addEventListener('click', () => { $$('.tabbar button').forEach((item) => item.classList.toggle('active', item === button)); $$('.inspector-content').forEach((item) => item.classList.toggle('active', item.id === `inspector-${button.dataset.inspector}`)); }));

  $('#image-input').addEventListener('change', (event) => setImage(event.target.files[0]));
  $('#clear-image').addEventListener('click', (event) => { event.preventDefault(); clearImage(); });
  $('#analyze-button').addEventListener('click', analyzeImage);
  const drop = $('#drop-zone');
  ['dragenter','dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave','drop'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (event) => setImage(event.dataTransfer.files[0]));

  // Interactive circuit studio
  renderAllInventories();
  $('#component-search').addEventListener('input', renderAllInventories);
  $('#inventory-market').addEventListener('click',(event)=>{
    const groupButton=event.target.closest('[data-market-group]');
    if(groupButton){
      marketGroup=groupButton.dataset.marketGroup;
      renderMarketInventory();
      return;
    }
    const sourceButton=event.target.closest('[data-source]');
    if(sourceButton?.dataset.source) desktop.openExternal(sourceButton.dataset.source);
  });
  $$('.inventory-tabs button').forEach((button)=>button.addEventListener('click',()=>{
    $$('.inventory-tabs button').forEach((item)=>item.classList.toggle('active',item===button));
    $$('.inventory-content').forEach((item)=>item.classList.toggle('active',item.id===`inventory-${button.dataset.inventoryTab}`));
  }));
  $$('.property-tabs button').forEach((button)=>button.addEventListener('click',()=>{
    $$('.property-tabs button').forEach((item)=>item.classList.toggle('active',item===button));
    $$('.property-content').forEach((item)=>item.classList.toggle('active',item.id===(button.dataset.propertyTab==='properties'?'property-editor':'project-checks')));
  }));
  $$('.canvas-tool').forEach((button)=>button.addEventListener('click',()=>setEditorTool(button.dataset.tool)));
  $('#rotate-component').addEventListener('click',rotateEditorSelection);
  $('#delete-component').addEventListener('click',deleteEditorSelection);
  $('#undo-editor').addEventListener('click',undoEditor);
  $('#redo-editor').addEventListener('click',redoEditor);
  $('#studio-zoom-in').addEventListener('click',()=>updateStudioZoom(.15));
  $('#studio-zoom-out').addEventListener('click',()=>updateStudioZoom(-.15));
  $('#fit-canvas').addEventListener('click',fitStudioCanvas);
  $('#new-project').addEventListener('click',()=>blankProject(false));
  $('#save-project').addEventListener('click',saveCurrentProject);
  $('#export-project-svg').addEventListener('click',exportStudioSvg);
  $('#export-project').addEventListener('click',exportStudioProject);
  $('#project-name').addEventListener('input',(event)=>{state.editor.name=event.target.value.trim()||'未命名电路';markEditorDirty();});
  const stage=$('#drawing-stage');
  stage.addEventListener('dragover',(event)=>{event.preventDefault();event.dataTransfer.dropEffect='copy';});
  stage.addEventListener('drop',(event)=>{
    event.preventDefault();
    const partId=event.dataTransfer.getData('application/x-circuit-part');
    const point=canvasPoint(event);
    if (partId) {
      const part=marketPartById(partId);
      if (part) placeMarketPart(part,point.x,point.y);
      return;
    }
    const type=event.dataTransfer.getData('application/x-circuit-component');
    if(type)addEditorComponent(type,point.x,point.y);
  });
  const editorCanvas=$('#editor-canvas');
  editorCanvas.addEventListener('pointerdown',onEditorPointerDown);
  editorCanvas.addEventListener('pointermove',onEditorPointerMove);
  editorCanvas.addEventListener('pointerup',onEditorPointerUp);
  editorCanvas.addEventListener('pointercancel',onEditorPointerCancel);
  editorCanvas.addEventListener('wheel',onEditorWheel,{passive:false});
  $$('[data-crossing-choice]').forEach((button)=>button.addEventListener('click',()=>resolvePendingWireCrossing(button.dataset.crossingChoice==='connected')));
  $('#wire-crossing-dialog').addEventListener('cancel',(event)=>{event.preventDefault();resolvePendingWireCrossing(false);});
  $$('.dock-toggle').forEach((button)=>button.addEventListener('click',()=>{
    setStudioDockCollapsed(button.dataset.dock, true);
  }));
  $('#restore-inventory').addEventListener('click',()=>setStudioDockCollapsed('inventory', false));
  $('#restore-properties').addEventListener('click',()=>setStudioDockCollapsed('properties', false));
  $('#inventory-projects').addEventListener('click',async(event)=>{
    const deleteButton=event.target.closest('[data-delete-project]');
    if(deleteButton){event.stopPropagation();const id=deleteButton.dataset.deleteProject;if(window.confirm('确定删除这个本地项目吗？此操作不可撤销。')){state.projects=await desktop.deleteProject(id);renderProjectInventory();toast('项目已删除。');}return;}
    const item=event.target.closest('[data-project-id]');if(item){const project=state.projects.find((entry)=>entry.id===item.dataset.projectId);if(project)loadProject(project);}
  });
  window.addEventListener('keydown',(event)=>{
    if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return;
    if (!$('#page-studio').classList.contains('active')) return;
    if(event.key==='Escape' && state.editor.wireEdit){event.preventDefault();finishEditorPointer({pointerId:state.editor.wireEdit.pointerId},true);}
    else if(event.key==='Escape' && state.editor.drag){event.preventDefault();finishEditorPointer({pointerId:state.editor.drag.pointerId},true);}
    else if(event.key==='Escape' && state.editor.wireDrag){event.preventDefault();finishEditorPointer({pointerId:state.editor.wireDrag.pointerId},true);}
    else if(event.key==='Escape' && state.editor.wireStart){event.preventDefault();state.editor.wireStart=null;state.editor.wireDraft=null;state.editor.wireHover=null;renderEditor();}
    else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();undoEditor();}
    else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();redoEditor();}
    else if(event.key==='Delete'||event.key==='Backspace') deleteEditorSelection();
    else if(event.key.toLowerCase()==='r') rotateEditorSelection();
    else if(event.key.toLowerCase()==='w') setEditorTool('wire');
    else if(event.key.toLowerCase()==='v') setEditorTool('select');
    else if(event.key.toLowerCase()==='h') setEditorTool('pan');
    else if(event.code==='Space' && state.editor.wireStart){event.preventDefault();toggleWireDraftAxis();}
    else if(event.code==='Space'){
      event.preventDefault();
      state.editor.spacePressed=true;
      $('#editor-canvas').classList.add('space-pan-ready');
      $('#grid-status').textContent='按住空格并拖拽可移动无限画布';
    }
  });
  window.addEventListener('resize',()=>syncResponsiveStudioDocks(false));
  window.addEventListener('keyup',(event)=>{
    if(event.code!=='Space') return;
    state.editor.spacePressed=false;
    $('#editor-canvas').classList.remove('space-pan-ready');
    if(!state.editor.pan) $('#grid-status').textContent='无限网格 · 滚轮移动视角';
  });
  window.addEventListener('blur',()=>{
    state.editor.spacePressed=false;
    $('#editor-canvas').classList.remove('space-pan-ready');
  });

  // Problem solver
  $$('.solver-examples button').forEach((button)=>button.addEventListener('click',()=>{$('#problem-input').value=button.dataset.problem;}));
  $('#solve-button').addEventListener('click',solveProblemUI);
  $('#problem-input').addEventListener('keydown',(event)=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter')solveProblemUI();});
  $('#solver-knowledge-matches').addEventListener('click',(event)=>{const button=event.target.closest('[data-knowledge-query]');if(button){$('#knowledge-search').value=button.dataset.knowledgeQuery;state.knowledgeLevel='全部';renderKnowledge();navigate('knowledge');}});

  // Circuit optimizer
  $$('input[name="opt-source"]').forEach((radio)=>radio.addEventListener('change',()=>{$$('.optimization-source label').forEach((label)=>label.classList.toggle('selected',$('input',label).checked));}));
  $('#optimize-button').addEventListener('click',runOptimizer);

  $('#import-knowledge').addEventListener('click', () => importKnowledge('files'));
  $('#import-knowledge-folder').addEventListener('click', () => importKnowledge('folder'));
  $('#knowledge-search').addEventListener('input', () => { renderKnowledge(); scheduleKnowledgeSearch(); });
  $('#knowledge-filters').addEventListener('click', (event) => { const button=event.target.closest('[data-category]'); if(button){ state.knowledgeCategory=button.dataset.category; renderKnowledge(); } });
  $('#knowledge-levels').addEventListener('click',(event)=>{const button=event.target.closest('[data-level]');if(button){state.knowledgeLevel=button.dataset.level;state.knowledgeCategory='全部';renderKnowledge();}});
  $('#retrieval-strength').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-strength]');
    if (!button || button.dataset.strength === state.settings?.retrievalStrength) return;
    state.settings = { ...(state.settings || {}), retrievalStrength: button.dataset.strength };
    $('#retrieval-strength-select').value = button.dataset.strength;
    syncRetrievalStrengthUI();
    try {
      state.settings = await desktop.saveSettings(collectSettings());
      toast(`智能体检索强度已切换为${RETRIEVAL_STRENGTH_LABELS[button.dataset.strength]}。`);
    } catch (error) {
      toast(`检索强度保存失败：${error.message}`, 'error');
    }
    scheduleKnowledgeSearch();
  });
  $('#knowledge-list').addEventListener('click', (event) => { const button=event.target.closest('[data-source]'); if(button?.dataset.source) desktop.openExternal(button.dataset.source); });
  $('#result-shell').addEventListener('click', (event) => { const button=event.target.closest('[data-plan-source]'); if(button?.dataset.planSource) desktop.openExternal(button.dataset.planSource); });

  $$('input[name="provider"]').forEach((radio) => radio.addEventListener('change', () => selectProvider(radio.value)));
  $('#save-settings').addEventListener('click', () => saveSettings(true));
  $('#test-provider').addEventListener('click', async () => { const button=$('#test-provider'); setBusy(button,true); if(await saveSettings(false)){ await refreshStatus(); toast(state.aiStatus.connected ? `连接成功：${state.aiStatus.detail}` : `连接失败：${state.aiStatus.detail}`, state.aiStatus.connected ? 'success':'error'); } setBusy(button,false); });
}

async function init() {
  bindEvents();
  try {
    const [settings, , projects, agentSessionResult] = await Promise.all([
      desktop.getSettings(),
      loadKnowledge(),
      desktop.listProjects(),
      desktop.getAgentSession().then((value) => ({ value }), (error) => ({ error })),
    ]);
    state.projects = projects || [];
    applySettings(settings);
    renderProjectInventory();
    blankProject(true);
    syncResponsiveStudioDocks(true);
    await refreshStatus();
    let restoration = { totalRuns: 0, interrupted: false };
    if (agentSessionResult.error) {
      toast(`运行记录未能读取，原文件已保留：${agentSessionResult.error.message}`, 'error');
    } else {
      restoration = agentRun.restore(agentSessionResult.value);
      agentRunTotal = restoration.totalRuns;
    }
    agentPersistenceReady = true;
    renderAgentWorkspace();
    if (restoration.interrupted) {
      await persistAgentSession({ force: true });
      toast('检测到上次未完成的任务，已标记为中断，可从历史记录重新查看。', 'error');
    }
    navigate('agent');
  } catch (error) {
    toast(`初始化失败：${error.message}`, 'error');
  } finally {
    document.body.dataset.appReady = 'true';
  }
}

init();
