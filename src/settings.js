// Хранение настроек в userData/settings.json
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  language: 'auto', // auto | ru | en
  closeToTray: true,
  autostart: false,
  autostartHidden: true,
  discord: true, // статус «Слушает» в Discord

  widgetOnTray: true,
  widgetOnMinimize: false,
  widgetOnTop: true,
  widgetHideIdle: false,
  widgetLock: false,
  widgetSnap: true,
  widgetShowVolume: true,
  widgetShowExtra: false,
  widgetSize: 'normal', // normal | compact
  widgetTheme: 'dark', // dark | light | auto | art
  widgetAccent: '#ff5500',
  widgetOpacity: 96, // 50..100
  widgetScale: 100, // 80..130
  widgetPos: null,
};

function createStore(dir) {
  const file = path.join(dir, 'settings.json');
  let data = { ...DEFAULTS };
  try { data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let timer;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {} }, 200);
  };
  return {
    get: (k) => data[k],
    all: () => ({ ...data }),
    set(k, v) {
      if (!(k in DEFAULTS)) return false;
      data[k] = v;
      save();
      return true;
    },
  };
}

module.exports = { createStore, DEFAULTS };
