const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const asar = require('@electron/asar');
const archive = path.join(__dirname, 'build/win-unpacked/resources/app.asar');
const root = path.resolve(__dirname, '../..');
const files = ['knowledge/basic-circuits.json', 'knowledge/advanced-circuits.json',
  'knowledge/public-web-sources.json', 'src/main/knowledge-db.cjs', 'src/shared/core.mjs',
  'database/schema.sql', 'src/main/agent-smoke.cjs'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const checks = files.map(file => {
  const sourceHash = sha(fs.readFileSync(path.join(root, file)));
  // @electron/asar expects native path separators for nested paths on Windows.
  const packagedHash = sha(asar.extractFile(archive, path.normalize(file)));
  return { file, sourceHash, packagedHash, pass: sourceHash === packagedHash };
});
const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const packagedPackage = JSON.parse(asar.extractFile(archive, 'package.json'));
// electron-builder deliberately removes development/build fields from package.json.
const { scripts, devDependencies, build, ...runtimePackage } = sourcePackage;
const packageMetadata = { pass: isDeepStrictEqual(runtimePackage, packagedPackage),
  excludedDevelopmentFields: ['scripts', 'devDependencies', 'build'], version: packagedPackage.version };
const smoke = JSON.parse(fs.readFileSync(path.join(__dirname, 'packaged-ui/ui-smoke.json')));
const report = { archive, checkedAt: new Date().toISOString(),
  passed: checks.filter(c => c.pass).length, total: checks.length, checks, packageMetadata,
  packagedUi: { passed: smoke.checks.filter(c => c.passed).length, total: smoke.checks.length } };
fs.writeFileSync(path.join(__dirname, 'build-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, total: report.total, packageMetadata, packagedUi: report.packagedUi }));
if (report.passed !== report.total || !packageMetadata.pass || report.packagedUi.passed !== report.packagedUi.total) process.exitCode = 1;
