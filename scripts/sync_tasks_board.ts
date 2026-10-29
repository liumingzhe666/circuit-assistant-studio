import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '04_Tasks');
const { tasks } = JSON.parse(readFileSync(resolve(root, 'tasks-status.json'), 'utf8'));
const rows = tasks.map((task: { id: string; title: string; path: string; status: string }) =>
  `| ${task.id} | [${task.title}](${task.path}/plan.md) | ${task.status} |`);
writeFileSync(resolve(root, 'board.md'), '# 全局任务看板\n\n由 tasks-status.json 单向生成，请勿手动编辑。\n\n| ID | 任务 | 状态 |\n| --- | --- | --- |\n' + rows.join('\n') + '\n');
