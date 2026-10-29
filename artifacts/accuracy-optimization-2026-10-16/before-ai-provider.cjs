const TEXT_SYSTEM_PROMPT = `你是“电路助手”的资深电路工程审阅智能体，具备电源、模拟、数字、电机驱动、接口保护与 PCB 布局经验。你的职责是审阅由确定性计算和可追溯知识生成的参数化草案，只补充工程判断，不得覆盖本地公式结果、连接或 BOM。

审查协议（按顺序执行）：
1. 意图与拓扑匹配：先判断所选拓扑是否真的满足需求（方向、双向能力、隔离、动态范围）；不匹配时必须在 warnings 中明确指出更合适的拓扑家族。
2. 证据分级：器件数据手册为最高优先级；其次是厂商应用笔记/行业标准，再其次是教科书公式；仅凭经验假设得到的结论必须标注 evidence=assumption。不得编造型号、额定值、标准限值或来源。
3. 最坏工况清单：绝对最大额定值、持续/峰值电流与 SOA、功耗与结温（θJA）、输入反接、浪涌/TVS 钳位协调、保险保持与分断能力、去耦与回流路径、容差/漂移/温度、接口 ESD 与 EMI、启动与关断行为。
4. 安全门禁：涉及市电、高压（>60V DC/25V AC）、锂电池、大电流（>10A 持续）时必须在 warnings 显著警告并要求合格工程师复核，不得给出可投板结论。
5. 不确定处理：缺少数据手册或关键输入时把相关 worstCaseChecks 状态写为 unknown，并把它列入 mustConfirm；不要用“通常”“大概”伪称已验证。
6. 只输出 JSON，不要 Markdown。字段值使用简体中文，数值保留单位。`;

const VISION_SYSTEM_PROMPT = `你是“电路助手”的电路图视觉分析智能体。识别输入中的原理图、手绘电路或 PCB 截图。分析时遵循：
1. 先描述可见结构（电源入口、储能、开关/放大器件、负载、接口），再推断功能；结构与功能结论分离。
2. 明确区分“清晰可读”与“推测”：模糊文字不得猜成确定型号，写进 uncertainties。
3. 给出识别依据（图形特征、标号、走线），方便人工复核。
4. 涉及市电、高压、锂电时在 risks 中显著提示。
只输出 JSON，不要 Markdown。`;

const SOLVER_SYSTEM_PROMPT = `你是“电路助手”的电路题目解析智能体。你的职责是把自然语言题目转换为已知量、未知量、拓扑和可复核的计算步骤。规则：
1. 逐条列出已知量（含单位换算过程）；缺失的关键条件不得假设，必须写入 warnings 并说明它影响哪一步。
2. 本地求解器已有可靠数值时，不要改写数值，只补充讲解、适用边界和常见错误。
3. 讲解要面向学习者：先说公式来自什么约束（如 KCL、分压、时间常数），再代入，最后核对量纲和合理性。
只输出 JSON，不要 Markdown。`;

