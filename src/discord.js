// Discord Rich Presence: «Слушает SoundCloud» с треком, обложкой, временем и кнопкой.
// Работает только при запущенном Discord для компьютера; если его нет — тихо пробует переподключиться.
const { Client } = require('@xhayper/discord-rpc');

const CLIENT_ID = '1571638526808690769';
const ICON_URL = 'https://raw.githubusercontent.com/fuzkafx/soundcloud-desktop/main/assets/icon-512.png';
const RETRY_MS = 20000;
const LISTENING = 2; // ActivityType.Listening
const STATUS_DETAILS = 2; // в списке участников показывать название трека

// Discord требует от 2 до 128 символов в текстовых полях
const fit = (s, max = 128) => {
  s = String(s || '').trim();
  if (s.length < 2) s = s.padEnd(2, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};

class Presence {
  constructor() {
    this.enabled = false;
    this.client = null;
    this.ready = false;
    this.retry = null;
    this.last = null; // ключ последнего отправленного состояния
    this.pending = null;
    this.buttonLabel = 'Listen on SoundCloud';
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.connect();
    else this.disconnect();
  }

  setButtonLabel(label) { this.buttonLabel = label; this.last = null; }

  connect() {
    if (!this.enabled || this.client) return;
    clearTimeout(this.retry);
    const client = new Client({ clientId: CLIENT_ID, transport: { type: 'ipc' } });
    this.client = client;
    client.on('ready', () => {
      this.ready = true;
      this.last = null;
      if (this.pending) this.update(this.pending);
    });
    client.on('disconnected', () => this.dropAndRetry());
    client.login().catch(() => this.dropAndRetry());
  }

  dropAndRetry() {
    const c = this.client;
    this.client = null;
    this.ready = false;
    if (c) c.destroy().catch(() => {});
    if (this.enabled) { clearTimeout(this.retry); this.retry = setTimeout(() => this.connect(), RETRY_MS); }
  }

  disconnect() {
    clearTimeout(this.retry);
    const c = this.client;
    this.client = null;
    this.ready = false;
    this.last = null;
    if (c) c.user?.clearActivity().catch(() => {}).finally(() => c.destroy().catch(() => {}));
  }

  // s — состояние плеера из main.js
  update(s) {
    this.pending = s;
    if (!this.enabled || !this.ready || !this.client?.user) return;

    if (!s || !s.title || !s.playing) {
      if (this.last !== 'clear') { this.last = 'clear'; this.client.user.clearActivity().catch(() => {}); }
      return;
    }

    const now = Date.now();
    const start = now - Math.round((s.pos || 0) * 1000);
    const end = s.dur ? start + Math.round(s.dur * 1000) : undefined;
    // Не дёргать Discord каждую секунду: только при смене трека, паузы или перемотке (сдвиг > 3 с)
    const key = `${s.title}|${s.artist}|${s.url}|${this.buttonLabel}`;
    if (this.last && this.last.key === key && Math.abs(this.last.start - start) < 3000) return;
    this.last = { key, start };

    const url = /^https:\/\/soundcloud\.com\//.test(s.url || '') ? s.url : undefined;
    const art = /^https:\/\//.test(s.art || '') ? s.art.replace(/-t\d+x\d+\./, '-t500x500.') : undefined;
    this.client.user.setActivity({
      type: LISTENING,
      statusDisplayType: STATUS_DETAILS,
      details: fit(s.title),
      detailsUrl: url,
      state: fit(s.artist || 'SoundCloud'),
      largeImageKey: art || ICON_URL,
      largeImageText: fit(s.title),
      largeImageUrl: url,
      smallImageKey: art ? ICON_URL : undefined,
      smallImageText: art ? 'SoundCloud Desktop' : undefined,
      startTimestamp: start,
      endTimestamp: end,
      buttons: url ? [{ label: fit(this.buttonLabel, 32), url }] : undefined,
      instance: false,
    }).catch(() => { this.last = null; });
  }
}

module.exports = { Presence };
