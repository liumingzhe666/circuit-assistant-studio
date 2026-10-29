const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.txt', '.md', '.markdown', '.json']);
const REQUESTED_PUBLISHER_TITLES = [
  '集成电路版图设计项目式教程',
  '电路与电子技术',
];

// 检索强度档位：控制候选池、返回条数、逐源上限与启用的召回路由。
const RETRIEVAL_STRENGTHS = Object.freeze({
  standard: { label: '标准', poolPerRoute: 24, limit: 8, perSource: 3, useTopics: false },
  deep: { label: '深度', poolPerRoute: 48, limit: 12, perSource: 3, useTopics: true },
  exhaustive: { label: '穷尽', poolPerRoute: 90, limit: 18, perSource: 4, useTopics: true },
});

// 领域同义词表：检索前把口语说法扩展成资料中的术语，召回率的主要来源。
const DOMAIN_SYNONYMS = Object.freeze({
  '降压': ['buck', '降压转换', '开关电源'],
  'buck': ['降压', '降压转换'],
  '升压': ['boost', '升压转换', '开关电源'],
  'boost': ['升压', '升压转换'],
  '稳压': ['稳压器', 'ldo', '线性稳压', 'regulator'],
  'ldo': ['线性稳压', '低压差', 'dropout'],
  '线性稳压': ['ldo', '低压差'],
  '电源': ['供电', '电源设计', 'power'],
  '纹波': ['ripple', '输出纹波', '滤波'],
  '电感': ['inductor', '储能电感', '饱和电流'],
  '电容': ['capacitor', 'mlcc', '退耦电容'],
  '去耦': ['退耦', 'decoupling', '旁路'],
  '退耦': ['去耦', 'decoupling', '旁路'],
  '运放': ['opamp', '运算放大器', '放大器'],
  'opamp': ['运放', '运算放大器'],
  '运算放大器': ['运放', 'opamp'],
  '放大': ['放大器', '增益', 'opamp'],
  '增益': ['gain', '闭环增益', '放大'],
  '带宽': ['gbw', '增益带宽积', 'bandwidth'],
  '相位裕度': ['稳定性', 'phase margin', '环路'],
  '振荡': ['oscillator', '振荡器', '555'],
  '555': ['定时器', 'timer', '多谐振荡'],
  '滤波': ['filter', '低通', 'rc滤波'],
  '滤波器': ['filter', '低通', '高通'],
  '截止频率': ['rc', '低通', 'fc'],
  '分压': ['电压采样', 'divider', '反馈'],
  '采样': ['adc', '采集', 'sampling'],
  'adc': ['模数转换', '采样', '驱动'],
  'mcu': ['单片机', '微控制器', '主控'],
  '单片机': ['mcu', '微控制器'],
  '晶振': ['crystal', '时钟', '负载电容'],
  '复位': ['reset', '监控', '看门狗'],
  '电机': ['马达', 'motor', '直流电机'],
  '马达': ['电机', 'motor'],
  '小车': ['电机驱动', 'h桥', '底盘'],
  '驱动': ['驱动器', 'driver', '功率'],
  'h桥': ['h-bridge', '全桥', '正反转'],
  'h-bridge': ['h桥', '全桥'],
  '堵转': ['stall', '启动电流', '峰值电流'],
  'pwm': ['调速', '占空比', '脉宽调制'],
  'mosfet': ['场效应管', '功率管', '栅极'],
  '栅极': ['gate', '栅极驱动', 'mosfet'],
  '继电器': ['relay', '触点', '线圈'],
  '续流': ['flyback', '感性负载', '钳位'],
  '二极管': ['diode', '整流', '钳位'],
  '肖特基': ['schottky', '低压降', '整流'],
  '齐纳': ['zener', '稳压二极管', '钳位'],
  'led': ['发光二极管', '指示灯', '限流'],
  '灯': ['led', '照明', '指示灯'],
  '灯泡': ['led', '照明', '点亮'],
  '保险': ['fuse', '保险丝', '过流保护'],
  '保险丝': ['fuse', '过流保护', '熔断'],
  'tvs': ['浪涌', '钳位', '瞬态抑制'],
  '浪涌': ['tvs', 'surge', '瞬态'],
  'esd': ['静电', '静电防护', '接口保护'],
  '反接': ['极性保护', '防反', '倒灌'],
  '热': ['热设计', '温升', '结温'],
  '热设计': ['散热', '结温', '热阻'],
  '结温': ['热阻', '温升', 'θja'],
  '散热': ['热设计', '温升', '铜箔'],
  'emi': ['电磁干扰', '噪声', '传导辐射'],
  '噪声': ['emi', '低噪声', '干扰'],
  'pcb': ['版图', '布局', '布线'],
  '布局': ['pcb', 'layout', '摆放'],
  '布线': ['走线', 'layout', 'pcb'],
  '载流': ['铜厚', '线宽', '温升'],
  '过孔': ['via', '载流', '散热'],
  '接地': ['地平面', '回流', '参考地'],
  '回流': ['地平面', '接地', '返回路径'],
  '隔离': ['光耦', 'optocoupler', '绝缘'],
  '光耦': ['optocoupler', '隔离', 'pc817'],
  '电池': ['锂电池', '供电', 'battery'],
  '锂电': ['锂电池', 'bms', '充电'],
  '市电': ['ac', '交流', '高压'],
  '整流': ['rectifier', '桥堆', 'ac-dc'],
  '锂电保护': ['bms', '过充', '过放'],
  '上拉': ['pull-up', '弱上拉', 'i2c'],
  '下拉': ['pull-down', '默认电平', '关断'],
  '阻抗': ['impedance', '匹配', '输入阻抗'],
  '环路': ['补偿', '环路增益', '稳定性'],
  '比较器': ['comparator', '阈值', 'lm393'],
  '传感器': ['sensor', '采集', '信号调理'],
  '蜂鸣器': ['buzzer', '报警', '无源蜂鸣'],
});

