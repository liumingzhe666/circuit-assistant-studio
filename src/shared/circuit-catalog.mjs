import { analogCatalog } from './catalog-analog.mjs';
import { powerCatalog } from './catalog-power.mjs';
import { mixedCatalog } from './catalog-mixed.mjs';

const priority = ['buffered-divider', 'split-supply'];
export const CIRCUIT_CATALOG = [...powerCatalog, ...analogCatalog, ...mixedCatalog]
  .sort((a,b)=>(priority.includes(b.id)?1:0)-(priority.includes(a.id)?1:0));
export function buildExecutableReference(spec) {
  const text=String(spec.text||'');
  const recipe=CIRCUIT_CATALOG.find(item=>item.match.test(text)&&!item.exclude?.test(text));
  if(!recipe)return null;
  return recipe.build(spec);
}
