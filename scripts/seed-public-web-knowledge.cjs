const fs = require('node:fs/promises');
const path = require('node:path');
const { KnowledgeDatabase } = require('../src/main/knowledge-db.cjs');

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const defaultDataRoot = path.join(process.env.APPDATA || projectRoot, 'circuit-assistant');
  const databasePath = path.resolve(option('db') || path.join(defaultDataRoot, 'circuit-knowledge.sqlite3'));
  const sourcesPath = path.resolve(option('sources') || path.join(projectRoot, 'knowledge', 'public-web-sources.json'));
  const sources = JSON.parse(await fs.readFile(sourcesPath, 'utf8'));
  const database = await KnowledgeDatabase.open(databasePath, path.join(projectRoot, 'database', 'schema.sql'));
  try {
    const results = sources.map((source) => database.importWebSource(source));
    const counts = results.reduce((summary, result) => {
      summary[result.status] = (summary[result.status] || 0) + 1;
      return summary;
    }, {});
    process.stdout.write(`${JSON.stringify({ databasePath, counts, stats: database.stats() }, null, 2)}\n`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
