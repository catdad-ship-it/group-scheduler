// Lightweight syntax check for CI and local use (`npm run check`).
//
// The app has no build step and no test suite, so this guards the two things
// that would break the whole app if malformed: the server-side JS, and the
// inline <script> blocks in the single-page client. It's parse-only — nothing
// is executed and no database or network is touched.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let failures = 0;

// Validate a Node file with `node --check` (full parser, catches everything
// `node` itself would reject at load time).
function checkNodeFile(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`ok   ${file}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${file}\n${(e.stderr || e.message || '').toString().trim()}`);
  }
}

// Server-side JS: server.js plus everything in scripts/ (except this checker).
const jsFiles = ['server.js'];
for (const f of fs.readdirSync('scripts')) {
  if (f.endsWith('.js') && f !== path.basename(__filename)) jsFiles.push(path.join('scripts', f));
}
jsFiles.forEach(checkNodeFile);

// Inline <script> blocks in the single-page client. `new Function` compiles
// (parses) the body without running it — a syntax error throws here.
const htmlPath = 'public/index.html';
const html = fs.readFileSync(htmlPath, 'utf8');
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
let inlineCount = 0;
while ((m = re.exec(html))) {
  inlineCount++;
  const startLine = html.slice(0, m.index).split('\n').length;
  try {
    new Function(m[1]); // eslint-disable-line no-new-func -- parse-only syntax check
    console.log(`ok   ${htmlPath} <script> #${inlineCount} (line ${startLine})`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${htmlPath} <script> #${inlineCount} (line ${startLine}): ${e.message}`);
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${jsFiles.length + inlineCount} checks passed.`);
