const RECORD_STATUSES = new Set(['running', 'completed', 'failed']);
const STAGE_STATUSES = new Set(['pending', 'running', 'completed', 'skipped', 'warning', 'failed']);
const HISTORY_LIMIT = 8;

function clone(value, fallback = null) {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  }
}

function text(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  try { return String(value); } catch { return fallback; }
}

function normalizeStage(value, index) {
  if (!value || typeof value !== 'object') return null;
  const status = STAGE_STATUSES.has(value.status) ? value.status : 'skipped';
  return {
    id: text(value.id, `stage-${index + 1}`) || `stage-${index + 1}`,
    label: text(value.label, `步骤 ${index + 1}`) || `步骤 ${index + 1}`,
    status,
    detail: text(value.detail),
  };
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const now = new Date().toISOString();
  const record = {
    id: text(value.id) || globalThis.crypto.randomUUID(),
    title: text(value.title, '未命名任务') || '未命名任务',
    status: RECORD_STATUSES.has(value.status) ? value.status : 'failed',
    startedAt: text(value.startedAt, now) || now,
    stages: (Array.isArray(value.stages) ? value.stages : []).map(normalizeStage).filter(Boolean),
  };
  if (value.summary != null) record.summary = text(value.summary);
  if (value.page != null) record.page = text(value.page, 'designer') || 'designer';
  if (value.endedAt != null) record.endedAt = text(value.endedAt);
  if (value.interrupted === true) record.interrupted = true;
  if (Object.prototype.hasOwnProperty.call(value, 'result')) record.result = clone(value.result);
  return record;
}

function uniqueHistory(records) {
  const seen = new Set();
  const result = [];
  for (const record of records) {
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    result.push(record);
    if (result.length === HISTORY_LIMIT) break;
  }
  return result;
}

function normalizeTotalRuns(value, minimum = 0) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.max(minimum, Math.floor(count)) : minimum;
}

/** Observable tool stages, not autonomous models or a simulated reasoning trace. */
export class AgentRun {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.active = null;
    this.history = [];
  }
  begin(title, stages) {
    if (this.active?.status === 'running') return false;
    this.active = {
      id: globalThis.crypto.randomUUID(), title, status: 'running', startedAt: new Date().toISOString(),
      stages: stages.map(([id, label]) => ({ id, label, status: 'pending', detail: '' })),
    };
    this.onChange(this);
    return true;
  }
  stage(id, status, detail = '') {
    if (this.active?.status !== 'running') throw new Error('没有运行中的任务');
    const stage = this.active.stages.find((item) => item.id === id);
    if (!stage) throw new Error(`未知步骤：${id}`);
    if (!['running', 'completed', 'skipped', 'warning'].includes(status)) throw new Error('非法步骤状态');
    if (status === 'running' && this.active.stages.some((item) => item !== stage && item.status === 'running')) throw new Error('已有步骤执行中');
    stage.status = status;
    stage.detail = String(detail);
    this.onChange(this);
  }
  finish(summary, options = {}) {
    const settings = options && typeof options === 'object' ? options : {};
    const { failed = false, page = 'designer', result } = settings;
    if (this.active?.status !== 'running') throw new Error('没有运行中的任务');
    if (!failed && this.active.stages.some((item) => ['pending', 'running'].includes(item.status))) throw new Error('仍有未完成步骤');
    for (const stage of this.active.stages) {
      if (stage.status === 'running') stage.status = 'failed';
      if (stage.status === 'pending') stage.status = 'skipped';
    }
    Object.assign(this.active, { status: failed ? 'failed' : 'completed', summary: String(summary), page, endedAt: new Date().toISOString() });
    if (Object.prototype.hasOwnProperty.call(settings, 'result')) this.active.result = clone(result);
    this.history = uniqueHistory([clone(this.active), ...this.history]);
    this.onChange(this);
  }

  serialize(totalRuns = this.history.length) {
    const snapshot = {
      version: 1,
      totalRuns: normalizeTotalRuns(totalRuns, this.history.length),
      active: clone(this.active),
      history: clone(this.history, []),
    };
    return clone(snapshot, { version: 1, totalRuns: 0, active: null, history: [] });
  }

  restore(session) {
    let totalRuns = 0;
    let interrupted = false;
    try {
      const source = session && typeof session === 'object' ? session : {};
      let history = uniqueHistory((Array.isArray(source.history) ? source.history : []).map(normalizeRecord).filter(Boolean));
      let active = normalizeRecord(source.active);
      if (active?.status === 'running') {
        interrupted = true;
        active.status = 'failed';
        active.interrupted = true;
        active.summary = '应用上次关闭时任务仍在执行，现已标记为中断；请重新运行任务。';
        active.endedAt = new Date().toISOString();
        active.stages = active.stages.map((stage) => {
          if (stage.status === 'running') return { ...stage, status: 'failed', detail: '应用关闭，运行被中断' };
          if (stage.status === 'pending') return { ...stage, status: 'skipped', detail: '任务中断，未执行' };
          return stage;
        });
        history = uniqueHistory([clone(active), ...history]);
      }
      this.active = clone(active);
      this.history = clone(history, []);
      totalRuns = normalizeTotalRuns(source.totalRuns, this.history.length);
    } catch {
      this.active = null;
      this.history = [];
    }
    this.onChange(this);
    return { totalRuns, interrupted };
  }

  select(id) {
    if (this.active?.status === 'running') return false;
    const record = this.history.find((item) => item.id === id);
    if (!record) return false;
    this.active = clone(record);
    this.onChange(this);
    return true;
  }

  clear() {
    this.active = null;
    this.history = [];
    this.onChange(this);
  }
}
