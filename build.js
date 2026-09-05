#!/usr/bin/env node
// Concatenates src/*.js in order into dist/pine-mini.user.js, stamping the
// version from package.json into the userscript header AND the in-script
// SCRIPT_VERSION constant, so the two can never drift. Also injects
// @updateURL/@downloadURL from package.json "pineBot.rawBase" so
// Violentmonkey/Tampermonkey self-update on every push to main.
const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');
const srcDir = path.join(__dirname, 'src');
const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).sort();
let out = files.map(f => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');

const v = pkg.version;
let n = 0;
out = out.replace(/^\/\/ @version\s+\S+$/m, () => { n++; return `// @version      ${v}`; });
out = out.replace(/const SCRIPT_VERSION = '[^']+';/, () => { n++; return `const SCRIPT_VERSION = '${v}';`; });
if (n !== 2) { console.error('build: version stamp failed (found ' + n + '/2 sites)'); process.exit(1); }

const rawBase = (pkg.pineBot && pkg.pineBot.rawBase) || '';
if (rawBase && !/OWNER\/REPO/.test(rawBase)) {
    const url = rawBase.replace(/\/$/, '') + '/dist/pine-mini.user.js';
    out = out.replace(/^(\/\/ @run-at .*)$/m, `$1\n// @updateURL    ${url}\n// @downloadURL  ${url}`);
} else {
    console.warn('build: pineBot.rawBase in package.json still says OWNER/REPO — @updateURL not injected.');
}

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const outPath = path.join(__dirname, 'dist', 'pine-mini.user.js');
fs.writeFileSync(outPath, out);
console.log(`build: dist/pine-mini.user.js  v${v}  ${files.length} parts  ${(out.length / 1024).toFixed(0)} KB`);