// 领域审查指南：把常见电路族的“必查项”压缩成可执行清单，注入生成/审阅提示词。
const CIRCUIT_DOMAIN_GUIDE = `领域审查指南（按需取用，不确定时宁可不写）：
- 开关电源（Buck/Boost）：先核对输入范围与占空比方向；用 Vin 极值 + 电感/容差最小值算 ΔIL 与 Ipeak，对照芯片限流最小值；电感 Isat/Irms 与温升；输出电容按直流偏压后的有效容值算纹波；高 di/dt 热环路最小化、FB Kelvin 取样。
- LDO：压差×电流=损耗，θJA 温升是否可用；输出电容 ESR 稳定区；输入始终高于输出+dropout。
- 电机/H 桥：以实测堵转电流（而非空载电流）为门槛；驱动器峰值电流与持续时间、SOA、保险、铜箔、连接器一致覆盖；死区与直通保护；制动回生能量去向；控制输入默认下拉。
- LED：串联限流按 (Vs−Vf−保护压降)/I 复算，并核对最坏 Vf 时的电流上限；亮度敏感或大电流时改恒流。
- 模拟/运放：输入共模与输出摆幅按实际供电读取；GBW ≥ 闭环带宽×噪声增益×裕量；SR ≥ 2πfVpk；容性负载与相位裕度；偏置电流对高阻节点的影响。
- MCU/数字：每个电源引脚 100 nF 就近回流；复位极性与监控；未用引脚处理；调试接口引出。
- 接口：连接器/线缆是 ESD、浪涌、反接入口；TVS 的 VRWM 高于最高正常电压、钳位低于下游绝对最大值；串阻/滤波按信号速率决定。
- PCB：先识别最坏回路（功率、高频、敏感模拟），再决定布局；载流按铜厚/温升/层位计算而非经验值；参考平面连续。
- 安全：市电/高压/锂电/大电流 = 阻断自动投板，要求隔离、安规距离、BMS/保护与人工签核。`;

function withTimeout(ms = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function validateEndpoint(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackEndpoint(url))) {
    throw new Error('仅允许 HTTPS 远程接口，或本机 localhost/127.0.0.0/8/[::1] HTTP 接口。');
  }
  return trimSlash(parsed.toString());
}

function isLoopbackEndpoint(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol)
      && (['localhost', '[::1]'].includes(parsed.hostname)
        || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname));
  } catch {
    return false;
  }
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

// RAG 上下文打包：把检索片段转成带权威层级、页码的编号资料段，并说明引用要求。
function localKnowledgePrompt(settings, entries) {
  const endpoint = settings.provider === 'ollama' ? settings.ollamaBaseUrl
    : settings.provider === 'openai-compatible' ? settings.remoteBaseUrl : '';
  const staysOnDevice = isLoopbackEndpoint(endpoint);
  const allowRemote = settings.allowRemoteKnowledge === true;
  if (!staysOnDevice && !allowRemote) return '';
  if (!Array.isArray(entries) || !entries.length) return '';
  const maxEntries = Math.round(clampNumber(settings.knowledgeMaxEntries, 12, 4, 20));
  const passages = entries.slice(0, maxEntries).map((entry, index) => {
    const page = entry.pageStart ? `，页码 ${entry.pageStart}${entry.pageEnd && entry.pageEnd !== entry.pageStart ? `-${entry.pageEnd}` : ''}` : '';
    const tier = entry.authorityTier ? `，权威层级 ${entry.authorityTier}` : '';
    const identity = `资料 ${index + 1}：${entry.title || '未命名资料'}${entry.publisher ? `，${entry.publisher}` : ''}${tier}${page}`;
    const kind = entry.rightsStatus && entry.rightsStatus !== 'user-provided' ? `（${entry.rightsStatus}）` : '';
    return `${identity}${kind}\n${String(entry.content || '').slice(0, 2000)}`;
  });
  return `\n\n本机知识库多路检索片段（共 ${passages.length} 条，按相关度融合排序；仅作辅助依据；不得把检索命中误称为已验证结论，不得大段复述原文）：
${passages.join('\n\n')}
引用要求：凡直接使用上述资料得出的判断，必须在 knowledgeCitations 中写明资料编号对应的标题、页码和它支持的具体判断；资料之间冲突时优先权威层级高者并在 warnings 说明冲突；资料未覆盖的部分按通用工程判断并标注 evidence=assumption。`;
}

function stripImagePrefix(value) {
  return String(value || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('AI 返回内容不是有效 JSON。');
  }
}

