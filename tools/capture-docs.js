// Captures README screenshots and GIF frames in a clean, signed-out profile.
// Usage: electron tools/capture-docs.js <workdir>
//   <workdir>/shots/*.png   still images
//   <workdir>/frames/*.png  GIF frames (10 fps), encode with tools/make-gif.ps1
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const work = path.resolve(process.argv[process.argv.length - 1]);
const shots = path.join(work, 'shots');
const frames = path.join(work, 'frames');
for (const d of [shots, frames]) fs.mkdirSync(d, { recursive: true });
// DOCS_PROFILE: a copy of a signed-in profile (SoundCloud plays better signed in).
// Without it a clean profile is used; an existing Partitions folder stops main.js from importing a local login.
const profile = process.env.DOCS_PROFILE || path.join(work, 'profile');
fs.mkdirSync(path.join(profile, 'Partitions'), { recursive: true });
app.setPath('userData', profile);
require('../src/main.js');

const TRACK = 'https://soundcloud.com/forss/flickermood';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[docs]', ...a);
setTimeout(() => { log('timeout'); app.exit(2); }, 240000);

const set = (k, v) => ipcMain.emit('settings:set', {}, k, v);
const cmd = (c, a) => ipcMain.emit('widget', {}, c, a);
const save = async (w, file) => fs.writeFileSync(file, (await w.capturePage()).toPNG());

app.whenReady().then(async () => {
  set('language', 'en');
  set('widgetShowExtra', true);
  await wait(1500);
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('soundcloud'));
  win.webContents.setAudioMuted(true);
  win.setSize(1280, 800);
  win.center();
  const ex = (c) => win.webContents.executeJavaScript(c, true).catch(() => null);

  await win.loadURL(TRACK);
  await wait(7000);
  await ex(`(() => { const b = document.querySelector('#onetrust-reject-all-handler'); if (b) b.click(); })()`);
  await wait(800);
  const r = await ex(`(() => { const b = document.querySelector('.fullHero .sc-button-play, .sc-button-play.playButton'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
  if (r) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  }
  await wait(4000);
  // close any popups SoundCloud shows to signed-out users
  await ex(`document.querySelectorAll('.modal__closeButton, .announcement__dismiss').forEach((b) => b.click())`);
  await wait(500);

  // Mini player
  win.hide();
  await wait(2500);
  const widget = BrowserWindow.getAllWindows().find((w) => w !== win && w.isVisible());
  if (!widget) { log('no widget'); app.exit(1); return; }
  const wx = (c) => widget.webContents.executeJavaScript(c, true).catch(() => null);
  const playing = await ex(`!!document.querySelector('.playControls__play.playing')`);
  if (!playing) { cmd('play'); await wait(2500); }
  log('playing', await ex(`!!document.querySelector('.playControls__play.playing')`));

  await save(widget, path.join(shots, 'widget-dark.png'));
  await wx(`document.getElementById('volpop').classList.add('show')`);
  await wait(400);
  await save(widget, path.join(shots, 'widget-volume.png'));
  await wx(`document.getElementById('volpop').classList.remove('show')`);

  // ---- GIF frames, 10 fps ----
  let n = 0, recording = true;
  (async function rec() {
    while (recording) {
      const t = Date.now();
      try { await save(widget, path.join(frames, `f${String(n++).padStart(4, '0')}.png`)); } catch {}
      await wait(Math.max(0, 100 - (Date.now() - t)));
    }
  })();
  const wheel = (dy) => wx(`document.dispatchEvent(new WheelEvent('wheel', { deltaY: ${dy} }))`);
  await wait(1500);
  for (let i = 0; i < 5; i++) { await wheel(100); await wait(280); }   // volume down
  await wait(500);
  for (let i = 0; i < 3; i++) { await wheel(-100); await wait(280); }  // volume up
  await wait(1400);
  cmd('play'); await wait(1300);                                       // pause
  cmd('play'); await wait(1200);                                       // play
  set('widgetTheme', 'light'); set('widgetAccent', '#0a84ff'); await wait(1600);
  set('widgetTheme', 'art'); set('widgetAccent', '#ff5500'); await wait(1800);
  set('widgetTheme', 'dark'); await wait(1000);
  recording = false;
  await wait(300);
  log('frames', n);

  // ---- more stills ----
  set('widgetTheme', 'light'); set('widgetAccent', '#0a84ff');
  await wait(1500);
  await save(widget, path.join(shots, 'widget-light.png'));
  set('widgetTheme', 'art'); set('widgetAccent', '#ff5500');
  await wait(1800);
  await save(widget, path.join(shots, 'widget-art.png'));
  set('widgetTheme', 'dark'); set('widgetSize', 'compact');
  await wait(1800);
  await save(widget, path.join(shots, 'widget-compact.png'));
  set('widgetSize', 'normal');

  // Main window while playing, without SoundCloud's promo banners
  win.show();
  await wait(1500);
  await ex(`(() => {
    document.querySelectorAll('.announcements, .announcement, [class*="banner"], .modal').forEach((e) => e.remove());
    // hide the signed-in account (avatar, name, notifications) — screenshots are public
    document.querySelectorAll('.header__userNav, .header__userNavItem, .header__notification, .header__messages, .header__soundInput, .commentForm__avatar, .playbackSoundBadge__follow')
      .forEach((e) => (e.style.visibility = 'hidden'));
    window.scrollTo(0, 0);
  })()`);
  await wait(800);
  await save(win, path.join(shots, 'main-window.png'));
  log('main window');

  // Settings window (Ctrl+,)
  win.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['control'] });
  await wait(1500);
  const sw = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('settings.html'));
  if (sw) {
    sw.setSize(540, 1040); sw.center(); sw.show(); sw.focus();
    for (let i = 0; i < 5; i++) {
      await wait(1000);
      const img = await sw.webContents.capturePage();
      if (!img.isEmpty()) { fs.writeFileSync(path.join(shots, 'settings.png'), img.toPNG()); log('settings'); break; }
    }
  }
  log('done');
  app.exit(0);
});
