const { app, BrowserWindow, Tray, shell, nativeImage, ipcMain, screen, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { dict, resolveLang } = require('./i18n');
const { createStore } = require('./settings');
const P = require('./player');
const { Presence } = require('./discord');
const presence = new Presence();

const HOME = 'https://soundcloud.com/discover';
const APP_ID = 'com.github.soundcloud-desktop';
const ASSETS = path.join(__dirname, '..', 'assets');
// Обычный Chrome UA, чтобы вход через Google/Apple не блокировался как «встроенный браузер»
// Версия Chrome берётся из встроенного Chromium, чтобы UA совпадал с реальными возможностями браузера
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
app.userAgentFallback = UA;

// Хосты, которые открываются внутри приложения (остальное — в системном браузере)
const INTERNAL = [
  /(^|\.)soundcloud\.com$/, /(^|\.)sndcdn\.com$/,
  // вход через Google / Apple / Facebook
  // только google.com и национальные зоны вида google.ru / google.com.tr / google.co.uk
  /(^|\.)google\.com$/, /(^|\.)google\.(com?\.)?[a-z]{2}$/, /(^|\.)googleusercontent\.com$/, /(^|\.)gstatic\.com$/, /(^|\.)youtube\.com$/,
  /(^|\.)apple\.com$/, /(^|\.)facebook\.com$/, /(^|\.)fbcdn\.net$/,
];
const isInternal = (url) => {
  // всплывающее окно входа сначала открывается пустым (about:blank), потом уходит на страницу провайдера
  if (!url || url === 'about:blank' || url.startsWith('about:')) return true;
  try { return INTERNAL.some((r) => r.test(new URL(url).hostname)); } catch { return false; }
};

// Перенос профиля (вход в аккаунт) из ранней сборки «SoundCloud Client»
(() => {
  const now = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'SoundCloud Client');
  try {
    if (now !== old && fs.existsSync(path.join(old, 'Partitions')) && !fs.existsSync(path.join(now, 'Partitions'))) {
      fs.cpSync(old, now, { recursive: true, filter: (src) => !/Singleton|lockfile/i.test(src) });
    }
  } catch {}
})();

app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const store = createStore(app.getPath('userData'));
let win, widget, settingsWin, tray, quitting = false;
let state = { title: '', playing: false, volume: 100, muted: false };
let lang = 'en';
const t = (k) => (dict[lang] && dict[lang][k]) || dict.en[k] || k;
const iconPath = path.join(ASSETS, 'icon.ico');
const stateFile = path.join(app.getPath('userData'), 'window-state.json');
const startHidden = process.argv.includes('--hidden');

const readJson = (f, def) => { try { return { ...def, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return def; } };
function saveWinState() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(stateFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
}
const alive = (w) => w && !w.isDestroyed();

// ---------- Плеер ----------
const exec = (code) => (alive(win) ? win.webContents.executeJavaScript(code, true).catch(() => null) : Promise.resolve(null));
const act = (code, delay = 150) => exec(code).then(() => setTimeout(syncState, delay));
const playPause = () => act(P.playPause);
const next = () => act(P.next, 400);
const prev = () => act(P.prev, 400);

// Сайт меняет громкость только шагами по 10%. Если текущее значение не кратно 10
// (выставлено ползунком SoundCloud), первый шаг выравнивает его к ближайшему делению.
let volBusy = Promise.resolve();
function setVolume(target) {
  target = Math.round(Math.min(Math.max(+target || 0, 0), 100) / 10) * 10;
  volBusy = volBusy.then(async () => {
    let s = await exec(P.READ_STATE);
    if (!s) return;
    if (s.muted && target > 0) {
      await exec(P.mute);
      s = (await exec(P.READ_STATE)) || s; // громкость после включения звука, а не та, что была при выключенном
    }
    for (let guard = 0; guard < 12 && s.volume !== target; guard++) {
      const diff = target - s.volume;
      const steps = Math.sign(diff) * Math.max(1, Math.round(Math.abs(diff) / 10));
      await exec(P.volumeStepsJs(steps));
      const after = await exec(P.READ_STATE);
      if (!after || after.volume === s.volume) break; // упёрлись в 0 или 100
      s = after;
    }
    syncState();
  }).catch(() => {});
}

// Цвет по обложке: уменьшаем картинку до 1×1 пикселя. Храним только последний цвет.
let artCache = { url: null, color: null };
async function artColor(url) {
  if (!url) return null;
  if (artCache.url === url) return artCache.color;
  try {
    const res = await net.fetch(url);
    const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer())).resize({ width: 1, height: 1, quality: 'good' });
    const [b, g, r] = img.toBitmap();
    artCache = { url, color: { r, g, b } };
    return artCache.color;
  } catch { return null; }
}