async function fetchJson(url, options = {}, timeoutMs = 25_000) {
  const timeout = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: timeout.signal, redirect: 'error' });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`AI 接口返回 ${response.status}: ${detail || response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('AI 接口响应超时。');
    throw error;
  } finally {
    timeout.done();
  }
}

function providerOptions(settings) {
  // 温度低一些保证 JSON 稳定；本地模型显式给足上下文窗口，避免 RAG 片段被截断。
  const temperature = clampNumber(settings.aiTemperature, 0.15, 0, 1);
  return {
    temperature,
    ...(settings.provider === 'ollama'
      ? { options: { temperature, top_p: 0.9, num_ctx: Math.round(clampNumber(settings.ollamaNumCtx, 8192, 2048, 32768)) } }
      : {}),
  };
}

async function ollamaChat(settings, messages, images = []) {
  const baseUrl = validateEndpoint(settings.ollamaBaseUrl);
  const payloadMessages = messages.map((message, index) => ({
    ...message,
    ...(images.length && index === messages.length - 1 ? { images } : {}),
  }));
  const body = await fetchJson(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.ollamaModel,
      stream: false,
      format: 'json',
      messages: payloadMessages,
      ...providerOptions(settings),
    }),
  }, 90_000);
  return parseJson(body?.message?.content);
}

async function compatibleChat(settings, messages, imageDataUrl = '') {
  const baseUrl = validateEndpoint(settings.remoteBaseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (settings.remoteApiKey) headers.Authorization = `Bearer ${settings.remoteApiKey}`;
  const mapped = messages.map((message, index) => {
    if (!imageDataUrl || index !== messages.length - 1) return message;
    return {
      ...message,
      content: [
        { type: 'text', text: message.content },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    };
  });
  const body = await fetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: settings.remoteModel, ...providerOptions(settings), messages: mapped }),
  }, 90_000);
  return parseJson(body?.choices?.[0]?.message?.content);
}

function chatWith(settings, messages, images = []) {
  return settings.provider === 'ollama'
    ? ollamaChat(settings, messages, images)
    : compatibleChat(settings, messages);
}

async function getStatus(settings) {
  if (settings.provider === 'local-rules') {
    return { provider: 'local-rules', connected: true, label: '本地规则核心', detail: '完全离线' };
  }
  try {
    if (settings.provider === 'ollama') {
      const baseUrl = validateEndpoint(settings.ollamaBaseUrl);
      const data = await fetchJson(`${baseUrl}/api/tags`, {}, 3_000);
      const models = (data.models || []).map((item) => item.name || item.model);
      return {
        provider: 'ollama', connected: true, label: 'Ollama 本地 AI',
        detail: models.includes(settings.ollamaModel) ? settings.ollamaModel : `已连接；未发现 ${settings.ollamaModel}`,
        models,
      };
    }
    const baseUrl = validateEndpoint(settings.remoteBaseUrl);
    const headers = settings.remoteApiKey ? { Authorization: `Bearer ${settings.remoteApiKey}` } : {};
    await fetchJson(`${baseUrl}/models`, { headers }, 5_000);
    return { provider: 'openai-compatible', connected: true, label: '兼容 AI 接口', detail: settings.remoteModel || '未设置模型' };
  } catch (error) {
    return { provider: settings.provider, connected: false, label: 'AI 未连接', detail: error.message };
  }
}

async function analyzeImage(settings, payload) {
  if (settings.provider === 'local-rules') throw new Error('当前使用本地规则核心，未启用视觉模型。');
  const schema = {
    circuitType: '候选电路类别',
    function: '功能说明',
    confidence: 0.0,
    blocks: ['可见功能模块（电源入口/储能/开关/负载/接口）'],
    components: ['明确可识别的元件或型号'],
    signalFlow: '信号/能量流向',
    evidence: ['图像中的判断依据'],
    uncertainties: ['无法确认的部分'],
    risks: ['设计或安全风险'],
    nextSteps: ['下一步验证建议'],
  };
  const prompt = `分析这张电路图片。文件名：${payload.fileName || '未知'}。结构推断与功能推断分开陈述；不确定的内容一律写入 uncertainties。严格按以下结构返回 JSON：${JSON.stringify(schema)}`;
  const messages = [
    { role: 'system', content: VISION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
  if (settings.provider === 'ollama') {
    return ollamaChat(settings, messages, [stripImagePrefix(payload.imageDataUrl)]);
  }
  return compatibleChat(settings, messages, payload.imageDataUrl);
}

async function enhancePlan(settings, payload) {
  if (settings.provider === 'local-rules') return null;
  const schema = {
    summary: '对方案与需求匹配度的专业判断（2-4 句）',
    topologyAssessment: '拓扑是否满足需求的判断；不满足时给出更合适的拓扑家族',
    assumptions: ['明确假设'],
    mustConfirm: ['定型前必须向用户确认的关键参数；每条要具体、可回答'],
    recommendedParts: [{ role: '用途', criteria: '选型条件（参数门槛而非具体型号）' }],
    designChecks: ['需要计算或仿真的项目'],
    worstCaseChecks: [{ corner: '最坏工况', check: '校核内容', status: 'unknown/pass/warn/fail', evidence: 'datasheet/calculated/simulated/measured/assumption' }],
    validationPlan: ['仿真、限流上电或实测步骤'],
    pcbAdvice: ['布局布线建议'],
    warnings: ['风险'],
    knowledgeCitations: [{ sourceId: 0, title: '本地资料标题', page: '页码或空', claim: '该资料支持的具体判断' }],
  };
  const knowledge = localKnowledgePrompt(settings, payload.knowledgeContext);
  const history = Array.isArray(payload.history) && payload.history.length
    ? `\n修订脉络（最近在前）：${payload.history.slice(0, 4).map((item) => item.request || item).join('；')}`
    : '';
  const prompt = `用户需求：${payload.requirement}${history}\n本地参数化草案（含已匹配知识来源、缺失参数、计算和校核清单）：${JSON.stringify(payload.plan)}\n${CIRCUIT_DOMAIN_GUIDE}${knowledge}\n审阅要求：先判断拓扑与需求是否匹配，再按最坏工况补充本地草案未覆盖的判断。不得改写 equations、components、connections 或 schematic；缺少 mandatory 参数时必须列入 mustConfirm，并把相关 worstCaseChecks 状态写为 unknown。若使用了本机资料中的判断，必须在 knowledgeCitations 中写明资料标题、页码和它支持的具体判断；未使用则返回空数组。mustConfirm 的问题必须让用户可以直接回答。按此结构返回 JSON：${JSON.stringify(schema)}`;
  const messages = [
    { role: 'system', content: TEXT_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
  return chatWith(settings, messages);
}

async function solveProblem(settings, payload) {
  if (settings.provider === 'local-rules') return null;
  const schema = {
    title: '题型', interpretation: '题意解释', knowns: ['已知量（含单位换算）'], formula: '核心公式',
    steps: ['推导步骤'], answer: '答案或无法唯一求解', confidence: 0.0,
    warnings: ['缺失条件或适用边界'], explanation: '面向学习者的简洁讲解：先说公式来源，再代入，最后核对量纲',
  };
  const knowledge = localKnowledgePrompt(settings, payload.knowledgeContext);
  const prompt = `题目：${payload.question}\n本地公式求解器初判：${JSON.stringify(payload.localResult || {})}\n${knowledge}\n请解析题意并复核本地结果。若本地结果已有可靠数值，不要改写数值，只补充讲解、适用边界和常见错误；若条件不足，不得自行假设，必须说明缺什么、影响哪一步。按此结构返回 JSON：${JSON.stringify(schema)}`;
  const messages = [{ role: 'system', content: SOLVER_SYSTEM_PROMPT }, { role: 'user', content: prompt }];
  return chatWith(settings, messages);
}

module.exports = { getStatus, analyzeImage, enhancePlan, solveProblem, validateEndpoint, parseJson, isLoopbackEndpoint, localKnowledgePrompt, CIRCUIT_DOMAIN_GUIDE };
