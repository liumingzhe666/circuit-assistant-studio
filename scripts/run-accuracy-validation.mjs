// Independent numeric reader/oracles; supports the preserved pre-fix core for comparison.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const option=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const corePath=path.resolve(root,option('core')||'src/shared/core.mjs');
const core=await import(pathToFileURL(corePath));
const dataPath=path.join(root,'evaluation/accuracy-validation-v2.json');
const datasetText=await readFile(dataPath,'utf8');
const dataset=JSON.parse(datasetText);
const knowledge=[...JSON.parse(await readFile(path.join(root,'knowledge/basic-circuits.json'),'utf8')),...JSON.parse(await readFile(path.join(root,'knowledge/advanced-circuits.json'),'utf8'))];
const scales={'':1,k:1e3,M:1e6,G:1e9,m:1e-3,'µ':1e-6,u:1e-6,n:1e-9,p:1e-12};
function number(text,unit,answer=false){
  const match=String(text).match(new RegExp(`${answer?'[=≈]\\s*':''}(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\s*([kMGmµunp]?)\\s*${unit}(?![A-Za-z])`));
  return match?Number(match[1])*scales[match[2]]:null;
}
const close=(actual,expected,relative=.001,absolute=1e-9)=>Number.isFinite(actual)&&Math.abs(actual-expected)<=Math.max(absolute,Math.abs(expected)*relative);
const results=[];
for(const c of dataset.cases){
  const failures=[];
  const check=(condition,message)=>{if(!condition)failures.push(message);};
  const fields=(actual,expected)=>{for(const [key,value]of Object.entries(expected))check(typeof value==='number'?close(actual[key],value):actual[key]===value,`${key}: ${actual[key]} != ${value}`);};
  let actual;
  try{
    if(c.action==='parse'){actual=core.parseRequirement(c.input);fields(actual,c.expected);}
    if(c.action==='risk'){
      const parsed=core.parseRequirement(c.input),plan=core.generateCircuit(c.input,knowledge),audit=core.supervisePlan(plan);
      actual={highRisk:parsed.highRisk,decision:audit.decision};
      check(parsed.highRisk===c.expected.highRisk,'risk classification');
      if(c.expected.highRisk)check(audit.decision==='阻断投板','must block');
    }
    if(c.action==='solve'||c.action==='decline'){
      actual=core.solveCircuitProblem(c.input);
      if(c.action==='decline')check(actual.kind==='needs-ai','must decline missing/invalid conditions');
      else{
        const value=number(actual.answer,c.expected.unit,true);
        check(close(value,c.expected.value,c.expected.relativeTolerance,c.expected.absoluteTolerance),`${actual.answer}; expected ${c.expected.value} ${c.expected.unit}`);
      }
    }
    if(c.action==='revise'){
      const plan=core.reviseCircuit(core.generateCircuit(c.input,knowledge),c.request,knowledge);
      actual={kind:plan.kind,...plan.specs,...plan.designParameters};fields(actual,c.expected);
    }
    if(c.action==='generate'){
      const plan=core.generateCircuit(c.input,knowledge);
      const bom=(ref,unit)=>number(plan.components.find(item=>item.ref===ref)?.value,unit);
      const metric=c.expected.metric;
      let achieved;
      if(metric==='rc'||metric==='highpass')achieved=1/(2*Math.PI*bom('R1','Ω')*bom('C1','F'));
      if(metric==='555')achieved=1.44/((bom('RA','Ω')+2*bom('RB','Ω'))*bom('C1','F'));
      if(metric==='gain'||metric==='inverse')achieved=metric==='inverse'?-bom('R2','Ω')/bom('R1','Ω'):1+bom('R2','Ω')/bom('R1','Ω');
      if(metric==='led'){
        const current=(c.expected.voltage-c.expected.vf-c.expected.drop)/bom('R1','Ω');
        const power=current*current*bom('R1','Ω'),rating=bom('R1','W');
        check(current>0&&current<=c.expected.current,'LED current');
        check(Number.isFinite(rating)&&power<=rating*c.expected.utilizationLimit,'LED resistor rating/derating');
        actual={current,power,rating,components:plan.components};
      }else{
        check(close(achieved,c.expected.value,c.expected.relativeTolerance),`BOM result ${achieved} != target ${c.expected.value}`);
        actual={achieved,topology:plan.topology,components:plan.components};
      }
      if(metric==='highpass')check(/高通/.test(plan.topology),'must implement highpass');
      if(metric==='inverse')check(/反相/.test(plan.topology)&&!/同相/.test(plan.topology),'must implement inverse amplifier');
      check(plan.schematic.layout.connectivity.continuous,'schematic continuity');
    }
    if(c.action==='review'){
      const plan=core.generateCircuit(c.input,knowledge);
      plan.components.find(item=>item.ref===c.mutation.ref).value=c.mutation.value;
      actual=core.supervisePlan(plan);
      check(actual.decision===c.expected.decision,'review decision');
      check(actual.checks.some(item=>item.title===c.expected.failingTitle&&item.status==='fail'),'must independently detect the numeric defect');
    }
  }catch(error){failures.push(error.stack||String(error));}
  results.push({...c,pass:failures.length===0,failures,actual});
}
const byCategory={};
for(const result of results){const stat=byCategory[result.category]??={passed:0,total:0};stat.total++;if(result.pass)stat.passed++;}
const report={format:'circuit-accuracy-validation-report-v2',generatedAt:new Date().toISOString(),core:corePath,datasetHash:createHash('sha256').update(datasetText).digest('hex'),coreHash:createHash('sha256').update(await readFile(corePath)).digest('hex'),
  methodology:dataset.description,total:results.length,passed:results.filter(c=>c.pass).length,failed:results.filter(c=>!c.pass).length,byCategory,results};
const output=path.resolve(root,option('output')||'artifacts/accuracy-optimization-2026-10-16/validation-after.json');
await mkdir(path.dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(`Additional validation: ${report.passed}/${report.total} (${(report.passed/report.total*100).toFixed(1)}%)`);
for(const [name,stat]of Object.entries(byCategory))console.log(`${name}: ${stat.passed}/${stat.total}`);
for(const r of results.filter(c=>!c.pass))console.log(`${r.id}: ${r.failures.join('; ')}`);
process.exitCode=report.failed?1:0;