// 主题路由：查询命中关键词时追加一条专项检索路线，覆盖用户没说出口的工程词。
const TOPIC_ROUTES = Object.freeze([
  { id: 'topic-buck', label: '开关电源·Buck', keywords: ['buck', '降压', '稳压', '电源', '供电', '纹波'], query: 'buck 降压 电感纹波 峰值电流 环路补偿 热环路 去耦' },
  { id: 'topic-boost', label: '开关电源·Boost', keywords: ['boost', '升压', '泵'], query: 'boost 升压 占空比 峰值电流 二极管 关断直通 输出纹波' },
  { id: 'topic-ldo', label: '线性电源·LDO', keywords: ['ldo', '线性稳压', '低噪声', 'dropout'], query: 'ldo 线性稳压 dropout 热设计 稳定性 输出电容 esr' },
  { id: 'topic-motor', label: '电机驱动·H桥', keywords: ['电机', '马达', '小车', 'h桥', 'h-bridge', '驱动', '堵转', 'pwm', '正反转'], query: 'H桥 电机驱动 栅极驱动 堵转 死区 PWM TVS 反接 布局' },
  { id: 'topic-led', label: 'LED 与指示', keywords: ['led', '灯', '指示灯', '发光'], query: 'led 限流 恒流 正向压降 反接保护 功率' },
  { id: 'topic-opamp', label: '模拟放大', keywords: ['运放', 'opamp', '放大', '增益', '滤波', '信号'], query: '运放 增益 带宽 相位裕度 压摆率 共模 输出摆幅 稳定性' },
  { id: 'topic-adc', label: 'ADC 与采样', keywords: ['adc', '采样', '采集', '传感器', '模数'], query: 'adc 采样 建立时间 电荷回踢 抗混叠 驱动 rc滤波' },
  { id: 'topic-mcu', label: 'MCU 与数字电源域', keywords: ['mcu', '单片机', '数字', '复位', '晶振', '时钟'], query: 'mcu 退耦 电源域 复位 晶振 时钟 回流 esd 接口' },
  { id: 'topic-pcb', label: 'PCB 载流与布局', keywords: ['pcb', '布局', '布线', '走线', '载流', '铜', '过孔', 'layout'], query: 'pcb 载流 铜厚 温升 过孔 布局 布线 回流 ipc-2152' },
  { id: 'topic-protection', label: '接口与浪涌保护', keywords: ['保护', 'tvs', 'esd', '浪涌', '反接', '保险', 'fuse', '接口'], query: 'tvs esd 浪涌 反接 保险 接口保护 钳位 额定值' },
  { id: 'topic-thermal', label: '热设计与降额', keywords: ['热', '温升', '结温', '散热', '降额', '功耗'], query: '热设计 结温 热阻 降额 铜面 散热过孔 功耗' },
  { id: 'topic-emi', label: 'EMI 与回流', keywords: ['emi', '噪声', '干扰', '地', '接地', '回流', '屏蔽'], query: 'emi 热环路 回流 地平面 退耦 振铃 滤波 屏蔽' },
  { id: 'topic-battery', label: '电池与安全', keywords: ['电池', '锂电', '充电', 'bms', '市电', '高压', '安全'], query: '锂电池 bms 充电 保护 安规 隔离 高压 市电' },
  { id: 'topic-timer', label: '555 与时序', keywords: ['555', '定时', '振荡', '方波', '频率'], query: '555 振荡 定时 方波 占空比 电容 容差' },
  { id: 'topic-filter', label: '滤波与频响', keywords: ['滤波', '低通', '高通', '截止', '频率'], query: 'rc 滤波 截止频率 频率响应 阻抗 运放 adc' },
]);

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ \u3000]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cjkSearchTerms(value) {
  const normalized = String(value || '').normalize('NFKC').toLowerCase();
  const terms = new Set();
  for (const token of normalized.match(/[a-z0-9][a-z0-9_.+-]{1,}|[\u3400-\u9fff]+/g) || []) {
    if (/^[\u3400-\u9fff]+$/.test(token)) {
      if (token.length === 1) terms.add(token);
      for (let index = 0; index < token.length - 1; index += 1) {
        terms.add(token.slice(index, index + 2));
      }
    } else {
      terms.add(token);
    }
    if (terms.size >= 600) break;
  }
  return [...terms].join(' ');
}

