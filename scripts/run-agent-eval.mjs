// 电路智能体评测器：对确定性核心（需求解析/生成/修订/求解/检索/审查）按
// evaluation/circuit-eval-v1.json 的用例逐项评分，输出通过率报告。
// 用法：
//   node scripts/run-agent-eval.mjs                      # 运行评测，写 evaluation/eval-report.json
//   node scripts/run-agent-eval.mjs --save-baseline      # 另存基线 report
//   node scripts/run-agent-eval.mjs --compare            # 与 evaluation/eval-baseline.json 对比
//   node scripts/run-agent-eval.mjs --ai                 # 额外用已配置的 AI 接口给增强建议打分（消耗模型额度）
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { KnowledgeDatabase } = require('./../src/main/knowledge-db.cjs');
const core = await import('./../src/shared/core.mjs');
const { parseRequirement, generateCircuit, reviseCircuit, supervisePlan, solveCircuitProblem, knowledgeSearch } = core;

const DATASET_PATH = path.join(root, 'evaluation', 'circuit-eval-v1.json');
const REPORT_PATH = path.join(root, 'evaluation', 'eval-report.json');
const BASELINE_PATH = path.join(root, 'evaluation', 'eval-baseline.json');

function matches(value, pattern) {
  return new RegExp(pattern).test(String(value ?? ''));
}

function gradeExpectation(expect, ctx) {
  const failures = [];
  const has = (key) => Object.prototype.hasOwnProperty.call(expect, key);
  if (has('kind') && ctx.plan?.kind !== expect.kind) failures.push(`kind(${ctx.plan?.kind}≠${expect.kind})`);
  if (has('highRisk') && ctx.parsed?.highRisk !== expect.highRisk) failures.push(`highRisk(${ctx.parsed?.highRisk})`);
  if (has('topologyRegex') && !matches(ctx.plan?.topology, expect.topologyRegex)) failures.push('topologyRegex');
  if (has('refsInclude')) {
    const refs = new Set((ctx.plan?.components || []).map((item) => item.ref));
    for (const ref of expect.refsInclude) if (!refs.has(ref)) failures.push(`refsInclude(${ref})`);
  }
  if (has('refsExclude')) {
    const refs = new Set((ctx.plan?.components || []).map((item) => item.ref));
    for (const ref of expect.refsExclude) if (refs.has(ref)) failures.push(`refsExclude(${ref})`);
  }
  if (has('valueMatches')) {
    for (const [ref, pattern] of Object.entries(expect.valueMatches)) {
      const component = (ctx.plan?.components || []).find((item) => item.ref === ref);
      if (!component || !matches(component.value, pattern)) failures.push(`valueMatches(${ref})`);
    }
  }
  if (has('missingEmpty') && expect.missingEmpty && (ctx.plan?.missingParameters || []).length) failures.push('missingEmpty');
  if (has('missingIncludeAny')) {
    const missing = (ctx.plan?.missingParameters || []).join('、');
    if (!expect.missingIncludeAny.some((keyword) => missing.includes(keyword))) failures.push('missingIncludeAny');
  }
  if (has('missingExclude')) {
    const missing = (ctx.plan?.missingParameters || []).join('、');
    if (expect.missingExclude.some((keyword) => missing.includes(keyword))) failures.push('missingExclude');
  }
  if (has('confidenceMax') && !(Number(ctx.plan?.confidence) <= expect.confidenceMax)) failures.push(`confidenceMax(${ctx.plan?.confidence})`);
  if (has('confidenceMin') && !(Number(ctx.plan?.confidence) >= expect.confidenceMin)) failures.push(`confidenceMin(${ctx.plan?.confidence})`);
  if (has('warningsAny')) {
    const warnings = (ctx.plan?.warnings || []).join('｜');
    if (!expect.warningsAny.some((keyword) => warnings.includes(keyword))) failures.push('warningsAny');
  }
  if (has('knowledgeMin') && !((ctx.plan?.knowledgeEvidence || []).length >= expect.knowledgeMin)) failures.push('knowledgeMin');
  if (has('equationsRegex') && !matches((ctx.plan?.equations || []).join('；'), expect.equationsRegex)) failures.push('equationsRegex');
  if (has('engineeringChecksRegex') && !matches((ctx.plan?.engineeringChecks || []).join('；'), expect.engineeringChecksRegex)) failures.push('engineeringChecksRegex');
  if (has('pcbTipsRegex') && !matches((ctx.plan?.pcbTips || []).join('；'), expect.pcbTipsRegex)) failures.push('pcbTipsRegex');
  if (has('mustConfirmMin') && !((ctx.plan?.clarifyingQuestions || []).length >= expect.mustConfirmMin)) failures.push('mustConfirmMin');
  if (has('auditDecision') && ctx.audit?.decision !== expect.auditDecision) failures.push(`auditDecision(${ctx.audit?.decision})`);
  if (has('specs')) {
    for (const [key, value] of Object.entries(expect.specs)) {
      if (Number(ctx.plan?.specs?.[key]) !== Number(value)) failures.push(`specs.${key}(${ctx.plan?.specs?.[key]})`);
    }
  }
  if (has('designParameters')) {
    for (const [key, value] of Object.entries(expect.designParameters)) {
      const actual = ctx.plan?.designParameters?.[key];
      if (typeof value === 'number' ? Number(actual) !== Number(value) : actual !== value) failures.push(`designParameters.${key}(${actual})`);
    }
  }
  if (has('revisionNumberMin') && !(Number(ctx.plan?.revisionNumber) >= expect.revisionNumberMin)) failures.push(`revisionNumberMin(${ctx.plan?.revisionNumber})`);
  if (has('failingTitlesAny')) {
    const failing = (ctx.audit?.checks || []).filter((check) => check.status !== 'pass').map((check) => check.title);
    if (!expect.failingTitlesAny.some((title) => failing.includes(title))) failures.push(`failingTitlesAny(${failing.join('/') || '无'})`);
  }
  return failures;
}

