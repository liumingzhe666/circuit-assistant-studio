import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import sharp from 'sharp';
import { generateCircuit, supervisePlan } from '../src/shared/core.mjs';
import { auditSchematicConnectivity } from '../src/shared/layout-agent.mjs';
import { extractSchematicNetlist, reviewSchematicElectrical } from '../src/shared/schematic-netlist.mjs';
import { schematicDataset } from '../evaluation/schematic-100-v1.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export function structuralFingerprint(schematic) {
  const netlist = extractSchematicNetlist(schematic);
  const vertices = new Map();
  const symmetric = new Set(['resistor', 'capacitor', 'inductor', 'fuse', 'switch']);
  netlist.nets.forEach(net => vertices.set(net.id, { color: 'net', edges: [] }));
  for (const device of netlist.devices) {
    const key = `C${device.index}`;
    vertices.set(key, { color: device.type, edges: [] });
    for (const [pinId, pin] of Object.entries(device.pins)) {
      const role = symmetric.has(device.type) ? 'terminal' : pinId;
      vertices.get(key).edges.push([pin.net, role]);
      vertices.get(pin.net).edges.push([key, role]);
    }
  }
  const features = {};
  for (let round = 0; round < 5; round++) {
    for (const vertex of vertices.values()) {
      const key = `${round}:${vertex.color}`;
      features[key] = (features[key] || 0) + 1;
    }
    const next = new Map([...vertices].map(([key, vertex]) => [key, hash(vertex.color + '|' + vertex.edges
      .map(([neighbor, role]) => `${role}:${vertices.get(neighbor).color}`).sort().join('|'))]));
    for (const [key, color] of next) vertices.get(key).color = color;
  }
  return { fingerprint: hash([...vertices.values()].map(v => v.color).sort().join('|')), features };
}

export function structuralSimilarity(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let intersection = 0, union = 0;
  for (const key of keys) { intersection += Math.min(a[key] || 0, b[key] || 0); union += Math.max(a[key] || 0, b[key] || 0); }
  return union ? intersection / union : 1;
}

function actualRenderer() {
  const source = readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const extract = (name, nextName) => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(`function ${nextName}(`, start);
    if (start < 0 || end < 0) throw new Error(`Cannot locate application renderer ${name}`);
    return source.slice(start, end);
  };
  // Evaluate only three self-contained functions from the trusted local renderer.
  // This preserves the application's symbols/wires; no replacement circuits are drawn.
  return { render: vm.runInNewContext(extract('esc', 'iconMarkup') + extract('symbolSvg', 'componentIconSvg')
    + extract('renderSchematic', 'renderPlan') + '\nrenderSchematic;'), sourceHash: hash(source) };
}