// Номер запроса: ответ старого опроса, пришедший после нового, отбрасываем
let lastPlaying = null, lastTitle = null, syncSeq = 0;
function syncState() {
  const seq = ++syncSeq;
  exec(P.READ_STATE).then(async (s) => {
    if (!s || seq !== syncSeq) return;
    state = s;
    presence.update(s);
    if (s.playing !== lastPlaying) { lastPlaying = s.playing; thumbar(); refreshTray(); }
    if (s.title !== lastTitle) { lastTitle = s.title; refreshTray(); updateWidgetVisibility(); }
    if (!alive(widget) || !widget.isVisible()) return;
    if (store.get('widgetTheme') === 'art') s.artColor = await artColor(s.art);
    if (seq === syncSeq && alive(widget)) widget.webContents.send('state', s);
  }).catch(() => {});
}
setInterval(() => {
  // Discord тоже нужно обновлять, даже когда окно и мини-плеер спрятаны
  if ((alive(widget) && widget.isVisible()) || (alive(win) && win.isVisible()) || store.get('discord')) syncState();
}, 1000);

// Win+D («Показать рабочий стол») прячет окна приложений. Окна-инструменты
// (WS_EX_TOOLWINDOW, как у гаджетов и всплывающих панелей) он не трогает, поэтому
// мини-плееру ставим этот стиль. Подстраховка: если на переднем плане оказался
// рабочий стол, поднимаем плеер обратно, не забирая фокус.
// (Назначать владельцем окно рабочего стола нельзя: такое окно всегда оказывается под остальными.)
let makeToolWindow = () => {};
let raiseTopmost = () => {};
let dropTopmost = () => {};
let desktopIsForeground = () => false;
let winState = () => ({});           // что Windows сделала с окном: свернула, скрыла, «замаскировала»
let showNoActivate = () => {};       // вернуть свёрнутое окно, не забирая фокус
let forceForeground = () => false;   // вывести окно на передний план (для меню из трея)
let mouseDown = () => false;         // нажата ли сейчас левая или правая кнопка мыши
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const IsIconic = user32.func('bool __stdcall IsIconic(intptr hwnd)');
    const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr hwnd)');
    const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr hwnd, int cmd)');
    const DwmGetWindowAttribute = dwmapi.func('int __stdcall DwmGetWindowAttribute(intptr hwnd, uint attr, void *out, uint size)');
    const cloakBuf = Buffer.alloc(4);
    winState = (w) => {
      try {
        const h = w.getNativeWindowHandle().readBigInt64LE(0);
        DwmGetWindowAttribute(h, 14, cloakBuf, 4); // DWMWA_CLOAKED
        return { iconic: IsIconic(h), visible: IsWindowVisible(h), cloaked: cloakBuf.readUInt32LE(0) };
      } catch (e) { return { error: String(e) }; }
    };
    showNoActivate = (w) => { try { ShowWindow(w.getNativeWindowHandle().readBigInt64LE(0), 4); } catch {} }; // SW_SHOWNOACTIVATE
    const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr hwnd)');
    const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int key)');
    forceForeground = (w) => { try { return SetForegroundWindow(w.getNativeWindowHandle().readBigInt64LE(0)); } catch { return false; } };
    mouseDown = () => { try { return (GetAsyncKeyState(0x01) & 0x8000) !== 0 || (GetAsyncKeyState(0x02) & 0x8000) !== 0; } catch { return false; } };
    // дескрипторы передаём числами, без указателей
    const GetWindowLongPtrW = user32.func('intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)');
    const SetWindowLongPtrW = user32.func('intptr __stdcall SetWindowLongPtrW(intptr hwnd, int index, intptr value)');
    const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint flags)');
    const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
    const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr hwnd, void *buf, int max)');
    const GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80n, WS_EX_APPWINDOW = 0x40000n;
    const HWND_TOPMOST = -1, SWP = 0x0001 | 0x0002 | 0x0010; // NOSIZE | NOMOVE | NOACTIVATE
    const hwndOf = (w) => w.getNativeWindowHandle().readBigInt64LE(0);
    makeToolWindow = (w) => {
      try {
        const h = hwndOf(w);
        const ex = BigInt(GetWindowLongPtrW(h, GWL_EXSTYLE));
        SetWindowLongPtrW(h, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW);
        if (store.get('widgetOnTop')) SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP | 0x0020); // + FRAMECHANGED
      } catch {}
    };
    raiseTopmost = (w) => { try { SetWindowPos(hwndOf(w), HWND_TOPMOST, 0, 0, 0, 0, SWP | 0x0040); } catch {} }; // + SHOWWINDOW
    dropTopmost = (w) => { try { SetWindowPos(hwndOf(w), -2, 0, 0, 0, 0, SWP); } catch {} }; // HWND_NOTOPMOST
    const buf = Buffer.alloc(128);
    desktopIsForeground = () => {
      try {
        const n = GetClassNameW(GetForegroundWindow(), buf, 64);
        const cls = buf.toString('utf16le', 0, n * 2);
        return cls === 'WorkerW' || cls === 'Progman';
      } catch { return false; }
    };
  } catch {}
}
// Журнал для диагностики Win+D: %APPDATA%\SoundCloud Desktop\debug.log (не больше ~64 КБ)
const debugFile = path.join(app.getPath('userData'), 'debug.log');
function debugLog(msg) {
  try {
    if (fs.existsSync(debugFile) && fs.statSync(debugFile).size > 64 * 1024) fs.writeFileSync(debugFile, '');
    fs.appendFileSync(debugFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// Мини-плеер должен быть на экране: вернуть его, если Windows его свернула
// (так делает Win+D даже с окнами без кнопки сворачивания)
let restoring = false, lastRestoreLog = '';
let widgetWanted = false; // мини-плеер должен быть на экране (мы его показали и не прятали сами)
function restoreWidget(reason) {
  if (!alive(widget) || restoring || !widgetWanted) return;
  restoring = true;
  const line = `restore (${reason}) ${JSON.stringify(winState(widget))}`;
  if (line !== lastRestoreLog) { debugLog(line); lastRestoreLog = line; }
  showNoActivate(widget);
  if (store.get('widgetOnTop')) raiseTopmost(widget);
  setTimeout(() => { restoring = false; }, 300);
}

// Win+D кладёт рабочий стол поверх всех обычных окон. Пока рабочий стол на переднем плане,
// поднимаем мини-плеер поверх, даже если «Поверх всех окон» выключено (как гаджеты),
// а когда пользователь переключился в любое окно — возвращаем обычный режим.
let wasDesktop = false, tempTop = false;
setInterval(() => {
  if (!alive(widget) || !widgetWanted) { wasDesktop = false; return; }
  const now = desktopIsForeground();
  const s = winState(widget);
  if (now !== wasDesktop) debugLog(`desktop foreground=${now} onTop=${store.get('widgetOnTop')} widget=${JSON.stringify(s)}`);
  // свёрнут, скрыт системой или «замаскирован» — возвращаем
  // (маскировку без Win+D не трогаем: так Windows прячет окна на других виртуальных столах)
  if (s.iconic || s.visible === false || (now && s.cloaked)) restoreWidget(now ? 'desktop' : 'poll');
  if (now && !wasDesktop) {
    raiseTopmost(widget);
    tempTop = !store.get('widgetOnTop');
  } else if (!now && wasDesktop && tempTop) {
    tempTop = false;
    if (!store.get('widgetOnTop')) dropTopmost(widget);
  }
  wasDesktop = now;
}, 300);

// ---------- Главное окно ----------
let pendingMaximize = false, lastBlur = 0;
function show() {
  if (!alive(win)) return;
  if (win.isMinimized()) win.restore();
  if (pendingMaximize) { pendingMaximize = false; win.maximize(); }
  win.show(); win.focus();
}

function thumbar() {
  if (!alive(win)) return;
  const ic = (n) => nativeImage.createFromPath(path.join(ASSETS, 'icons', n));
  win.setThumbarButtons([
    { tooltip: t('prev'), icon: ic('prev.png'), click: prev },
    { tooltip: state.playing ? t('pause') : t('play'), icon: ic(state.playing ? 'pause.png' : 'play.png'), click: playPause },
    { tooltip: t('next'), icon: ic('next.png'), click: next },
  ]);
}

function createWindow() {
  const s = readJson(stateFile, { width: 1280, height: 820 });
  win = new BrowserWindow({
    x: s.x, y: s.y, width: s.width, height: s.height,
    minWidth: 480, minHeight: 400,
    title: 'SoundCloud',
    icon: iconPath,
    show: false,
    backgroundColor: '#121212',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:soundcloud', // логин сохраняется между запусками
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required', // чтобы кнопки трея и мини-плеера могли запускать звук
    },
  });
  win.setMenuBarVisibility(false);
  // UA обычного Chrome для всей сессии, включая всплывающие окна входа (Google блокирует «Electron»)
  win.webContents.session.setUserAgent(UA);
  win.webContents.setUserAgent(UA);
  win.loadURL(HOME);
  win.once('ready-to-show', () => {
    // при запуске в трей разворачиваем при первом показе: maximize() скрытого окна его показывает
    if (startHidden) { pendingMaximize = !!s.maximized; if (store.get('widgetOnTray')) showWidget(); return; }
    if (s.maximized) win.maximize();
    win.show();
  });

  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    const tt = title.replace(/^▶\s*/, '') || 'SoundCloud';
    win.setTitle(tt);
    if (tray) tray.setToolTip(tt.slice(0, 127));
  });
  win.webContents.on('did-finish-load', () => { lastPlaying = null; syncState(); });

  // Ссылки: SoundCloud и логин — внутри, всё прочее — в браузере по умолчанию
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 720, parent: win, autoHideMenuBar: true, icon: iconPath, backgroundColor: '#ffffff',
          webPreferences: { partition: 'persist:soundcloud', contextIsolation: true, sandbox: true },
        },
      };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Во всплывающих окнах входа: тот же UA, внешние ссылки — в браузер
  win.webContents.on('did-create-window', (child) => {
    child.setMenuBarVisibility(false);
    child.webContents.setUserAgent(UA);
    child.webContents.setWindowOpenHandler(({ url }) => {
      if (isInternal(url)) return { action: 'allow' };
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isInternal(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key.toLowerCase();
    if ((input.alt && input.key === 'ArrowLeft') || input.key === 'BrowserBack') { win.webContents.navigationHistory.goBack(); e.preventDefault(); }
    else if ((input.alt && input.key === 'ArrowRight') || input.key === 'BrowserForward') { win.webContents.navigationHistory.goForward(); e.preventDefault(); }
    else if (input.key === 'F5' || (input.control && k === 'r')) { win.reload(); e.preventDefault(); }
    else if (input.control && k === 'q') { quitting = true; app.quit(); }
    else if (input.control && input.key === ',') { openSettings(); e.preventDefault(); }
  });

  win.on('close', (e) => {
    saveWinState();
    if (!quitting && store.get('closeToTray')) { e.preventDefault(); win.hide(); }
    else { quitting = true; app.quit(); }
  });
  // Выключение / выход из Windows: не прятаться в трей, иначе программа блокирует завершение работы
  win.on('query-session-end', () => { quitting = true; });
  win.on('session-end', () => { quitting = true; saveWinState(); app.quit(); });
  // Клик по трею забирает фокус у окна раньше, чем приходит событие click: запоминаем, когда окно его потеряло
  win.on('blur', () => { lastBlur = Date.now(); });
  win.on('hide', updateWidgetVisibility);
  win.on('minimize', updateWidgetVisibility);
  win.on('restore', updateWidgetVisibility);
  win.on('show', () => { updateWidgetVisibility(); lastPlaying = null; syncState(); });
}

// ---------- Мини-плеер ----------
// размер окна = карточка + 4px прозрачного поля с каждой стороны
const SIZES = { normal: [384, 116], compact: [320, 72] };
function widgetSize() {
  const [w, h] = SIZES[store.get('widgetSize')] || SIZES.normal;
  const k = (store.get('widgetScale') || 100) / 100;
  return [Math.round(w * k), Math.round(h * k)];
}
function defaultWidgetPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  const [w, h] = widgetSize();
  return { x: wa.x + wa.width - w - 12, y: wa.y + wa.height - h - 12 };
}
function onScreen(p) {
  return screen.getAllDisplays().some(({ workArea: w }) => p.x >= w.x - 200 && p.x < w.x + w.width - 60 && p.y >= w.y - 20 && p.y < w.y + w.height - 40);
}

function widgetConfig() {
  const s = store.all();
  let theme = s.widgetTheme;
  if (theme === 'auto') theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return {
    lang, strings: dict[lang],
    size: s.widgetSize, theme, accent: s.widgetAccent, opacity: s.widgetOpacity, scale: s.widgetScale,
    showVolume: s.widgetShowVolume, showExtra: s.widgetShowExtra, lock: s.widgetLock,
  };
}

function createWidget() {
  const pos = store.get('widgetPos') && onScreen(store.get('widgetPos')) ? store.get('widgetPos') : defaultWidgetPos();
  const [w, h] = widgetSize();
  widget = new BrowserWindow({
    x: pos.x, y: pos.y, width: w, height: h,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    alwaysOnTop: store.get('widgetOnTop'), skipTaskbar: true, show: false, hasShadow: false,
    icon: iconPath, title: 'SoundCloud mini player',
    webPreferences: { preload: path.join(__dirname, 'widget-preload.js'), contextIsolation: true, sandbox: true },
  });
  if (store.get('widgetOnTop')) widget.setAlwaysOnTop(true, 'floating');
  widget.setMovable(!store.get('widgetLock'));
  widget.loadFile(path.join(__dirname, 'widget.html'));
  let tm;
  widget.on('moved', () => {
    clearTimeout(tm);
    tm = setTimeout(() => {
      if (!alive(widget)) return;
      let [x, y] = widget.getPosition();
      if (store.get('widgetSnap')) {
        const [w2, h2] = widget.getSize();
        const wa = screen.getDisplayMatching(widget.getBounds()).workArea;
        const S = 24, M = 8;
        if (Math.abs(x - wa.x) < S) x = wa.x + M;
        if (Math.abs(wa.x + wa.width - (x + w2)) < S) x = wa.x + wa.width - w2 - M;
        if (Math.abs(y - wa.y) < S) y = wa.y + M;
        if (Math.abs(wa.y + wa.height - (y + h2)) < S) y = wa.y + wa.height - h2 - M;
        widget.setPosition(x, y);
      }
      store.set('widgetPos', { x, y });
    }, 250);
  });
  widget.on('close', (e) => { if (!quitting) { e.preventDefault(); manualWidget = false; widgetWanted = false; widget.hide(); } });
  // Win+D сворачивает окна, даже без кнопки сворачивания: сразу возвращаем мини-плеер
  widget.on('minimize', () => setTimeout(() => restoreWidget('minimize event'), 50));
  widget.on('hide', () => { if (widgetWanted) debugLog(`hide event while wanted ${JSON.stringify(winState(widget))}`); });
}

// manualWidget: пользователь открыл мини-плеер сам (из трея) — не прятать автоматически
let manualWidget = false;
function wantWidget() {
  if (manualWidget) return true;
  if (!alive(win)) return false;
  const inTray = !win.isVisible();
  const minimized = win.isVisible() && win.isMinimized();
  let want = (inTray && store.get('widgetOnTray')) || (minimized && store.get('widgetOnMinimize'));
  if (want && store.get('widgetHideIdle') && !state.title) want = false;
  return want;
}
function updateWidgetVisibility() {
  if (wantWidget()) showWidget(); else hideWidget();
}
function showWidget() {
  if (!alive(widget)) createWidget();
  widgetWanted = true;
  if (!widget.isVisible()) {
    makeToolWindow(widget);
    widget.showInactive();
    widget.webContents.send('config', widgetConfig());
    syncState();
  }
  refreshTray();
}
function hideWidget() { widgetWanted = false; if (alive(widget) && widget.isVisible()) widget.hide(); refreshTray(); }
function applyWidgetConfig() {
  if (!alive(widget)) return;
  const [w, h] = widgetSize();
  widget.setResizable(true); widget.setSize(w, h); widget.setResizable(false);
  widget.setAlwaysOnTop(!!store.get('widgetOnTop'), 'floating');
  widget.setMovable(!store.get('widgetLock'));
  widget.webContents.send('config', widgetConfig());
  syncState();
}

// ---------- Своё меню (системное меню Windows не стилизуется) ----------
let menuWin = null, menuActions = new Map(), menuAnchor = null, menuShownAt = 0, menuOutsideTimer = null;
function createMenuWin() {
  menuWin = new BrowserWindow({
    width: 260, height: 300, show: false, frame: false, transparent: true, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, focusable: true, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'menu-preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  menuWin.setAlwaysOnTop(true, 'pop-up-menu');
  menuWin.loadFile(path.join(__dirname, 'menu.html'));
  // После клика по трею фокус ещё мгновение уходит на панель задач: первую потерю фокуса игнорируем
  menuWin.on('blur', () => { if (Date.now() - menuShownAt > 400) closeMenu(); });
  menuWin.on('close', (e) => { if (!quitting) { e.preventDefault(); closeMenu(); } });
}
function closeMenu() { if (alive(menuWin) && menuWin.isVisible()) menuWin.hide(); }
// items: { label, click, type?: 'checkbox' | 'separator' | 'header', checked?, enabled? }
function showMenu(items) {
  if (!alive(menuWin)) createMenuWin();
  menuActions = new Map();
  const payload = items.map((it, i) => {
    if (it.click) menuActions.set(i, it.click);
    return { id: i, label: it.label, type: it.type, checked: it.checked, enabled: it.enabled };
  });
  menuAnchor = screen.getCursorScreenPoint();
  const cfg = widgetConfig();
  const send = () => menuWin.webContents.send('menu:show', { items: payload, theme: cfg.theme === 'light' ? 'light' : 'dark', accent: cfg.accent });
  menuSized = false;
  if (menuWin.webContents.isLoading()) menuWin.webContents.once('did-finish-load', send); else send();
  // запасной вариант: если меню не сообщило размер, показываем с прошлым размером
  clearTimeout(menuFallback);
  menuFallback = setTimeout(() => {
    if (menuSized || !alive(menuWin)) return;
    debugLog('menu size not received, showing with last size');
    placeMenu(lastMenuSize[0], lastMenuSize[1]);
  }, 300);
}
let menuSized = false, menuFallback = null, lastMenuSize = [252, 380];
ipcMain.on('menu:size', (_e, w, h) => { menuSized = true; lastMenuSize = [w, h]; placeMenu(w, h); });
function placeMenu(w, h) {
  if (!alive(menuWin) || !menuAnchor) return;
  // 8px прозрачного поля под тень: смещаем окно, чтобы панель встала точно у курсора
  const wa = screen.getDisplayNearestPoint(menuAnchor).workArea;
  let x = menuAnchor.x - 8, y = menuAnchor.y - 8;
  if (x + w > wa.x + wa.width) x = menuAnchor.x - w + 8;   // не влезает справа — открываем влево
  if (y + h > wa.y + wa.height) y = menuAnchor.y - h + 8;  // не влезает снизу (трей) — открываем вверх
  x = Math.max(wa.x, x); y = Math.max(wa.y, y);
  menuWin.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
  menuShownAt = Date.now();
  menuWin.show(); menuWin.focus(); forceForeground(menuWin);
  setTimeout(() => {
    if (!alive(menuWin) || !menuWin.isVisible() || menuWin.isFocused()) return;
    menuWin.focus(); forceForeground(menuWin);
    debugLog(`menu shown without focus, retried: focused=${menuWin.isFocused()}`);
  }, 120);
  // Если Windows так и не дала фокус, закрываем меню по клику мимо него
  clearInterval(menuOutsideTimer);
  let wasDown = true; // кнопка, открывшая меню, может быть ещё зажата
  menuOutsideTimer = setInterval(() => {
    if (!alive(menuWin) || !menuWin.isVisible()) { clearInterval(menuOutsideTimer); return; }
    const down = mouseDown();
    if (down && !wasDown && Date.now() - menuShownAt > 300) {
      const p = screen.getCursorScreenPoint(), b = menuWin.getBounds();
      if (p.x < b.x || p.x >= b.x + b.width || p.y < b.y || p.y >= b.y + b.height) closeMenu();
    }
    wasDown = down;
  }, 40);
}
ipcMain.on('menu:pick', (_e, id) => { const fn = menuActions.get(id); closeMenu(); if (fn) setTimeout(fn, 0); });
ipcMain.on('menu:close', closeMenu);

function widgetMenuItems() {
  return [
    { label: t('open'), click: show },
    { label: t('settings'), click: openSettings },
    { type: 'separator' },
    { label: t('widgetOnTop'), type: 'checkbox', checked: store.get('widgetOnTop'), click: () => setSetting('widgetOnTop', !store.get('widgetOnTop')) },
    { label: t('widgetLock'), type: 'checkbox', checked: store.get('widgetLock'), click: () => setSetting('widgetLock', !store.get('widgetLock')) },
    { label: store.get('widgetSize') === 'compact' ? t('sizeNormal') : t('sizeCompact'), click: () => setSetting('widgetSize', store.get('widgetSize') === 'compact' ? 'normal' : 'compact') },
    { type: 'separator' },
    { label: t('hideWidget'), click: () => { manualWidget = false; hideWidget(); } },
  ];
}
function trayMenuItems() {
  const widgetVisible = !!(alive(widget) && widget.isVisible());
  return [
    ...(state.title ? [{ type: 'header', label: state.title + (state.artist ? ' — ' + state.artist : '') }, { type: 'separator' }] : []),
    { label: state.playing ? t('pause') : t('play'), click: playPause },
    { label: t('next'), click: next },
    { label: t('prev'), click: prev },
    { type: 'separator' },
    { label: t('open'), click: show },
    { label: widgetVisible ? t('hideWidget') : t('showWidget'), click: () => { if (widgetVisible) { manualWidget = false; hideWidget(); } else { manualWidget = true; showWidget(); } } },
    { label: t('settings'), click: openSettings },
    { label: t('resetWidgetPos'), click: resetWidgetPos },
    { type: 'separator' },
    { label: t('quit'), click: () => { quitting = true; app.quit(); } },
  ];
}

ipcMain.on('widget', (_e, cmd, arg) => {
  switch (cmd) {
    case 'play': playPause(); break;
    case 'next': next(); break;
    case 'prev': prev(); break;
    case 'like': act(P.like); break;
    case 'shuffle': act(P.shuffle); break;
    case 'repeat': act(P.repeat); break;
    case 'mute': act(P.mute); break;
    case 'volume': setVolume(arg); break;
    case 'seek': act(P.seekJs(arg), 250); break;
    case 'open': show(); break;
    case 'close': manualWidget = false; hideWidget(); break;
    case 'menu': if (alive(widget)) showMenu(widgetMenuItems()); break;
    case 'ready': widget.webContents.send('config', widgetConfig()); syncState(); break;
  }
});

// ---------- Настройки ----------
function openSettings() {
  if (alive(settingsWin)) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 520, height: 720, minWidth: 420, minHeight: 400,
    title: t('settingsTitle'), icon: iconPath, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141415' : '#fafafa',
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, sandbox: true },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
}
function settingsPayload() {
  return { settings: store.all(), lang, strings: dict[lang], version: app.getVersion() };
}
function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: !!store.get('autostart'),
    args: store.get('autostartHidden') ? ['--hidden'] : [],
  });
}
function setSetting(k, v) {
  if (!store.set(k, v)) return;
  if (k === 'language') { lang = resolveLang(v, app.getLocale()); refreshTray(); thumbar(); presence.setButtonLabel(t('discordButton')); if (alive(settingsWin)) settingsWin.setTitle(t('settingsTitle')); }
  if (k === 'discord') { presence.setEnabled(!!v); presence.update(state); }
  if (k === 'autostart' || k === 'autostartHidden') applyAutostart();
  if (k.startsWith('widget') || k === 'language') { applyWidgetConfig(); updateWidgetVisibility(); }
  if (alive(settingsWin)) settingsWin.webContents.send('settings', settingsPayload());
}
ipcMain.handle('settings:get', () => settingsPayload());
ipcMain.on('settings:set', (_e, k, v) => setSetting(k, v));
ipcMain.on('settings:action', (_e, a) => {
  if (a === 'previewWidget') { manualWidget = true; showWidget(); }
  if (a === 'resetWidgetPos') resetWidgetPos();
  if (a === 'openRepo') shell.openExternal('https://github.com/fuzkafx/soundcloud-desktop');
});
function resetWidgetPos() {
  store.set('widgetPos', null);
  if (alive(widget)) { const p = defaultWidgetPos(); widget.setPosition(p.x, p.y); }
}
nativeTheme.on('updated', () => { applyWidgetConfig(); });

// ---------- Трей ----------
// Меню трея строится в момент открытия, так что здесь только подсказка
function refreshTray() {
  if (!tray) return;
  tray.setToolTip(state.title ? (state.title + (state.artist ? ' — ' + state.artist : '')).slice(0, 127) : 'SoundCloud');
}

function createTray() {
  tray = new Tray(iconPath);
  refreshTray();
  tray.on('right-click', () => { debugLog('tray right-click'); showMenu(trayMenuItems()); });
  tray.on('click', () => {
    const wasActive = win.isFocused() || Date.now() - lastBlur < 400;
    if (win.isVisible() && !win.isMinimized() && wasActive) win.hide(); else show();
  });
}

app.on('second-instance', show);
app.on('before-quit', () => { quitting = true; saveWinState(); presence.disconnect(); });

app.whenReady().then(() => {
  lang = resolveLang(store.get('language'), app.getLocale());
  createWindow();
  createTray();
  applyAutostart();
  presence.setButtonLabel(t('discordButton'));
  presence.setEnabled(!!store.get('discord'));
});
