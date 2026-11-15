const { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain, screen, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { dict, resolveLang } = require('./i18n');
const { createStore } = require('./settings');
const P = require('./player');

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
    if (s.playing !== lastPlaying) { lastPlaying = s.playing; thumbar(); refreshTray(); }
    if (s.title !== lastTitle) { lastTitle = s.title; refreshTray(); updateWidgetVisibility(); }
    if (!alive(widget) || !widget.isVisible()) return;
    if (store.get('widgetTheme') === 'art') s.artColor = await artColor(s.art);
    if (seq === syncSeq && alive(widget)) widget.webContents.send('state', s);
  }).catch(() => {});
}
setInterval(() => {
  if ((alive(widget) && widget.isVisible()) || (alive(win) && win.isVisible())) syncState();
}, 1000);

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
  widget.on('close', (e) => { if (!quitting) { e.preventDefault(); manualWidget = false; widget.hide(); } });
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
  if (!widget.isVisible()) {
    widget.showInactive();
    widget.webContents.send('config', widgetConfig());
    syncState();
  }
  refreshTray();
}
function hideWidget() { if (alive(widget) && widget.isVisible()) widget.hide(); refreshTray(); }
function applyWidgetConfig() {
  if (!alive(widget)) return;
  const [w, h] = widgetSize();
  widget.setResizable(true); widget.setSize(w, h); widget.setResizable(false);
  widget.setAlwaysOnTop(!!store.get('widgetOnTop'), 'floating');
  widget.setMovable(!store.get('widgetLock'));
  widget.webContents.send('config', widgetConfig());
  syncState();
}

function widgetMenu() {
  return Menu.buildFromTemplate([
    { label: t('open'), click: show },
    { label: t('settings'), click: openSettings },
    { type: 'separator' },
    { label: t('widgetOnTop'), type: 'checkbox', checked: store.get('widgetOnTop'), click: (i) => setSetting('widgetOnTop', i.checked) },
    { label: t('widgetLock'), type: 'checkbox', checked: store.get('widgetLock'), click: (i) => setSetting('widgetLock', i.checked) },
    { label: store.get('widgetSize') === 'compact' ? t('sizeNormal') : t('sizeCompact'), click: () => setSetting('widgetSize', store.get('widgetSize') === 'compact' ? 'normal' : 'compact') },
    { type: 'separator' },
    { label: t('hideWidget'), click: () => { manualWidget = false; hideWidget(); } },
  ]);
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
    case 'menu': if (alive(widget)) widgetMenu().popup({ window: widget }); break;
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
  if (k === 'language') { lang = resolveLang(v, app.getLocale()); refreshTray(); thumbar(); if (alive(settingsWin)) settingsWin.setTitle(t('settingsTitle')); }
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
function refreshTray() {
  if (!tray) return;
  const widgetVisible = !!(alive(widget) && widget.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('open'), click: show },
    { label: widgetVisible ? t('hideWidget') : t('showWidget'), click: () => { if (widgetVisible) { manualWidget = false; hideWidget(); } else { manualWidget = true; showWidget(); } } },
    { type: 'separator' },
    ...(state.title ? [{ label: (state.title + (state.artist ? ' — ' + state.artist : '')).slice(0, 60), enabled: false }] : []),
    { label: state.playing ? t('pause') : t('play'), click: playPause },
    { label: t('next'), click: next },
    { label: t('prev'), click: prev },
    { type: 'separator' },
    { label: t('settings'), click: openSettings },
    { label: t('resetWidgetPos'), click: resetWidgetPos },
    { type: 'separator' },
    { label: t('quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(iconPath);
  tray.setToolTip('SoundCloud');
  refreshTray();
  tray.on('click', () => {
    const wasActive = win.isFocused() || Date.now() - lastBlur < 400;
    if (win.isVisible() && !win.isMinimized() && wasActive) win.hide(); else show();
  });
}

app.on('second-instance', show);
app.on('before-quit', () => { quitting = true; saveWinState(); });

app.whenReady().then(() => {
  lang = resolveLang(store.get('language'), app.getLocale());
  createWindow();
  createTray();
  applyAutostart();
});