export async function runSchematicSuite(output) {
  if (schematicDataset.cases.length !== 100 || new Set(schematicDataset.cases.map(c => c.topologyId)).size !== 100) throw new Error('Dataset must contain 100 distinct topology contracts.');
  const knowledge = ['basic', 'advanced'].flatMap(name => JSON.parse(readFileSync(path.join(root, `knowledge/${name}-circuits.json`), 'utf8')));
  const renderer = actualRenderer();
  mkdirSync(path.join(output, 'diagrams'), { recursive: true });
  mkdirSync(path.join(output, 'plans'), { recursive: true });
  const results = [];
  const featureSets = new Map();
  for (const item of schematicDataset.cases) {
    const result = { ...item, checks: [], generated: false };
    const check = (name, pass, detail) => result.checks.push({ name, pass: Boolean(pass), detail });
    try {
      const plan = generateCircuit(item.requirement, knowledge);
      const audit = supervisePlan(plan);
      const electrical = reviewSchematicElectrical(plan);
      const geometry = auditSchematicConnectivity(plan.schematic, { kind: plan.kind });
      const types = {};
      for (const component of plan.schematic.components) types[component.type] = (types[component.type] || 0) + 1;
      result.generated = true;
      result.actualKind = plan.kind;
      result.actualTopology = plan.topology;
      result.componentTypes = types;
      result.productDecision = audit.decision;
      check('目标功能/拓扑', new RegExp(item.contract.topologyPattern, 'i').test(plan.topology), `要求 ${item.title}；实际 ${plan.topology}`);
      for (const [type, minimum] of Object.entries(item.contract.minimumTypes)) {
        const count = type === 'capacitor' ? (types.capacitor || 0) + (types.electrolytic || 0) + (types.tantalum || 0)
          : type === 'diode' ? (types.diode || 0) + (types.schottky || 0) : types[type] || 0;
        check(`必要器件 ${type}`, count >= minimum, `至少 ${minimum}，实际 ${count}（电容包含有极性类型）`);
      }
      check('几何连通', geometry.continuous, geometry);
      for (const entry of electrical.checks) check(entry.title, entry.status !== 'fail', entry.detail);
      result.electricalFailures = electrical.checks.filter(c => c.status === 'fail');
      result.undetectedElectricalFailure = result.electricalFailures.length > 0
        && !audit.checks.some(c => c.status === 'fail' && electrical.checks.some(e => e.title === c.title));
      result.netlist = electrical.netlist;
      const { fingerprint, features } = structuralFingerprint(plan.schematic);
      result.fingerprint = fingerprint;
      featureSets.set(item.id, features);
      const svg = renderer.render(plan);
      writeFileSync(path.join(output, 'diagrams', `${item.id}.svg`), svg);
      writeFileSync(path.join(output, 'plans', `${item.id}.json`), JSON.stringify({ request: item, plan, productAudit: audit, independentElectricalAudit: electrical }, null, 2));
    } catch (error) { result.error = error.message; check('生成异常', false, error.message); }
    result.structuralPass = result.generated && result.checks.every(c => c.pass);
    results.push(result);
  }
  const groups = new Map();
  for (const result of results.filter(r => r.generated)) {
    if (!groups.has(result.fingerprint)) groups.set(result.fingerprint, []);
    groups.get(result.fingerprint).push(result.id);
  }
  for (const result of results.filter(r => r.generated)) {
    result.duplicateIds = groups.get(result.fingerprint).filter(id => id !== result.id);
    const nearest = results.filter(r => r.generated && r.id !== result.id).map(r => ({ id: r.id, similarity: structuralSimilarity(featureSets.get(result.id), featureSets.get(r.id)) }))
      .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))[0];
    result.nearest = { id: nearest.id, similarity: Number(nearest.similarity.toFixed(4)) };
    result.largeDifference = nearest.similarity <= 0.7;
    result.accepted = result.structuralPass && result.largeDifference;
  }
  const generated = results.filter(r => r.generated).length;
  const summary = { total: results.length, generated, uniqueStructures: groups.size,
    repeatedCopies: generated - groups.size, duplicateAffected: results.filter(r => r.duplicateIds?.length).length,
    structurallyMatched: results.filter(r => r.structuralPass).length,
    largeDifference: results.filter(r => r.largeDifference).length,
    accepted: results.filter(r => r.accepted).length,
    electricalFailureCases: results.filter(r => r.electricalFailures?.length).length,
    undetectedElectricalFailures: results.filter(r => r.undetectedElectricalFailure).length };
  const report = { format: schematicDataset.format, generatedAt: new Date().toISOString(), summary,
    methodology: { description: schematicDataset.description,
      generator: '真实 generateCircuit + supervisePlan；无模型，未手工替换失败图纸。',
      structure: '按实际引脚和导线重建网络，五轮带引脚类型的图颜色细化指纹；忽略标题、数值、坐标、位号和布局。指纹是一种图比较方法，不是完备的电气等价证明。',
      difference: '所有生成结果两两比较。图邻域特征的加权 Jaccard 相似度≤0.70 才记为差异明显；这是固定工程阈值，不是物理正确率。重复组全部标注，未把第一个自动判合格。',
      boundary: '仅必要概念结构检查。没有 SPICE、硬件、温度或额定值验证；不支持功能不会靠放宽标准过关。' },
    hashes: { dataset: hash(readFileSync(path.join(root, 'evaluation/schematic-100-v1.mjs'))), core: hash(readFileSync(path.join(root, 'src/shared/core.mjs'))), renderer: renderer.sourceHash,
      electricalChecker: hash(readFileSync(path.join(root, 'src/shared/schematic-netlist.mjs'))), evaluator: hash(readFileSync(fileURLToPath(import.meta.url))) },
    duplicateGroups: [...groups].filter(([, ids]) => ids.length > 1).map(([fingerprint, ids]) => ({ fingerprint, ids })), results };
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(output, 'dataset.json'), JSON.stringify(schematicDataset, null, 2));
  writeFileSync(path.join(output, 'results.csv'), '\uFEFF' + ['ID,类别,目标,实际拓扑,结构通过,重复数量,最近相似度,差异明显,最终通过',
    ...results.map(r => [r.id, r.family, r.title, r.actualTopology || r.error, r.structuralPass, r.duplicateIds?.length || 0, r.nearest?.similarity ?? '', r.largeDifference || false, r.accepted || false].map(v => '"' + String(v).replaceAll('"', '""') + '"').join(','))].join('\r\n'));
  writeFileSync(path.join(output, 'index.html'), gallery(report));
  const tiles = [];
  for (const [index, result] of results.entries()) {
    let tile;
    if (result.generated) tile = await sharp(path.join(output, 'diagrams', `${result.id}.svg`)).resize(280, 225).png().toBuffer();
    else tile = await sharp({ create: { width: 280, height: 225, channels: 4, background: '#241b21' } }).png().toBuffer();
    const heading = Buffer.from(`<svg width="280" height="30"><rect width="280" height="30" fill="${result.structuralPass ? '#163f35' : '#4b2530'}"/><text x="9" y="20" font-family="Microsoft YaHei, sans-serif" font-size="12" fill="white">${esc(result.id + ' · ' + result.title)}</text></svg>`);
    tiles.push({ input: heading, left: index % 10 * 280, top: Math.floor(index / 10) * 255 });
    tiles.push({ input: tile, left: index % 10 * 280, top: Math.floor(index / 10) * 255 + 30 });
  }
  await sharp({ create: { width: 2800, height: 2550, channels: 4, background: '#0b1623' } }).composite(tiles).png().toFile(path.join(output, 'contact-sheet.png'));
  return report;
}

