const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '../..');
const archive = path.join(__dirname, 'build/win-unpacked/resources/app.asar');
const files = ['src/shared/core.mjs', 'src/shared/layout-agent.mjs', 'src/shared/schematic-netlist.mjs',
  'src/shared/reference-schematics.mjs', 'src/renderer/app.js', 'src/main/knowledge-db.cjs',
  'database/schema.sql', 'knowledge/basic-circuits.json', 'knowledge/advanced-circuits.json', 'knowledge/public-web-sources.json'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const checks = files.map(file => {
  const sourceHash = sha(fs.readFileSync(path.join(root, file)));
  const packagedHash = sha(asar.extractFile(archive, path.normalize(file)));
  return { file, sourceHash, packagedHash, pass: sourceHash === packagedHash };
});
const { scripts, devDependencies, build, ...runtimePackage } = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const packaged = JSON.parse(asar.extractFile(archive, 'package.json'));
const smoke = JSON.parse(fs.readFileSync(path.join(__dirname, 'packaged-ui/ui-smoke.json')));
const report = { checkedAt: new Date().toISOString(), archive, passed: checks.filter(c => c.pass).length,
  total: checks.length, checks, runtimePackageMatches: isDeepStrictEqual(runtimePackage, packaged),
  packagedUi: { passed: smoke.checks.filter(c => c.passed).length, total: smoke.checks.length } };
fs.writeFileSync(path.join(__dirname, 'build-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, total: report.total, runtimePackageMatches: report.runtimePackageMatches, packagedUi: report.packagedUi }));
if (report.passed !== report.total || !report.runtimePackageMatches || report.packagedUi.passed !== report.packagedUi.total) process.exitCode = 1;
