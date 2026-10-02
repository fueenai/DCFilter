const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const refs = [...manifest.content_scripts.flatMap(s => [...(s.js || []), ...(s.css || [])]), ...Object.values(manifest.icons), manifest.action.default_popup, ...manifest.declarative_net_request.rule_resources.map(r => r.path), ...manifest.web_accessible_resources.flatMap(r => r.resources)];
for (const ref of refs) if (!fs.existsSync(ref)) throw new Error('Missing manifest file: '+ref);
const assets = JSON.parse(fs.readFileSync('models/clip-vit-base-patch32/asset-integrity.json', 'utf8'));
for (const item of assets.files) {
  const fullPath = path.resolve(item.path);
  if (!fullPath.startsWith(root + path.sep)) throw new Error('Asset outside extension: ' + item.path);
  const bytes = fs.readFileSync(fullPath);
  if (bytes.length !== item.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('Local AI asset mismatch: ' + item.path);
}
for (const file of ['src/image-worker.html', 'src/safety-worker.html']) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(file), match[1]))) throw new Error('Missing worker script: ' + match[1]);
  }
}
for (const dir of ['src', 'popup']) for (const name of fs.readdirSync(dir).filter(f=>f.endsWith('.js'))) {
  if (spawnSync(process.execPath, ['--check',path.join(dir,name)], {stdio:'inherit'}).status !== 0) process.exit(1);
}
const html = fs.readFileSync('popup/popup.html','utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate popup IDs');
for (const m of fs.readFileSync('popup/popup.js','utf8').matchAll(/getElementById\("([^"]+)"\)/g)) if(!ids.includes(m[1])) throw new Error('Missing popup control: '+m[1]);
const tests = fs.readdirSync('tests').filter(f=>f.endsWith('.test.cjs')).map(f=>path.join('tests',f));
if (spawnSync(process.execPath,['--test',...tests],{stdio:'inherit'}).status !== 0) process.exit(1);
console.log(`DCFilter ${manifest.version}: manifest, JavaScript, popup references, ${assets.files.length} local AI asset hashes and tests passed.`);
