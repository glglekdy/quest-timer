/*
 * check-widget.js - 배경 위젯이 제때 뜨고 지는지 실제 앱으로 확인한다.
 *
 *   npx electron scripts/check-widget.js
 *
 * 앱 창을 최소화해 "뒤로 물러난" 상황을 만들고, 그때 위젯이 떠서 남은 시간과
 * 다음 휴식까지를 적어주는지 본다. shots/widget.png 도 한 장 남긴다.
 * 저장 위치는 임시 폴더로 돌려놓아 평소 기록에는 손대지 않는다.
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'quest-widget-check-')));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = new Promise((resolve) => ipcMain.once('renderer:ready', resolve));
require(path.join(ROOT, 'main.js'));

/**
 * 두 창 가운데 a 가 화면에서 더 앞에 놓였는가. Electron 에는 창 겹침 순서를
 * 묻는 길이 없어 Windows 에 직접 묻는다 - EnumWindows 는 맨 앞 창부터 돌려준다.
 */
function isInFront(a, b) {
  const handle = (w) => {
    const buf = w.getNativeWindowHandle();
    return buf.length >= 8 ? buf.readBigInt64LE().toString() : String(buf.readInt32LE());
  };
  const script = path.join(os.tmpdir(), 'quest-widget-zorder.ps1');
  fs.writeFileSync(script, `param([Int64]$a, [Int64]$b)
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class ZOrder {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  public static List<long> List() { var r = new List<long>(); EnumWindows((h, l) => { r.Add(h.ToInt64()); return true; }, IntPtr.Zero); return r; }
}
'@
$order = [ZOrder]::List()
$order.IndexOf($a) -lt $order.IndexOf($b)
`);
  const out = require('node:child_process').execFileSync('powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, handle(a), handle(b)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  return out.trim() === 'True';
}

/** 지금 떠 있는 위젯 창. 없으면 null. */
function widgetWindow() {
  return BrowserWindow.getAllWindows()
    .find((w) => w.webContents.getURL().endsWith('widget.html')) || null;
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('시간이 너무 걸립니다'); app.exit(1); }, 60000);
  await ready;

  const win = BrowserWindow.getAllWindows()[0];
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // 퀘스트 하나를 적어 고르고, 휴식을 포함한 50분 구간을 시작한다
  // (집중 25분 + 휴식 5분 + 집중 20분)
  await js(`document.getElementById('composeOpen').click();
    document.getElementById('questTitle').value = '수학 문제집 2쪽';
    document.getElementById('questMinutes').value = '50';
    document.getElementById('compose').requestSubmit(); 1;`);
  await wait(200);
  await js(`document.querySelector('#listOnce .quest').click(); 1;`);
  await wait(120);
  await js(`document.getElementById('includeBreaks').click();
    document.getElementById('planMinutes').value = 50;
    document.getElementById('planMinutes').dispatchEvent(new Event('change'));
    document.getElementById('btnGo').click(); 1;`);
  await wait(300);

  assert.equal(widgetWindow(), null, '앱을 보고 있는 동안에는 위젯이 없어야 한다');

  // 앱을 최소화하면 = 뒤로 물러나면 위젯이 떠야 한다
  win.minimize();
  await wait(900);
  const widget = widgetWindow();
  assert.ok(widget && widget.isVisible(), '물러나면 위젯이 뜬다');

  const readWidget = (code) => widget.webContents.executeJavaScript(code, true);
  const line = await readWidget(
    `[document.getElementById('state').textContent,
      document.getElementById('clock').textContent,
      document.getElementById('turnText').textContent].join(' ')`
  );
  assert.match(line, /집중하는 중 49:\d\d 다음 휴식까지 24:\d\d/, '위젯에 적힌 줄: ' + line);
  assert.equal(await readWidget(`document.getElementById('title').textContent`), '수학 문제집 2쪽');
  assert.ok(await readWidget(`Number(document.getElementById('markFill').style.strokeDashoffset) > 0`),
    '위젯 링도 함께 줄어든다');
  // 한글은 Pretendard 로 그린다. 글꼴이 빠지면 Malgun Gothic 으로 조용히 바뀌므로
  // 눈으로는 알아채기 어렵다 - 여기서 잡는다.
  assert.ok(await readWidget(`document.fonts.check('700 16px Pretendard')`), '한글 글꼴이 실린다');
  assert.ok(await js(`document.fonts.check('700 16px Pretendard') && document.fonts.check('14px Inter')`),
    '앱 창에도 두 글꼴이 실린다');

  // 끌어서 옮기면 그 자리를 적어둔다 (다음에 뜰 때 거기서 뜬다)
  const before = widget.getBounds();
  for (const step of [{ phase: 'start', x: 600, y: 600 }, { phase: 'move', x: 640, y: 560 },
    { phase: 'end', x: 640, y: 560 }]) ipcMain.emit('widget:drag', {}, step);
  const after = widget.getBounds();
  assert.deepEqual([after.x, after.y], [before.x + 40, before.y - 40], '끈 만큼 따라온다');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'widget.json'), 'utf8')),
    { x: after.x, y: after.y, scale: 1 }, '옮긴 자리를 적어둔다');

  fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shots/widget.png'), (await widget.webContents.capturePage()).toPNG());

  // 다른 앱의 '항상 위' 창이 나중에 앞으로 나와 위젯을 덮어도, 곧 위젯이 다시 맨 앞으로 온다
  const spot = widget.getBounds();
  const cover = new BrowserWindow({ x: spot.x - 20, y: spot.y - 20, width: spot.width + 40,
    height: spot.height + 40, show: false, frame: false, alwaysOnTop: true, skipTaskbar: true });
  await cover.loadURL('data:text/html,<body style="background:%23400"></body>');
  cover.setIgnoreMouseEvents(true); // 검사하는 동안 누가 눌러도 흐트러지지 않게
  cover.show();
  cover.focus();
  await wait(1500);
  assert.ok(isInFront(widget, cover), '다른 항상 위 창에 덮여도 1초 안에 다시 맨 앞으로 온다');
  assert.equal(widget.isFocused(), false, '맨 앞으로 오면서 포커스를 뺏지 않는다');
  assert.deepEqual(widget.getBounds(), spot, '다시 올리는 동안 자리와 크기는 그대로다');
  cover.destroy();

  // 휠을 올리면 커진다. 오른쪽 아래에 놓인 위젯이니 오른쪽 아래 모서리는 제자리다.
  const wheelUp = () => widget.webContents.sendInputEvent(
    { type: 'mouseWheel', x: 60, y: 40, deltaX: 0, deltaY: 120, wheelTicksY: 1, canScroll: true });
  wheelUp();
  await wait(400);
  const grown = widget.getBounds();
  assert.deepEqual([grown.width, grown.height], [387, 97], '휠을 올리면 한 칸(10%) 커진다: ' + JSON.stringify(grown));
  assert.deepEqual([grown.x + grown.width, grown.y + grown.height],
    [after.x + after.width, after.y + after.height], '화면 가장자리 쪽 모서리는 그대로다');
  assert.equal(widget.webContents.getZoomFactor().toFixed(2), '1.10', '글자와 링도 함께 커진다');
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'widget.json'), 'utf8')).scale, 1.1,
    '배율도 적어둔다');
  // 카드가 창을 꼭 채운다 (확대된 뒤에도 글이 잘리거나 빈 테두리가 남지 않는다)
  assert.equal(await readWidget(`(() => { const r = document.getElementById('card').getBoundingClientRect();
    return Math.round(r.right) === innerWidth && Math.round(r.bottom) === innerHeight; })()`), true, '카드가 창을 채운다');

  // 끝까지 줄여도 최소 배율(0.7)에서 멈춘다
  for (let i = 0; i < 8; i++) ipcMain.emit('widget:resize', {}, -1);
  const least = widget.getBounds();
  assert.deepEqual([least.width, least.height], [246, 62], '0.7배에서 더 줄지 않는다: ' + JSON.stringify(least));
  ipcMain.emit('widget:resize', {}, 3);
  assert.equal(widget.getBounds().width, 352, '다시 키울 수 있다');

  // 앱으로 돌아오면 위젯은 물러난다
  win.restore();
  win.focus();
  await wait(900);
  assert.equal(widget.isVisible(), false, '앱이 앞에 오면 위젯이 사라진다');

  // 구간을 끝내면 앱을 다시 내려도 뜨지 않는다
  await js(`document.getElementById('btnStop').click(); 1;`);
  await wait(300);
  win.minimize();
  await wait(900);
  assert.equal(widget.isVisible(), false, '돌아가는 구간이 없으면 뜨지 않는다');

  assert.deepEqual(errors, []);
  console.log('PASS: 물러나면 뜨고, 돌아오면 지고, 남은 시간과 다음 휴식을 적는다');
  clearTimeout(watchdog);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