function gallery(report) {
  const s = report.summary;
  const cards = report.results.map(r => `<article data-family="${esc(r.family)}" data-pass="${r.structuralPass}" data-duplicate="${Boolean(r.duplicateIds?.length)}" data-search="${esc(r.id + r.family + r.title + r.requirement)}">
    <header><span>${r.id} · ${esc(r.family)}</span><b class="${r.structuralPass ? 'ok' : 'bad'}">${r.structuralPass ? '结构匹配' : '结构未通过'}</b></header><h2>${esc(r.title)}</h2>
    <p>${esc(r.requirement)}</p><a class="diagram" href="diagrams/${r.id}.svg" target="_blank">${r.generated ? `<img loading="lazy" src="diagrams/${r.id}.svg" alt="${esc(r.title)}的实际生成结果">` : `<div class="error">${esc(r.error)}</div>`}</a>
    <p class="actual">实际：${esc(r.actualTopology || '生成失败')}</p><p class="${r.largeDifference ? 'ok' : 'bad'}">${r.duplicateIds?.length ? `同结构重复：${r.duplicateIds.length + 1} 张` : `最近结构相似度：${r.nearest ? (r.nearest.similarity * 100).toFixed(1) + '%' : '未知'}`} · ${r.largeDifference ? '差异明显' : '差异不足'}</p>
    <details><summary>测试详情与重复项</summary><ul>${r.checks.map(c => `<li class="${c.pass ? 'ok' : 'bad'}">${c.pass ? '✓' : '✕'} ${esc(c.name)}：${esc(typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail))}</li>`).join('')}</ul><p>相同结构：${r.duplicateIds?.join('、') || '无'}</p><p>软件原有审查：${esc(r.productDecision)}</p><a href="plans/${r.id}.json">完整方案与引脚网表 JSON</a></details></article>`).join('\n');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>100 项电路图测试</title><style>
  *{box-sizing:border-box}body{margin:0;background:#0b1320;color:#dce7ee;font:15px/1.65 "Microsoft YaHei",sans-serif}main{max-width:1500px;margin:auto;padding:28px}h1{font-size:30px;margin:0 0 10px}h2{font-size:19px;margin:10px 0}a{color:#8dcdfa}p{margin:8px 0}.notice{background:#282333;border-left:4px solid #e2a973;padding:16px;margin:18px 0}.metrics{display:flex;flex-wrap:wrap;gap:12px}.metric{background:#172333;padding:12px 20px;border-radius:8px;min-width:170px}.metric strong{font-size:28px;display:block}.filters{position:sticky;top:0;background:#0b1320;padding:15px 0;display:flex;gap:12px;z-index:2;flex-wrap:wrap}input,select{padding:10px;background:#172333;color:#e6eef3;border:1px solid #3f546c;border-radius:5px}input{min-width:260px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:18px}article{background:#132032;padding:16px;border:1px solid #29394b;border-radius:10px}article[hidden]{display:none}header{display:flex;justify-content:space-between;gap:10px;color:#aab8c9;font-size:13px}.diagram{display:block;background:#0c1b29}.diagram img{width:100%;display:block}.actual{font-size:13px;color:#aebfd2}.ok{color:#8addbd}.bad{color:#ffb2a7}details{border-top:1px solid #324357;padding-top:8px}summary{cursor:pointer}li{margin:8px 0;font-size:13px}ul{padding-left:20px}.error{padding:60px 12px}.footer{margin:24px 0;color:#aebfd2}@media(max-width:480px){main{padding:14px}.grid{grid-template-columns:1fr}}</style><main>
  <h1>100 项电路图测试</h1><p>20 类功能 · 100 个不同拓扑需求 · 实际生成结果逐项留存</p>
  <div class="metrics">${[['已生成',`${s.generated}/100`],['结构匹配',`${s.structurallyMatched}/100`],['结构指纹种类',s.uniqueStructures],['重复副本',s.repeatedCopies],['全部条件通过',`${s.accepted}/100`]].map(([label,value])=>`<div class="metric">${label}<strong>${value}</strong></div>`).join('')}</div>
  <div class="notice">这是测试结果，包含失败与重复图纸。卡片标题是测试目标，图下“实际”是软件输出。图内 PASS 仅表示几何连通检查，不代表电路功能正确。电路均未经过 SPICE 或实物验证。</div>
  <p><a href="report.json">完整报告 JSON</a> · <a href="results.csv">结果 CSV</a> · <a href="dataset.json">100 项需求与固定标准</a> · <a href="contact-sheet.png">100 图总览 PNG</a></p>
  <div class="filters"><input id="search" placeholder="搜索编号、功能或需求" aria-label="搜索"><select id="family" aria-label="类别"><option value="">全部类别</option>${[...new Set(report.results.map(r=>r.family))].map(f=>`<option>${esc(f)}</option>`).join('')}</select><select id="status" aria-label="结果"><option value="">全部结果</option><option value="fail">结构未通过</option><option value="pass">结构匹配</option><option value="duplicate">相同结构重复</option></select><span id="count">显示100项</span></div>
  <section class="grid">${cards}</section><p class="footer">差异判据：忽略数值、标题、位号和坐标，按器件类型与引脚连接比较图结构；与任一其他结果的相似度超过70%即记为差异不足。仅必要结构检查，未证明功能、额定值、引脚封装或硬件可用性。</p>
  </main><script>const controls=['search','family','status'].map(id=>document.getElementById(id));function filter(){const [q,f,s]=controls.map(x=>x.value.toLowerCase());let count=0;document.querySelectorAll('article').forEach(a=>{const ok=(!q||a.dataset.search.toLowerCase().includes(q))&&(!f||a.dataset.family.toLowerCase()===f)&&(!s||(s==='pass'&&a.dataset.pass==='true')||(s==='fail'&&a.dataset.pass==='false')||(s==='duplicate'&&a.dataset.duplicate==='true'));a.hidden=!ok;if(ok)count++});document.getElementById('count').textContent='显示'+count+'项'}controls.forEach(x=>x.addEventListener('input',filter));</script></html>`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const outputArg = process.argv.find(arg => arg.startsWith('--output='));
  const output = path.resolve(root, outputArg?.slice(9) || 'artifacts/schematic-100-2026-10-19/after');
  const report = await runSchematicSuite(output);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Gallery: ${path.join(output, 'index.html')}`);
  // A testing job must not silently report success for an unmet 100-distinct target.
  process.exitCode = report.summary.accepted === 100 ? 0 : 1;
}