function runGenerationCase(testCase) {
  const knowledge = ctx.builtinKnowledge;
  const plan = generateCircuit(testCase.input.requirement, knowledge);
  const audit = supervisePlan(plan, testCase.input.requirement);
  return gradeExpectation(testCase.expect, { plan, audit, parsed: parseRequirement(testCase.input.requirement) });
}

function runRevisionCase(testCase) {
  const knowledge = ctx.builtinKnowledge;
  let plan = generateCircuit(testCase.input.baseRequirement, knowledge);
  for (const step of testCase.input.steps) plan = reviseCircuit(plan, step, knowledge);
  const audit = supervisePlan(plan, plan.requirement);
  return gradeExpectation(testCase.expect, { plan, audit, parsed: parseRequirement(plan.requirement) });
}

function runSolverCase(testCase) {
  const result = solveCircuitProblem(testCase.input.question);
  const failures = [];
  const expect = testCase.expect;
  if (expect.answerRegex && !matches(result.answer, expect.answerRegex)) failures.push(`answerRegex(${result.answer})`);
  if (expect.formulaRegex && !matches(result.formula, expect.formulaRegex)) failures.push(`formulaRegex(${result.formula})`);
  if (hasOwn(expect, 'confidenceMin') && !(Number(result.confidence) >= expect.confidenceMin)) failures.push(`confidenceMin(${result.confidence})`);
  if (hasOwn(expect, 'confidenceMax') && !(Number(result.confidence) <= expect.confidenceMax)) failures.push(`confidenceMax(${result.confidence})`);
  if (hasOwn(expect, 'warningsMin') && !((result.warnings || []).length >= expect.warningsMin)) failures.push('warningsMin');
  if (expect.warningsAny) {
    const warnings = (result.warnings || []).join('｜');
    if (!expect.warningsAny.some((keyword) => warnings.includes(keyword))) failures.push('warningsAny');
  }
  if (hasOwn(expect, 'stepsMin') && !((result.steps || []).length >= expect.stepsMin)) failures.push('stepsMin');
  return failures;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

async function runRetrievalCase(testCase) {
  const expect = testCase.expect;
  if (testCase.input.source === 'sqlite') {
    const { hits } = ctx.knowledgeDb.searchWithTrace(testCase.input.query, { strength: 'deep' });
    const topTitles = hits.slice(0, testCase.input.topN).map((hit) => `${hit.title} ${hit.content}`);
    const pass = topTitles.some((text) => matches(text, expect.titleRegex));
    return pass ? [] : [`titleRegex(前${testCase.input.topN}未命中:${hits.slice(0, 2).map((hit) => hit.title).join('/')})`];
  }
  const hits = knowledgeSearch(ctx.builtinKnowledge, testCase.input.query, testCase.input.topN);
  const topTitles = hits.map((hit) => `${hit.title} ${(hit.content || '').slice(0, 200)}`);
  const pass = topTitles.some((text) => matches(text, expect.titleRegex));
  return pass ? [] : [`titleRegex(前${testCase.input.topN}未命中:${hits.slice(0, 2).map((hit) => hit.title).join('/')})`];
}

const ctx = { builtinKnowledge: [], knowledgeDb: null };

async function prepare() {
  const [basic, advanced] = await Promise.all([
    readFile(path.join(root, 'knowledge', 'basic-circuits.json'), 'utf8'),
    readFile(path.join(root, 'knowledge', 'advanced-circuits.json'), 'utf8'),
  ]);
  ctx.builtinKnowledge = [...JSON.parse(basic), ...JSON.parse(advanced)];
  const directory = await mkdtemp(path.join(tmpdir(), 'circuit-eval-'));
  ctx.knowledgeDb = new KnowledgeDatabase(
    path.join(directory, 'eval.sqlite3'),
    await readFile(path.join(root, 'database', 'schema.sql'), 'utf8'),
  );
  const sources = JSON.parse(await readFile(path.join(root, 'knowledge', 'public-web-sources.json'), 'utf8'));
  for (const source of sources) ctx.knowledgeDb.importWebSource(source);
}

function teardown() {
  ctx.knowledgeDb?.close();
}

async function main() {
  const args = process.argv.slice(2);
  const saveBaseline = args.includes('--save-baseline');
  const compare = args.includes('--compare');
  const dataset = JSON.parse(await readFile(DATASET_PATH, 'utf8'));
  await prepare();

  const results = [];
  for (const testCase of dataset.cases) {
    let failures = [];
    try {
      if (testCase.dimension === 'generation' || testCase.dimension === 'safety') failures = runGenerationCase(testCase);
      else if (testCase.dimension === 'revision') failures = runRevisionCase(testCase);
      else if (testCase.dimension === 'solver') failures = runSolverCase(testCase);
      else if (testCase.dimension === 'retrieval') failures = await runRetrievalCase(testCase);
      else if (testCase.dimension === 'review') {
        const audit = supervisePlan(testCase.input.plan, testCase.input.plan.requirement);
        failures = gradeExpectation(testCase.expect, { plan: testCase.input.plan, audit });
      } else failures = [`未知维度 ${testCase.dimension}`];
    } catch (error) {
      failures = [`执行异常: ${error.message}`];
    }
    results.push({
      id: testCase.id,
      dimension: testCase.dimension,
      difficulty: testCase.difficulty,
      title: testCase.title,
      pass: failures.length === 0,
      failures,
    });
  }
  teardown();

  const byDimension = {};
  const byDifficulty = {};
  for (const result of results) {
    byDimension[result.dimension] ??= { pass: 0, total: 0 };
    byDimension[result.dimension].total += 1;
    byDimension[result.dimension].pass += result.pass ? 1 : 0;
    byDifficulty[result.difficulty] ??= { pass: 0, total: 0 };
    byDifficulty[result.difficulty].total += 1;
    byDifficulty[result.difficulty].pass += result.pass ? 1 : 0;
  }
  const passed = results.filter((result) => result.pass).length;
  const report = {
    format: 'circuit-assistant-eval-report-v1',
    dataset: dataset.format,
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: Number((passed / results.length).toFixed(4)),
    byDimension,
    byDifficulty,
    failures: results.filter((result) => !result.pass),
    results,
  };

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  if (saveBaseline) {
    await writeFile(BASELINE_PATH, JSON.stringify(report, null, 2), 'utf8');
    console.log(`基线已保存：${BASELINE_PATH}`);
  }
  if (compare) {
    try {
      const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
      console.log(`\n与基线对比：${baseline.passRate * 100}% → ${report.passRate * 100}%`);
      for (const dimension of Object.keys(byDimension)) {
        const before = baseline.byDimension[dimension]?.pass ?? 0;
        const after = byDimension[dimension].pass;
        if (before !== after) console.log(`  ${dimension}: ${before} → ${after} / ${byDimension[dimension].total}`);
      }
      const fixed = report.results.filter((now) => !now.pass && baseline.results.find((old) => old.id === now.id)?.pass === false);
      const regressed = report.results.filter((now) => !now.pass && baseline.results.find((old) => old.id === now.id)?.pass);
      console.log(`  修复 ${fixed.length} 项，回退 ${regressed.length} 项${regressed.length ? '：' + regressed.map((item) => item.id).join('、') : ''}`);
    } catch {
      console.log('（未找到基线文件，跳过对比）');
    }
  }

  console.log(`\n电路智能体评测：${passed}/${results.length} 通过（${(report.passRate * 100).toFixed(1)}%）\n`);
  console.log('按维度：');
  for (const [dimension, stat] of Object.entries(byDimension)) {
    console.log(`  ${dimension.padEnd(11)} ${stat.pass}/${stat.total}`);
  }
  console.log('按难度：');
  for (const difficulty of Object.keys(byDifficulty).sort()) {
    const stat = byDifficulty[difficulty];
    console.log(`  L${difficulty}         ${stat.pass}/${stat.total}`);
  }
  const failing = results.filter((result) => !result.pass);
  if (failing.length) {
    console.log('\n未通过用例：');
    for (const result of failing) {
      console.log(`  [L${result.difficulty}] ${result.id} ${result.title}`);
      for (const failure of result.failures) console.log(`      - ${failure}`);
    }
  }
  process.exitCode = failing.length ? 1 : 0;
}

await main();