function ftsQuery(value) {
  const terms = cjkSearchTerms(value).split(/\s+/).filter(Boolean).slice(0, 24);
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

function queryTokens(value) {
  return [...String(value || '').normalize('NFKC').toLowerCase().matchAll(/[a-z0-9][a-z0-9_.+-]{1,}|[\u3400-\u9fff]+/g)]
    .map((match) => match[0])
    .filter((token) => token.length >= 1);
}

// 查询扩展：命中同义词表的词会被替换/补充为资料中的规范术语，返回扩展痕迹用于检索追踪。
function expandQueryTerms(query) {
  const tokens = queryTokens(query);
  const original = new Set();
  const expanded = new Map();
  for (const token of tokens) {
    original.add(token);
    const synonyms = DOMAIN_SYNONYMS[token];
    if (synonyms) {
      for (const synonym of synonyms) expanded.set(synonym, token);
      continue;
    }
    // CJK 长词支持子串命中，如“电机驱动”命中“电机”。
    if (/^[\u3400-\u9fff]+$/.test(token) && token.length > 2) {
      for (const key of Object.keys(DOMAIN_SYNONYMS)) {
        if (key.length >= 2 && token.includes(key)) {
          for (const synonym of DOMAIN_SYNONYMS[key]) expanded.set(synonym, token);
        }
      }
    }
  }
  const synonymTokens = [...expanded.keys()].filter((term) => !original.has(term));
  return { originalTokens: [...original], synonymTokens, expandedMap: Object.fromEntries(expanded) };
}

function selectTopicRoutes(tokens, query) {
  const haystack = tokens.join(' ') + ' ' + String(query || '').toLowerCase();
  const selected = [];
  for (const route of TOPIC_ROUTES) {
    if (route.keywords.some((keyword) => haystack.includes(keyword))) selected.push(route);
  }
  return selected;
}

function routeMatch(terms) {
  return ftsQuery(terms.join(' '));
}

function detectHeading(text) {
  const first = String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  if (/^(?:#{1,6}\s+|第[一二三四五六七八九十百千万0-9]+[章节篇部分]|\d+(?:\.\d+){0,3}\s+\S)/.test(first)) {
    return first.replace(/^#{1,6}\s+/, '').slice(0, 160);
  }
  return '';
}

function splitPage(text, pageNumber, targetSize = 1400, overlap = 180) {
  const content = cleanText(text);
  if (!content) return [];
  const chunks = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + targetSize);
    if (end < content.length) {
      const searchFrom = Math.max(start + Math.floor(targetSize * 0.65), end - 240);
      const breakAt = Math.max(
        content.lastIndexOf('\n\n', end),
        content.lastIndexOf('。', end),
        content.lastIndexOf('；', end),
      );
      if (breakAt >= searchFrom) end = breakAt + 1;
    }
    const part = content.slice(start, end).trim();
    if (part) {
      chunks.push({
        content: part,
        heading: detectHeading(part),
        pageStart: pageNumber,
        pageEnd: pageNumber,
        charStart: start,
        charEnd: end,
      });
    }
    if (end >= content.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function inferMetadata(filePath, extracted) {
  const fileName = path.basename(filePath);
  const stem = path.basename(filePath, path.extname(filePath))
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const sample = cleanText(extracted.text).slice(0, 80_000);
  const info = extracted.info || {};
  const requestedTitle = REQUESTED_PUBLISHER_TITLES.find((title) => stem.includes(title) || sample.includes(title));
  const publisher = /电子工业出版社|Publishing House of Electronics Industry/i.test(`${fileName}\n${sample}\n${info.Publisher || ''}`)
    || Boolean(requestedTitle)
    ? '电子工业出版社'
    : String(info.Publisher || '').trim();
  const isbnMatch = sample.match(/ISBN(?:-1[03])?\s*[:：]?\s*([0-9Xx-]{10,20})/i);
  const firstHeading = sample.split('\n').map((line) => line.trim()).find((line) => /^#\s+/.test(line));
  const title = cleanText(info.Title || requestedTitle || firstHeading?.replace(/^#\s+/, '') || stem || fileName).slice(0, 240);
  return {
    title,
    publisher: cleanText(publisher).slice(0, 160),
    authors: cleanText(info.Author || '').slice(0, 300),
    isbn: cleanText(isbnMatch?.[1] || '').slice(0, 32),
    language: 'zh-CN',
  };
}

async function extractPdf(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const infoResult = await parser.getInfo();
    const textResult = await parser.getText();
    const pages = (textResult.pages || []).map((page, index) => ({
      number: Number(page.num || index + 1),
      text: cleanText(page.text),
    }));
    return {
      text: cleanText(textResult.text),
      pages,
      pageCount: Number(textResult.total || infoResult.total || pages.length || 0),
      info: infoResult.infoData || {},
    };
  } finally {
    await parser.destroy();
  }
}

async function extractDocument(filePath, buffer) {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`不支持 ${extension || '无扩展名'} 文件；请选择 PDF、TXT、Markdown 或 JSON。`);
  }
  if (extension === '.pdf') return extractPdf(buffer);
  const text = cleanText(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  return {
    text,
    pages: [{ number: 1, text }],
    pageCount: text ? 1 : 0,
    info: {},
  };
}

class KnowledgeDatabase {
  constructor(databasePath, schemaSql) {
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const hasLibrary = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'library_sources'").get();
    if (hasLibrary) {
      this.ensureColumn('library_sources', 'source_url', "TEXT NOT NULL DEFAULT ''");
      this.ensureColumn('library_sources', 'accessed_at', "TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec(schemaSql);
    this.db.prepare("UPDATE app_metadata SET value = '2' WHERE key = 'schema_version'").run();
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  static async open(databasePath, schemaPath) {
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const schemaSql = await fs.readFile(schemaPath, 'utf8');
    return new KnowledgeDatabase(databasePath, schemaSql);
  }

  close() {
    this.db.close();
  }

  findByHash(fileHash) {
    return this.db.prepare('SELECT * FROM library_sources WHERE file_sha256 = ?').get(fileHash);
  }

  findByUrl(url) {
    return this.db.prepare('SELECT * FROM library_sources WHERE source_url = ? ORDER BY id DESC LIMIT 1').get(url);
  }

  logImport(record) {
    this.db.prepare(`
      INSERT INTO import_log (file_name, file_path, file_sha256, status, source_id, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.fileName,
      record.filePath,
      record.fileHash || '',
      record.status,
      record.sourceId || null,
      record.message || '',
      nowIso(),
    );
  }

  async importFile(filePath, options = {}) {
    const resolvedPath = path.resolve(filePath);
    const fileName = path.basename(resolvedPath);
    const extension = path.extname(resolvedPath).toLowerCase();
    let fileHash = '';
    try {
      if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error('仅支持 PDF、TXT、Markdown 和 JSON 文件。');
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) throw new Error('所选路径不是文件。');
      if (stat.size > 250 * 1024 * 1024) throw new Error('单个文件不能超过 250 MB。');
      const buffer = await fs.readFile(resolvedPath);
      fileHash = sha256(buffer);
      const duplicate = this.findByHash(fileHash);
      if (duplicate) {
        const result = { status: 'duplicate', sourceId: duplicate.id, fileName, title: duplicate.title, message: '相同文件已在数据库中。' };
        this.logImport({ ...result, filePath: resolvedPath, fileHash });
        return result;
      }

      const extracted = await extractDocument(resolvedPath, buffer);
      const metadata = { ...inferMetadata(resolvedPath, extracted), ...(options.metadata || {}) };
      const pages = extracted.pages?.length ? extracted.pages : [{ number: 1, text: extracted.text }];
      const chunks = pages.flatMap((page) => splitPage(page.text, page.number));
      const needsOcr = extension === '.pdf' && cleanText(extracted.text).length < Math.max(80, extracted.pageCount * 20);
      const status = needsOcr ? 'needs-ocr' : 'ready';
      const rightsStatus = ['user-provided', 'licensed', 'public-domain', 'unknown'].includes(options.rightsStatus)
        ? options.rightsStatus
        : 'user-provided';
      const rightsNote = cleanText(options.rightsNote || '由用户从本地选择导入；应用不下载或分发原始书籍。').slice(0, 500);

      this.db.exec('BEGIN IMMEDIATE');
      try {
        const sourceInsert = this.db.prepare(`
          INSERT INTO library_sources (
            title, publisher, authors, isbn, language, source_type, original_name, original_path, source_url,
            file_sha256, file_size, rights_status, rights_note, page_count, extracted_chars,
            chunk_count, status, accessed_at, imported_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          metadata.title,
          metadata.publisher || '',
          metadata.authors || '',
          metadata.isbn || '',
          metadata.language || 'zh-CN',
          extension.slice(1),
          fileName,
          resolvedPath,
          '',
          fileHash,
          stat.size,
          rightsStatus,
          rightsNote,
          extracted.pageCount || pages.length,
          cleanText(extracted.text).length,
          chunks.length,
          status,
          '',
          nowIso(),
          JSON.stringify(extracted.info || {}),
        );
        const sourceId = Number(sourceInsert.lastInsertRowid);
        const chunkInsert = this.db.prepare(`
          INSERT INTO knowledge_chunks (
            source_id, chunk_index, heading, page_start, page_end, char_start, char_end, content, content_sha256
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const ftsInsert = this.db.prepare(`
          INSERT INTO knowledge_fts (chunk_id, source_id, title, publisher, heading, content, search_terms)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        chunks.forEach((chunk, index) => {
          const inserted = chunkInsert.run(
            sourceId,
            index,
            chunk.heading || '',
            chunk.pageStart || null,
            chunk.pageEnd || null,
            chunk.charStart || 0,
            chunk.charEnd || 0,
            chunk.content,
            sha256(chunk.content),
          );
          const chunkId = Number(inserted.lastInsertRowid);
          ftsInsert.run(
            chunkId,
            sourceId,
            metadata.title,
            metadata.publisher || '',
            chunk.heading || '',
            chunk.content,
            cjkSearchTerms(`${metadata.title} ${metadata.publisher || ''} ${chunk.heading || ''} ${chunk.content}`),
          );
        });
        this.db.exec('COMMIT');
        const resultStatus = needsOcr ? 'needs-ocr' : 'imported';
        const result = {
          status: resultStatus,
          sourceId,
          fileName,
          title: metadata.title,
          publisher: metadata.publisher || '',
          pageCount: extracted.pageCount || pages.length,
          chunkCount: chunks.length,
          extractedChars: cleanText(extracted.text).length,
          message: needsOcr ? '未提取到足够文本，可能是扫描版 PDF，请先 OCR。' : '已写入 SQLite 全文知识库。',
        };
        this.logImport({ ...result, filePath: resolvedPath, fileHash });
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      const result = { status: 'error', fileName, message: error.message };
      this.logImport({ ...result, filePath: resolvedPath, fileHash });
      return result;
    }
  }

  async importFiles(filePaths, options = {}) {
    const results = [];
    for (const filePath of filePaths.slice(0, 200)) {
      results.push(await this.importFile(filePath, options));
    }
    return results;
  }

  importWebSource(source) {
    const url = String(source?.url || '').trim();
    if (!/^https:\/\//i.test(url)) throw new Error('公开网页来源必须使用 HTTPS URL。');
    const title = cleanText(source.title).slice(0, 240);
    const content = cleanText(source.content);
    if (!title || content.length < 40) throw new Error('网页知识缺少标题或有效摘要。');
    const publisher = cleanText(source.publisher || '').slice(0, 160);
    const authors = cleanText(source.authors || '').slice(0, 300);
    const isbn = cleanText(source.isbn || '').slice(0, 32);
    const accessedAt = cleanText(source.accessedAt || nowIso()).slice(0, 40);
    const rightsStatus = ['user-provided', 'licensed', 'public-domain', 'unknown'].includes(source.rightsStatus)
      ? source.rightsStatus
      : 'unknown';
    const rightsNote = cleanText(source.rightsNote || '公开网页的整理摘要；原网页版权归其权利人所有。').slice(0, 500);
    const fileHash = sha256(`${url}\u0000${content}`);
    const duplicate = this.findByHash(fileHash);
    if (duplicate) return { status: 'duplicate', sourceId: duplicate.id, title: duplicate.title, url };
    const previous = this.findByUrl(url);
    const chunks = splitPage(content, 1);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (previous) {
        this.db.prepare('DELETE FROM knowledge_fts WHERE source_id = ?').run(previous.id);
        this.db.prepare('DELETE FROM library_sources WHERE id = ?').run(previous.id);
      }
      const inserted = this.db.prepare(`
        INSERT INTO library_sources (
          title, publisher, authors, isbn, language, source_type, original_name, original_path, source_url,
          file_sha256, file_size, rights_status, rights_note, page_count, extracted_chars, chunk_count,
          status, accessed_at, imported_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'ready', ?, ?, ?)
      `).run(
        title,
        publisher,
        authors,
        isbn,
        source.language || 'zh-CN',
        source.originalName || new URL(url).hostname,
        url,
        url,
        fileHash,
        Buffer.byteLength(content, 'utf8'),
        rightsStatus,
        rightsNote,
        content.length,
        chunks.length,
        accessedAt,
        nowIso(),
        JSON.stringify(source.metadata || {}),
      );
      const sourceId = Number(inserted.lastInsertRowid);
      const chunkInsert = this.db.prepare(`
        INSERT INTO knowledge_chunks (
          source_id, chunk_index, heading, page_start, page_end, char_start, char_end, content, content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const ftsInsert = this.db.prepare(`
        INSERT INTO knowledge_fts (chunk_id, source_id, title, publisher, heading, content, search_terms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      chunks.forEach((chunk, index) => {
        const row = chunkInsert.run(
          sourceId,
          index,
          chunk.heading || '',
          null,
          null,
          chunk.charStart || 0,
          chunk.charEnd || 0,
          chunk.content,
          sha256(chunk.content),
        );
        const chunkId = Number(row.lastInsertRowid);
        ftsInsert.run(
          chunkId,
          sourceId,
          title,
          publisher,
          chunk.heading || '',
          chunk.content,
          cjkSearchTerms(`${title} ${publisher} ${chunk.heading || ''} ${chunk.content}`),
        );
      });
      this.db.exec('COMMIT');
      this.logImport({
        fileName: title,
        filePath: url,
        fileHash,
        status: 'imported',
        sourceId,
        message: '公开网页的整理摘要已写入 SQLite。',
      });
      return { status: previous ? 'updated' : 'imported', sourceId, title, url, chunkCount: chunks.length };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listSources(limit = 200) {
    return this.db.prepare(`
      SELECT id, title, publisher, authors, isbn, source_type, original_name, source_url, rights_status,
             page_count, extracted_chars, chunk_count, status, accessed_at, imported_at, metadata_json
      FROM library_sources
      ORDER BY imported_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 200)));
  }

  stats() {
    return this.db.prepare(`
      SELECT
        COUNT(*) AS source_count,
        COALESCE(SUM(chunk_count), 0) AS chunk_count,
        COALESCE(SUM(extracted_chars), 0) AS character_count,
        COUNT(DISTINCT NULLIF(publisher, '')) AS publisher_count,
        SUM(CASE WHEN status = 'needs-ocr' THEN 1 ELSE 0 END) AS needs_ocr_count
      FROM library_sources
    `).get();
  }

  rowToHit(row, extra = {}) {
    return {
      id: `sql-chunk-${row.chunk_id}`,
      sourceId: row.source_id,
      chunkId: row.chunk_id,
      title: row.title,
      publisher: row.publisher,
      authors: row.authors,
      isbn: row.isbn,
      rightsStatus: row.rights_status,
      sourceType: row.source_type,
      sourceUrl: row.source_url,
      heading: row.heading,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      content: row.content.slice(0, 1800),
      authorityTier: row.authority_tier || '',
      authorityRank: Number(row.authority_rank) || 0,
      sourceComparison: row.source_comparison || '',
      score: Number.isFinite(row.rank) ? -row.rank : 0,
      ...extra,
    };
  }

  runRoute(routeMatch, poolPerRoute, publisher) {
    if (!routeMatch) return [];
    return this.db.prepare(`
      SELECT
        c.id AS chunk_id,
        c.source_id,
        s.title,
        s.publisher,
        s.authors,
        s.isbn,
        s.rights_status,
        s.source_type,
        s.source_url,
        c.heading,
        c.page_start,
        c.page_end,
        c.content,
        json_extract(s.metadata_json, '$.authorityTier') AS authority_tier,
        json_extract(s.metadata_json, '$.comparison') AS source_comparison,
        CASE json_extract(s.metadata_json, '$.authorityTier')
          WHEN 'A+' THEN 2
          WHEN 'A' THEN 1
          ELSE 0
        END AS authority_rank,
        bm25(knowledge_fts, 0, 0, 5, 3, 4, 1, 2) AS rank
      FROM knowledge_fts
      JOIN knowledge_chunks AS c ON c.id = knowledge_fts.chunk_id
      JOIN library_sources AS s ON s.id = c.source_id
      WHERE knowledge_fts MATCH ?
        AND (? = '' OR s.publisher LIKE '%' || ? || '%')
        AND s.status = 'ready'
      ORDER BY authority_rank DESC, rank, s.id, c.chunk_index
      LIMIT ?
    `).all(routeMatch, publisher, publisher, poolPerRoute);
  }

  // 多路召回 + RRF 融合检索：
  // 路线 1 原始查询；路线 2 领域同义扩展；路线 3+ 主题专项路由。
  // 各路线独立取候选，用倒数排名融合后叠加权威层级、bm25 与整词命中奖励。
  searchWithTrace(query, options = {}) {
    const startedAt = Date.now();
    const rawQuery = String(query || '');
    const strengthKey = RETRIEVAL_STRENGTHS[options.strength] ? options.strength : 'deep';
    const strength = RETRIEVAL_STRENGTHS[strengthKey];
    const limit = Math.max(1, Math.min(40, Number(options.limit) || strength.limit));
    const publisher = cleanText(options.publisher || '');
    const { originalTokens, synonymTokens, expandedMap } = expandQueryTerms(rawQuery);
    if (!originalTokens.length && !synonymTokens.length) {
      return { hits: [], trace: { strength: strengthKey, routes: [], candidateCount: 0, selectedCount: 0, elapsedMs: Date.now() - startedAt, empty: true } };
    }

    const routes = [{ id: 'original', label: '原始查询', terms: originalTokens }];
    if (synonymTokens.length) routes.push({ id: 'synonym', label: '同义扩展', terms: synonymTokens });
    if (strength.useTopics) {
      for (const topic of selectTopicRoutes([...originalTokens, ...synonymTokens], rawQuery)) {
        routes.push({ id: topic.id, label: topic.label, terms: uniqueTokens([...topic.query.split(' '), ...originalTokens.slice(0, 3)]) });
      }
    }

    const candidates = new Map();
    const routeTrace = [];
    let minRank = 0;
    for (const route of routes) {
      const match = routeMatch(route.terms);
      const rows = this.runRoute(match, strength.poolPerRoute, publisher);
      routeTrace.push({ id: route.id, label: route.label, terms: route.terms, hitCount: rows.length });
      rows.forEach((row, rank) => {
        const contribution = 1 / (60 + rank);
        if (Number.isFinite(row.rank) && row.rank < minRank) minRank = row.rank;
        const existing = candidates.get(row.chunk_id);
        if (existing) {
          existing.fused += contribution;
          existing.routeHits.push(route.id);
          return;
        }
        candidates.set(row.chunk_id, { row, fused: contribution, routeHits: [route.id] });
      });
    }

    const compactQuery = rawQuery.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    const fused = [...candidates.values()].map((candidate) => {
      const { row } = candidate;
      const authorityBonus = (Number(row.authority_rank) || 0) * 0.08;
      const bm25Bonus = minRank < 0 && Number.isFinite(row.rank) ? 0.6 * (row.rank / minRank) : 0;
      const haystack = `${row.title || ''}\u0000${row.heading || ''}\u0000${row.content || ''}`.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
      const phraseBonus = compactQuery.length >= 4 && haystack.includes(compactQuery) ? 0.35 : 0;
      const headingBonus = row.heading && routeHitTerms(candidate.routeHits, routes).some((term) => String(row.heading).toLowerCase().includes(term)) ? 0.2 : 0;
      return {
        ...candidate,
        bonus: authorityBonus + bm25Bonus + phraseBonus + headingBonus,
        fused: candidate.fused + authorityBonus + bm25Bonus + phraseBonus + headingBonus,
      };
    }).sort((a, b) => b.fused - a.fused);

    const perSource = new Map();
    const hits = [];
    for (const candidate of fused) {
      const count = perSource.get(candidate.row.source_id) || 0;
      if (count >= strength.perSource) continue;
      perSource.set(candidate.row.source_id, count + 1);
      const hit = this.rowToHit(candidate.row, {
        score: round4(candidate.fused),
        scoreTrace: {
          fused: round4(candidate.fused),
          routeHits: candidate.routeHits,
          routeCount: candidate.routeHits.length,
          authorityRank: Number(candidate.row.authority_rank) || 0,
          bonus: round4(candidate.bonus),
        },
      });
      hits.push(hit);
      if (hits.length >= limit) break;
    }

    const trace = {
      strength: strengthKey,
      strengthLabel: strength.label,
      routeCount: routes.length,
      routes: routeTrace,
      expandedTerms: synonymTokens,
      expansionMap: expandedMap,
      topicsSelected: routes.filter((route) => route.id.startsWith('topic-')).map((route) => route.label),
      candidateCount: candidates.size,
      selectedCount: hits.length,
      perSourceCap: strength.perSource,
      limit,
      elapsedMs: Date.now() - startedAt,
    };
    return { hits, trace };
  }

  search(query, options = {}) {
    return this.searchWithTrace(query, options).hits;
  }
}

function uniqueTokens(tokens) {
  return [...new Set(tokens.map((token) => String(token).toLowerCase()).filter(Boolean))];
}

function routeHitTerms(routeHits, routes) {
  const terms = [];
  for (const id of routeHits) {
    const route = routes.find((item) => item.id === id);
    if (route) terms.push(...route.terms);
  }
  return terms;
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

module.exports = {
  KnowledgeDatabase,
  SUPPORTED_EXTENSIONS,
  RETRIEVAL_STRENGTHS,
  DOMAIN_SYNONYMS,
  TOPIC_ROUTES,
  cjkSearchTerms,
  ftsQuery,
  expandQueryTerms,
  selectTopicRoutes,
  splitPage,
  inferMetadata,
  cleanText,
};
