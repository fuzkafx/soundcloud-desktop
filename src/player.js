// Управление веб-плеером SoundCloud изнутри страницы.
// Всё через DOM: кнопки нижней панели и клавиатурные сочетания самого сайта.

const READ_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  const m = navigator.mediaSession && navigator.mediaSession.metadata;
  const t = q('.playbackSoundBadge__titleLink'), a = q('.playbackSoundBadge__lightLink');
  let art = m && m.artwork && m.artwork.length ? m.artwork[m.artwork.length - 1].src : '';
  if (!art) { const s = q('.playbackSoundBadge .sc-artwork span'); const bg = s ? getComputedStyle(s).backgroundImage : ''; const mm = bg.match(/url\\("?(.*?)"?\\)/); art = mm ? mm[1] : ''; }
  const bar = q('.playbackTimeline__progressWrapper');
  const lk = q('.playbackSoundBadge__like');
  const vol = q('.volume__sliderWrapper');
  const volBox = q('.volume');
  const sh = q('.shuffleControl'), rp = q('.repeatControl');
  const rpCls = rp ? rp.className : '';
  return {
    title: (m && m.title) || (t && (t.getAttribute('title') || t.textContent.trim())) || '',
    artist: (m && m.artist) || (a && (a.getAttribute('title') || a.textContent.trim())) || '',
    url: t ? t.href : '',
    art: art.replace(/-t\\d+x\\d+\\./, '-t200x200.'),
    playing: !!q('.playControls__play.playing, .playControl.playing'),
    pos: +(bar && bar.getAttribute('aria-valuenow')) || 0,
    dur: +(bar && bar.getAttribute('aria-valuemax')) || 0,
    liked: !!(lk && lk.classList.contains('sc-button-selected')),
    hasLike: !!lk,
    volume: vol ? Math.round((+vol.getAttribute('aria-valuenow') || 0) * 100) : 100,
    muted: !!(volBox && (volBox.classList.contains('muted') || volBox.getAttribute('data-level') === '0')),
    shuffle: !!(sh && sh.classList.contains('m-shuffling')),
    repeat: /m-one/.test(rpCls) ? 'one' : /m-all/.test(rpCls) ? 'all' : 'none',
    hasExtra: !!(sh && rp),
  };
})()`;

const clickJs = (sel) => `(() => { const b = document.querySelector('${sel}'); if (b) b.click(); return !!b; })()`;

// Shift+↑/↓ на сайте меняет громкость на 10%
const volumeStepsJs = (steps) => `(() => {
  const n = ${Math.trunc(steps)}, key = n > 0 ? 'ArrowUp' : 'ArrowDown', code = n > 0 ? 38 : 40;
  for (let i = 0; i < Math.abs(n); i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode: code, which: code, shiftKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, keyCode: code, which: code, shiftKey: true, bubbles: true }));
  }
  const v = document.querySelector('.volume'); if (v) v.classList.remove('expanded', 'hover');
  return true;
})()`;

const seekJs = (frac) => `(() => {
  const el = document.querySelector('.playbackTimeline__progressWrapper');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width * ${Math.min(Math.max(+frac || 0, 0), 1)}, y = r.top + r.height / 2;
  const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window };
  el.dispatchEvent(new MouseEvent('mousedown', o));
  document.dispatchEvent(new MouseEvent('mouseup', o));
  el.dispatchEvent(new MouseEvent('click', o));
  return true;
})()`;

module.exports = {
  READ_STATE,
  playPause: clickJs('.playControls__play, .playControl'),
  next: clickJs('.skipControl__next'),
  prev: clickJs('.skipControl__previous'),
  like: clickJs('.playbackSoundBadge__like'),
  shuffle: clickJs('.shuffleControl'),
  repeat: clickJs('.repeatControl'),
  mute: clickJs('.volume__button'),
  volumeStepsJs,
  seekJs,
};
