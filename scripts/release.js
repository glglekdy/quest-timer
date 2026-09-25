/*
 * release.js - 릴리스 노트를 붙여 GitHub 에 올린다.
 *
 *   npm run release
 *
 * build/release-<버전>.md 가 있어야 올린다. 그 본문이 GitHub 릴리스 본문이 되고,
 * 앱은 업데이트 뒤 처음 켜질 때 그 본문을 받아 "바뀐 것"으로 보여준다.
 * 노트 없이 올리면 업데이트한 사람이 무엇이 바뀌었는지 모른 채 넘어가게 되므로
 * 여기서 막는다.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const version = require(path.join(ROOT, 'package.json')).version;
const notes = 'build/release-' + version + '.md';

if (!fs.existsSync(path.join(ROOT, notes)) || !fs.readFileSync(path.join(ROOT, notes), 'utf8').trim()) {
  console.error('릴리스 노트가 없습니다: ' + notes);
  console.error('"## 바뀐 것" 과 "## 받는 곳" 두 절로 적어주세요 (CLAUDE.md 참고).');
  process.exit(1);
}

// 뒤에 붙인 인자는 electron-builder 에 그대로 넘긴다. dist 가 다른 프로그램에
// 잡혀 지워지지 않을 때 `npm run release -- -c.directories.output=dist-release` 처럼 쓴다.
const extra = process.argv.slice(2);
const result = spawnSync('npx', ['electron-builder', '--publish', 'always',
  '-c.releaseInfo.releaseNotesFile=' + notes, ...extra],
{ cwd: ROOT, stdio: 'inherit', shell: true });
if (result.status !== 0) process.exit(result.status == null ? 1 : result.status);

// ── 앱만 바꾸는 업데이트 ────────────────────────────────────
// 설치 파일과 함께 app.asar 만 따로 올린다. Electron 주 버전이 같은 앱은 설치
// 파일 대신 이것만 받아 바꿔 끼운다 (main.js 의 findAppPatch).
const outArg = extra.find((a) => /^-c\.directories\.output=/.test(a));
const out = path.resolve(ROOT, outArg ? outArg.split('=').slice(1).join('=') : 'dist');
const asarPath = path.join(out, 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(asarPath)) {
  console.error('app.asar 를 찾지 못해 앱 업데이트 파일을 올리지 못했습니다: ' + asarPath);
  process.exit(1);
}

const asar = fs.readFileSync(asarPath);
const patchName = 'Quest-Timer-' + version + '-app.asar.gz';
const patchPath = path.join(out, patchName);
fs.writeFileSync(patchPath, zlib.gzipSync(asar, { level: 9 }));

const electron = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const manifestPath = path.join(out, 'app-update.json');
fs.writeFileSync(manifestPath, JSON.stringify({
  version,
  electron: electron.split('.')[0],
  file: patchName,
  sha512: crypto.createHash('sha512').update(asar).digest('base64'),
}, null, 2));

const upload = spawnSync('gh', ['release', 'upload', 'v' + version, patchPath, manifestPath,
  '--clobber', '-R', 'glglekdy/quest-timer'], { cwd: ROOT, stdio: 'inherit' });
if (upload.status !== 0) {
  console.error('앱 업데이트 파일을 올리지 못했습니다. 이대로면 설치 파일을 통째로 받게 됩니다.');
  process.exit(upload.status == null ? 1 : upload.status);
}
console.log('앱 업데이트 파일을 올렸습니다: ' + patchName + ' (' + Math.round(fs.statSync(patchPath).size / 1024) + 'KB)');
