/*
 * NOEMA Radio Card — интернет-радио для Home Assistant
 * Обложки (плеер → iTunes → MusicBrainz/Cover Art Archive), исполнитель,
 * выбор плеера, список станций с визуальным редактором.
 */
const NRC_VERSION = '1.4.0';

const NRC_DEFAULT_STATIONS = [
  { name: 'Morow', url: 'http://stream.fr.morow.com:8080/morow_med.mp3' },
  { name: 'StreemLion', url: 'http://eagle.streemlion.com:4040/stream', image: 'https://www.streemlion.com/wp-content/uploads/2017/10/lionstreem-logo-WhiteMINITransp.png' },
  { name: 'Prog Бавария', url: 'https://stream.laut.fm/progressiv-rock' },
  { name: 'Rockfile Radio', url: 'https://s2.ssl-stream.com/radio/8180/radio.mp3' },
  { name: 'Progressive Music', url: 'https://stream.laut.fm/progressivemusic' },
  { name: 'SOR', url: 'https://stream.laut.fm/sor' },
  { name: 'Progr Rock', url: 'https://stream.laut.fm/progrrock' },
  { name: '1-4-1 Progressive', url: 'https://stream.laut.fm/1-4-1-progressive' },
];

/* ---------------- утилиты ---------------- */

const nrcLS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
};

function nrcStationName(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last && !/\.(mp3|aac|ogg|m3u8?|pls)$/i.test(last) ? last : u.hostname;
  } catch (e) { return url; }
}

function nrcNormStations(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => {
      if (typeof s === 'string') return { name: nrcStationName(s), url: s };
      const url = (s && (s.url || s.id)) || '';
      return { name: (s && s.name) || nrcStationName(url), url, image: (s && s.image) || '', icon: (s && s.icon) || '' };
    })
    .filter((s) => s.url);
}

function nrcNorm(s) {
  return (s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft)\.?\s.*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function nrcCleanTitle(s) {
  return (s || '')
    .replace(/\s*[([][^)\]]*(remaster|live|edit|version|mix|mono|stereo|bonus|demo)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(\d{4}\s+)?(remaster|live|single|radio edit).*$/i, '')
    .trim();
}

function nrcSplit(title, artist) {
  if (artist || !title) return { title, artist };
  for (const sep of [' - ', ' – ', ' — ', ' ~ ', ' / ']) {
    const i = title.indexOf(sep);
    if (i > 0) return { artist: title.slice(0, i).trim(), title: title.slice(i + sep.length).trim() };
  }
  return { title, artist };
}

async function nrcFetchJson(url, ms = 7000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(t); }
}

function nrcProbe(src, ms = 8000) {
  return new Promise((res) => {
    if (!src) { res(null); return; }
    const img = new Image();
    const t = setTimeout(() => res(null), ms);
    img.onload = () => { clearTimeout(t); res(img.naturalWidth > 1 ? src : null); };
    img.onerror = () => { clearTimeout(t); res(null); };
    img.src = src;
  });
}

function nrcArtistMatch(a, b) {
  const x = nrcNorm(a); const y = nrcNorm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/* ---------------- обложки ---------------- */

const nrcCoverCache = new Map();

async function nrcItunes(artist, title) {
  const term = encodeURIComponent(`${artist} ${nrcCleanTitle(title)}`);
  const j = await nrcFetchJson(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=10`);
  const hit = j && Array.isArray(j.results) ? j.results.find((r) => nrcArtistMatch(r.artistName, artist)) : null;
  if (!hit || !hit.artworkUrl100) return null;
  return hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.');
}

async function nrcMusicBrainz(artist, title) {
  const q = `recording:"${nrcCleanTitle(title).replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
  const j = await nrcFetchJson(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=8`);
  const albums = []; const other = [];
  for (const rec of (j && j.recordings) || []) {
    for (const rel of rec.releases || []) {
      const rg = rel['release-group'];
      if (!rg || !rg.id || albums.includes(rg.id) || other.includes(rg.id)) continue;
      const isComp = (rg['secondary-types'] || []).includes('Compilation');
      (rg['primary-type'] === 'Album' && !isComp ? albums : other).push(rg.id);
    }
  }
  for (const id of [...albums, ...other].slice(0, 4)) {
    const src = await nrcProbe(`https://coverartarchive.org/release-group/${id}/front-500`);
    if (src) return src;
  }
  return null;
}

function nrcFindCover(artist, title) {
  if (!artist || !title) return Promise.resolve(null);
  const key = `${nrcNorm(artist)}|${nrcNorm(title)}`;
  if (!nrcCoverCache.has(key)) {
    nrcCoverCache.set(key, (async () => (await nrcItunes(artist, title)) || (await nrcMusicBrainz(artist, title)))());
  }
  return nrcCoverCache.get(key);
}

/* ---------------- laut.fm ---------------- */

function nrcLautName(url) {
  const m = /laut\.fm\/([^/?#]+)/i.exec(url || '');
  return m ? m[1] : null;
}

async function nrcLautSong(name) {
  const j = await nrcFetchJson(`https://api.laut.fm/station/${encodeURIComponent(name)}/current_song`);
  if (!j || !j.title) return null;
  const artist = j.artist && typeof j.artist === 'object' ? j.artist.name : j.artist;
  return { title: j.title || '', artist: artist || '', album: j.album || '' };
}

/* ---------------- стили карточки ---------------- */

const NRC_CSS = `
:host { display: block; }
[hidden] { display: none !important; }
ha-card { position: relative; overflow: hidden; isolation: isolate; container-type: inline-size; }
:host([glass]) ha-card {
  background: transparent !important;
  backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
}
:host([glass]) ha-card::before {
  content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; border-radius: inherit;
  background: var(--ha-card-glass-tint, rgba(255,255,255,0.05));
  backdrop-filter: var(--ha-card-backdrop-filter, blur(8px) saturate(1.2));
  -webkit-backdrop-filter: var(--ha-card-backdrop-filter, blur(8px) saturate(1.2));
  box-shadow: var(--ha-card-glass-inset-shadow,
    3px 3px 0.5px -3.5px rgba(255,255,255,0.30) inset,
    -2px -2px 0.5px -2px rgba(255,255,255,0.30) inset,
    0 0 8px 1px rgba(255,255,255,0.10) inset,
    0 0 2px 0 rgba(0,0,0,0.10));
}
.bg {
  position: absolute; inset: -40px; z-index: 0; pointer-events: none;
  background-size: cover; background-position: center;
  filter: blur(46px) saturate(1.7); transform: scale(1.1);
  opacity: 0; transition: opacity .9s ease;
}
.bg.on { opacity: .42; }
.wrap { position: relative; z-index: 1; padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 16px; }

.top { display: flex; align-items: center; gap: 8px; min-height: 34px; }
.head { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.head::-webkit-scrollbar { display: none; }
.cardname { font-weight: 600; font-size: 15px; white-space: nowrap; color: var(--primary-text-color); }
.pbox { position: relative; min-width: 0; }
.pbtn {
  border: 0; cursor: pointer; font: inherit; font-size: 13px; line-height: 1; max-width: 100%;
  padding: 7px 10px 7px 9px; border-radius: 999px; white-space: nowrap;
  display: flex; align-items: center; gap: 6px;
  background: rgba(127,127,127,.16); color: var(--primary-text-color); transition: background .2s;
}
.pbtn:hover { background: rgba(127,127,127,.26); }
.pbtn ha-icon { --mdc-icon-size: 16px; flex: none; }
.pbtn .pn { overflow: hidden; text-overflow: ellipsis; }
.pbtn .chev { opacity: .6; transition: transform .2s; }
.pbox.open .chev { transform: rotate(180deg); }
.menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 10; min-width: 220px; max-width: 300px;
  max-height: 280px; overflow-y: auto; padding: 6px; border-radius: 12px;
  background: var(--card-background-color, #1f2433); border: 1px solid rgba(127,127,127,.25);
  box-shadow: 0 12px 32px rgba(0,0,0,.4);
}
.menu[hidden] { display: none; }
.mh { font-size: 12px; color: var(--secondary-text-color); padding: 8px 10px 4px; }
.mi {
  width: 100%; border: 0; background: transparent; cursor: pointer; font: inherit; font-size: 14px; text-align: left;
  color: var(--primary-text-color); display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px;
}
.mi:hover { background: rgba(127,127,127,.15); }
.mi ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); flex: none; }
.mi.on ha-icon.ic { color: var(--primary-color); }
.mi .mn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mi .ms { font-size: 12px; color: var(--secondary-text-color); flex: none; }
.mi.na { opacity: .45; }
.chip {
  border: 0; cursor: pointer; font: inherit; font-size: 12.5px; line-height: 1;
  padding: 7px 11px; border-radius: 999px; white-space: nowrap;
  display: flex; align-items: center; gap: 6px;
  background: rgba(127,127,127,.14); color: var(--secondary-text-color);
  transition: background .2s, color .2s;
}
.chip ha-icon { --mdc-icon-size: 15px; }
.chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
.chip.na { opacity: .45; }

button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
.ib {
  width: 38px; height: 38px; border-radius: 50%; border: 0; padding: 0; flex: none;
  background: transparent; color: var(--primary-text-color); cursor: pointer;
  display: grid; place-items: center; transition: background .2s, color .2s;
}
.ib:hover { background: rgba(127,127,127,.16); }
.ib ha-icon { --mdc-icon-size: 22px; }

.now { display: flex; align-items: center; gap: 20px; }
.cover {
  position: relative; flex: none; width: clamp(88px, 30cqw, 140px); aspect-ratio: 1;
  border-radius: 12px; overflow: hidden;
  background: linear-gradient(140deg, #2c3170, #15162a);
  box-shadow: 0 12px 30px rgba(0,0,0,.38);
}
.cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .5s ease; }
.cover img.on { opacity: 1; }
.ph { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255,255,255,.5); }
.ph ha-icon { --mdc-icon-size: 46px; }

.meta { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 5px; }
.line { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--secondary-text-color); min-width: 0; }
.line .stname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--disabled-text-color, #777); }
:host([pstate="playing"]) .dot { background: var(--success-color, #43a047); animation: nrc-pulse 1.8s infinite; }
:host([pstate="paused"]) .dot, :host([pstate="buffering"]) .dot { background: var(--warning-color, #ffa600); }
.title {
  font-size: clamp(17px, 5.4cqw, 26px); font-weight: 600; line-height: 1.25;
  color: var(--primary-text-color); overflow: hidden; white-space: nowrap;
}
.title span { display: inline-block; white-space: nowrap; }
.title:not(.marquee) span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
.title.marquee { -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 20px), transparent); mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 20px), transparent); }
.title.marquee span { animation: nrc-marq var(--dur, 10s) ease-in-out infinite alternate; }
.sub { font-size: clamp(14px, 4.2cqw, 19px); color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.tr { display: flex; align-items: center; gap: 4px; }
.play {
  width: 52px; height: 52px; border-radius: 50%; border: 0; cursor: pointer; padding: 0;
  background: var(--primary-color); color: var(--text-primary-color, #fff);
  display: grid; place-items: center; box-shadow: 0 6px 18px rgba(0,0,0,.3); transition: transform .15s;
}
.play:active { transform: scale(.94); }
.play ha-icon { --mdc-icon-size: 28px; }
.play.spin ha-icon { animation: nrc-spin 1s linear infinite; }
.vol { flex: 1; min-width: 150px; display: flex; align-items: center; gap: 4px; }
.vol.slim { flex: none; min-width: 0; margin-left: auto; }
.mute.on { color: var(--warning-color, #ffa600); }
.vstep { display: flex; gap: 4px; }
.vol:not([hidden]) + .vstep { margin-left: 0; }
.vstep { margin-left: auto; }
.vol input {
  -webkit-appearance: none; appearance: none; flex: 1; height: 6px; border-radius: 6px; margin: 0 6px 0 0;
  background: linear-gradient(90deg, var(--primary-color) var(--p, 50%), rgba(127,127,127,.3) var(--p, 50%));
  outline: none; cursor: pointer;
}
.vol input::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #fff; border: 0; box-shadow: 0 1px 4px rgba(0,0,0,.45); }
.vol input::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #fff; border: 0; box-shadow: 0 1px 4px rgba(0,0,0,.45); }
.vol.muted input { filter: grayscale(1); opacity: .5; }

.stations { display: grid; grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr)); gap: 8px; }
.st {
  display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 12px 8px 8px;
  border-radius: 12px; border: 1px solid rgba(127,127,127,.18); background: rgba(127,127,127,.08);
  color: var(--primary-text-color); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer;
  transition: background .2s, border-color .2s, transform .1s;
}
.st:hover { background: rgba(127,127,127,.16); }
.st:active { transform: scale(.98); }
.st.on { border-color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 18%, transparent); }
.sti { width: 30px; height: 30px; flex: none; border-radius: 8px; object-fit: cover; display: grid; place-items: center; --mdc-icon-size: 20px; color: var(--secondary-text-color); background: rgba(127,127,127,.12); }
.st.on ha-icon.sti { color: var(--primary-color); }
.stn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eq { display: none; gap: 2px; align-items: flex-end; height: 14px; flex: none; }
.st.on .eq { display: flex; }
.eq i { width: 3px; height: 100%; border-radius: 2px; background: var(--primary-color); transform-origin: bottom; transform: scaleY(.3); }
:host([playing]) .st.on .eq i { animation: nrc-eq .9s ease-in-out infinite; }
:host([playing]) .st.on .eq i:nth-child(2) { animation-delay: -.3s; }
:host([playing]) .st.on .eq i:nth-child(3) { animation-delay: -.6s; }

.warn { font-size: 13px; color: var(--warning-color, #ffa600); }
.warn[hidden] { display: none; }

@container (max-width: 380px) {
  .now { gap: 14px; }
  .vol { min-width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .title.marquee span, :host([pstate]) .dot, :host([playing]) .st.on .eq i { animation: none; }
}
@keyframes nrc-eq { 0%, 100% { transform: scaleY(.3); } 50% { transform: scaleY(1); } }
@keyframes nrc-spin { to { transform: rotate(360deg); } }
@keyframes nrc-marq { 0%, 15% { transform: translateX(0); } 85%, 100% { transform: translateX(var(--shift, 0)); } }
@keyframes nrc-pulse {
  0% { box-shadow: 0 0 0 0 rgba(67,160,71,.5); }
  70% { box-shadow: 0 0 0 6px rgba(67,160,71,0); }
  100% { box-shadow: 0 0 0 0 rgba(67,160,71,0); }
}
`;

/* ---------------- карточка ---------------- */

const NRC_OFF = ['off', 'unavailable', 'unknown', 'standby'];
const NRC_BUTTONS = ['prev', 'play', 'stop', 'next', 'mute', 'volume'];
const NRC_BUTTON_LABELS = {
  prev: 'Предыдущая станция', play: 'Играть / пауза', stop: 'Стоп',
  next: 'Следующая станция', mute: 'Без звука', volume: 'Громкость',
};

class NoemaRadioCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._coverKey = null;
    this._cover = null;
    this._volT = 0;
    this._dragging = false;
    this._pending = null;
  }

  static getConfigElement() { return document.createElement('noema-radio-card-editor'); }

  static getStubConfig(hass) {
    const players = Object.keys((hass && hass.states) || {}).filter((e) => e.startsWith('media_player.'));
    return { entities: players.slice(0, 1), stations: NRC_DEFAULT_STATIONS.map((s) => ({ ...s })) };
  }

  setConfig(config) {
    if (!config) throw new Error('Нет конфигурации');
    const ents = [];
    const push = (e) => {
      if (!e) return;
      const o = typeof e === 'string' ? { entity: e } : e;
      if (o.entity && !ents.some((x) => x.entity === o.entity)) ents.push(o);
    };
    if (Array.isArray(config.entities)) config.entities.forEach(push);
    push(config.entity);

    this._config = {
      columns: 2, glass: true, all_players: true, cover_lookup: true, laut_meta: true, player_art: true,
      show_volume: true, media_content_type: 'music', ...config,
    };
    let btns = Array.isArray(config.buttons) ? config.buttons.filter((b) => NRC_BUTTONS.includes(b)) : [...NRC_BUTTONS];
    if (config.show_volume === false && !Array.isArray(config.buttons)) btns = btns.filter((b) => b !== 'volume');
    this._buttons = new Set(btns);
    this._entities = ents;
    this._stations = nrcNormStations(config.stations);
    this._storeKey = `noema-radio:${config.name || ents.map((e) => e.entity).join(',') || 'default'}`;
    this._coverKey = null;
    this._build();
    if (this._hass) this._update();
  }

  set hass(hass) { this._hass = hass; this._update(); }

  getCardSize() { return 4 + Math.ceil(this._stations.length / (this._config.columns || 2)); }

  connectedCallback() { if (this._hass) this._update(); }

  disconnectedCallback() { this._stopLaut(); this._closeMenu(); }

  /* ---- построение DOM ---- */

  _build() {
    const c = this._config;
    this.toggleAttribute('glass', !!c.glass);
    const cols = Math.max(1, Math.min(6, Number(c.columns) || 2));
    this.shadowRoot.innerHTML = `<style>${NRC_CSS}</style>
      <ha-card>
        <div class="bg"></div>
        <div class="wrap">
          <div class="top">
            <div class="head"><div class="cardname"></div>
              <div class="pbox">
                <button class="pbtn" title="Выбрать плеер"><ha-icon icon="mdi:speaker"></ha-icon><span class="pn"></span><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></button>
                <div class="menu" hidden></div>
              </div>
            </div>
          </div>
          <div class="now">
            <div class="cover"><div class="ph"><ha-icon icon="mdi:radio"></ha-icon></div><img alt=""></div>
            <div class="meta">
              <div class="line"><span class="dot"></span><span class="stname"></span></div>
              <div class="title"><span></span></div>
              <div class="sub"></div>
            </div>
          </div>
          <div class="controls">
            <div class="tr">
              <button class="ib prev" title="Предыдущая станция"><ha-icon icon="mdi:skip-previous"></ha-icon></button>
              <button class="play" title="Играть"><ha-icon icon="mdi:play"></ha-icon></button>
              <button class="ib stop" title="Стоп"><ha-icon icon="mdi:stop"></ha-icon></button>
              <button class="ib next" title="Следующая станция"><ha-icon icon="mdi:skip-next"></ha-icon></button>
            </div>
            <div class="vol">
              <button class="ib mute" title="Без звука"><ha-icon icon="mdi:volume-high"></ha-icon></button>
              <input type="range" min="0" max="100" step="1" aria-label="Громкость">
            </div>
            <div class="vstep">
              <button class="ib vdown" title="Тише"><ha-icon icon="mdi:volume-minus"></ha-icon></button>
              <button class="ib vup" title="Громче"><ha-icon icon="mdi:volume-plus"></ha-icon></button>
            </div>
          </div>
          <div class="stations" style="--cols:${cols}"></div>
          <div class="warn" hidden></div>
        </div>
      </ha-card>`;

    const $ = (s) => this.shadowRoot.querySelector(s);
    this.$ = {
      bg: $('.bg'), name: $('.cardname'), pbox: $('.pbox'), pbtn: $('.pbtn'), pname: $('.pbtn .pn'), menu: $('.menu'),
      img: $('.cover img'), ph: $('.ph'), stname: $('.stname'), title: $('.title'), titleSpan: $('.title span'),
      sub: $('.sub'), play: $('.play'), playIcon: $('.play ha-icon'), stop: $('.stop'), prev: $('.prev'), next: $('.next'),
      vol: $('.vol'), mute: $('.mute'), muteIcon: $('.mute ha-icon'), range: $('.vol input'),
      stations: $('.stations'), warn: $('.warn'), vstep: $('.vstep'),
    };
    this.$.name.textContent = c.name || '';
    this.$.name.hidden = !c.name;

    // выбор плеера
    this.$.pbtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (this.$.menu.hidden) this._openMenu(); else this._closeMenu();
    });

    // станции
    this._stBtns = this._stations.map((s, i) => {
      const b = document.createElement('button');
      b.className = 'st';
      b.title = s.url;
      const mkIcon = () => {
        const h = document.createElement('ha-icon');
        h.className = 'sti';
        h.setAttribute('icon', s.icon || 'mdi:radio');
        return h;
      };
      if (s.image) {
        const im = document.createElement('img');
        im.className = 'sti';
        im.alt = '';
        im.src = s.image;
        im.addEventListener('error', () => im.replaceWith(mkIcon()), { once: true });
        b.appendChild(im);
      } else {
        b.appendChild(mkIcon());
      }
      const n = document.createElement('span');
      n.className = 'stn';
      n.textContent = s.name;
      const eq = document.createElement('span');
      eq.className = 'eq';
      eq.innerHTML = '<i></i><i></i><i></i>';
      b.append(n, eq);
      b.addEventListener('click', () => this._playStation(i));
      this.$.stations.appendChild(b);
      return b;
    });
    this.$.stations.hidden = !this._stations.length;

    // управление
    this.$.play.addEventListener('click', () => this._togglePlay());
    this.$.stop.addEventListener('click', () => this._call('media_stop'));
    this.$.prev.addEventListener('click', () => this._step(-1));
    this.$.next.addEventListener('click', () => this._step(1));
    this.$.mute.addEventListener('click', () => this._toggleMute());
    this.shadowRoot.querySelector('.vdown').addEventListener('click', () => this._call('volume_down'));
    this.shadowRoot.querySelector('.vup').addEventListener('click', () => this._call('volume_up'));
    const r = this.$.range;
    r.addEventListener('pointerdown', () => { this._dragging = true; });
    const release = () => setTimeout(() => { this._dragging = false; }, 800);
    r.addEventListener('pointerup', release);
    r.addEventListener('pointercancel', release);
    r.addEventListener('input', () => {
      r.style.setProperty('--p', `${r.value}%`);
      const now = Date.now();
      if (now - this._volT > 250) {
        this._volT = now;
        this._call('volume_set', { volume_level: Number(r.value) / 100 });
      }
    });
    r.addEventListener('change', () => {
      this._call('volume_set', { volume_level: Number(r.value) / 100 });
      release();
    });
  }

  /* ---- состояние ---- */

  _allowed(id) {
    if (!id) return false;
    if (this._entities.some((e) => e.entity === id)) return true;
    return this._config.all_players !== false && id.startsWith('media_player.') && !!(this._hass && this._hass.states[id]);
  }

  _selectedPlayer() {
    const saved = nrcLS.get(`${this._storeKey}:player`);
    if (this._allowed(saved)) return saved;
    return this._entities.length ? this._entities[0].entity : null;
  }

  _pname(id) {
    const e = this._entities.find((x) => x.entity === id);
    const so = this._hass && this._hass.states[id];
    return (e && e.name) || (so && so.attributes.friendly_name) || id;
  }

  _openMenu() {
    const m = this.$.menu;
    m.innerHTML = '';
    const cur = this._selectedPlayer();
    const conf = this._entities.map((e) => e.entity);
    const others = this._config.all_players === false || !this._hass ? [] : Object.keys(this._hass.states)
      .filter((id) => id.startsWith('media_player.') && !conf.includes(id))
      .sort((x, y) => this._pname(x).localeCompare(this._pname(y)));
    const stateText = (so) => {
      if (!so) return 'нет';
      return { playing: 'играет', paused: 'пауза', buffering: 'загрузка', idle: 'ожидание', on: 'вкл', off: 'выкл', standby: 'сон', unavailable: 'недоступен' }[so.state] || '';
    };
    const add = (id, icon) => {
      const so = this._hass && this._hass.states[id];
      const b = document.createElement('button');
      b.className = 'mi' + (id === cur ? ' on' : '') + (!so || so.state === 'unavailable' ? ' na' : '');
      b.innerHTML = '<ha-icon class="ic"></ha-icon><span class="mn"></span><span class="ms"></span>';
      b.querySelector('.ic').setAttribute('icon', id === cur ? 'mdi:check-circle' : icon);
      b.querySelector('.mn').textContent = this._pname(id);
      b.querySelector('.ms').textContent = stateText(so);
      b.title = id;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        nrcLS.set(`${this._storeKey}:player`, id);
        this._coverKey = null;
        this._pending = null;
        this._closeMenu();
        this._update();
      });
      m.appendChild(b);
    };
    const head = (t) => { const h = document.createElement('div'); h.className = 'mh'; h.textContent = t; m.appendChild(h); };
    if (conf.length && others.length) head('Избранные');
    conf.forEach((id) => add(id, 'mdi:speaker'));
    if (others.length) { if (conf.length) head('Все плееры'); others.forEach((id) => add(id, 'mdi:speaker-wireless')); }
    if (!conf.length && !others.length) head('Плееров не найдено');
    m.hidden = false;
    this.$.pbox.classList.add('open');
    this._outside = (ev) => { if (!ev.composedPath().includes(this.$.pbox)) this._closeMenu(); };
    setTimeout(() => document.addEventListener('click', this._outside, true), 0);
  }

  _closeMenu() {
    if (this.$ && this.$.menu) { this.$.menu.hidden = true; this.$.pbox.classList.remove('open'); }
    if (this._outside) { document.removeEventListener('click', this._outside, true); this._outside = null; }
  }

  _stateObj() {
    const pid = this._selectedPlayer();
    return pid && this._hass ? this._hass.states[pid] : null;
  }

  _call(service, data = {}) {
    const pid = this._selectedPlayer();
    if (!pid || !this._hass) return undefined;
    return this._hass.callService('media_player', service, { entity_id: pid, ...data });
  }

  _currentIndex(s) {
    const pid = this._selectedPlayer();
    if (this._pending && this._pending.pid === pid && Date.now() < this._pending.until) return this._pending.i;
    const cid = s && s.attributes.media_content_id;
    if (cid) {
      const i = this._stations.findIndex((x) => x.url === cid || cid.includes(x.url) || x.url.includes(cid));
      if (i >= 0 || /^https?:\/\//.test(cid)) return i;
    }
    const saved = nrcLS.get(`${this._storeKey}:station:${pid}`);
    return saved ? this._stations.findIndex((x) => x.url === saved) : -1;
  }

  _playStation(i) {
    const st = this._stations[i];
    const pid = this._selectedPlayer();
    if (!st || !pid) return;
    nrcLS.set(`${this._storeKey}:station:${pid}`, st.url);
    this._pending = { pid, i, until: Date.now() + 8000 };
    this._coverKey = null;
    this._call('play_media', { media_content_id: st.url, media_content_type: this._config.media_content_type || 'music' });
    this._update();
  }

  _step(dir) {
    if (!this._stations.length) return;
    const i = this._currentIndex(this._stateObj());
    const n = this._stations.length;
    this._playStation(i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n);
  }

  _muteKey() { return `${this._storeKey}:mutevol:${this._selectedPlayer()}`; }

  _isMuted(s) {
    const a = s.attributes;
    if ((a.supported_features || 0) & 8) return !!a.is_volume_muted;
    return typeof a.volume_level === 'number' && a.volume_level === 0 && nrcLS.get(this._muteKey()) !== null;
  }

  _toggleMute() {
    const s = this._stateObj();
    if (!s) return;
    const a = s.attributes;
    if ((a.supported_features || 0) & 8) {
      this._call('volume_mute', { is_volume_muted: !a.is_volume_muted });
      return;
    }
    // плеер не умеет mute — эмулируем через громкость 0 и запоминаем прежнюю
    if (typeof a.volume_level !== 'number') return;
    const saved = nrcLS.get(this._muteKey());
    if (a.volume_level === 0) {
      const back = saved !== null ? Number(saved) : 0.3;
      try { localStorage.removeItem(this._muteKey()); } catch (e) { /* ignore */ }
      this._call('volume_set', { volume_level: back > 0 ? back : 0.3 });
    } else {
      nrcLS.set(this._muteKey(), String(a.volume_level));
      this._call('volume_set', { volume_level: 0 });
    }
  }

  _togglePlay() {
    const s = this._stateObj();
    if (!s) return;
    const f = s.attributes.supported_features || 0;
    if (s.state === 'playing' || s.state === 'buffering') {
      this._call(f & 1 ? 'media_pause' : 'media_stop');
    } else if (s.state === 'paused') {
      this._call('media_play');
    } else {
      const i = this._currentIndex(s);
      this._playStation(i >= 0 ? i : 0);
    }
  }

  /* ---- laut.fm ---- */

  _ensureLaut(name) {
    if (this._lautName === name && this._lautTimer) return;
    this._stopLaut();
    this._lautName = name;
    const tick = async () => {
      const song = await nrcLautSong(name);
      if (this._lautName !== name) return;
      this._lautSong = song;
      this._update();
    };
    tick();
    this._lautTimer = setInterval(tick, 20000);
  }

  _stopLaut() {
    clearInterval(this._lautTimer);
    this._lautTimer = null;
    this._lautName = null;
    this._lautSong = null;
  }

  /* ---- отрисовка ---- */

  _setText(el, v) { if (el.textContent !== v) el.textContent = v; }

  _update() {
    if (!this._config || !this._hass || !this.$) return;
    const c = this._config;
    const pid = this._selectedPlayer();

    this._setText(this.$.pname, pid ? this._pname(pid) : 'Выбрать плеер');
    this.$.pbox.hidden = !pid && !this._entities.length && this._config.all_players === false;

    const s = pid ? this._hass.states[pid] : null;
    this.$.warn.hidden = !!s;
    if (!s) {
      this._setText(this.$.warn, pid ? `Плеер ${pid} не найден` : 'Выберите плеер кнопкой вверху');
      this.removeAttribute('playing');
      this.removeAttribute('pstate');
      return;
    }

    const a = s.attributes;
    const state = s.state;
    const playing = state === 'playing';
    const active = playing || state === 'buffering' || state === 'paused';
    const off = NRC_OFF.includes(state);
    this.toggleAttribute('playing', playing);
    if (active) this.setAttribute('pstate', state); else this.removeAttribute('pstate');

    const idx = this._currentIndex(s);
    const st = idx >= 0 ? this._stations[idx] : null;
    this._stBtns.forEach((b, i) => b.classList.toggle('on', i === idx));

    // метаданные
    let title = active ? (a.media_title || '') : '';
    let artist = active ? (a.media_artist || '') : '';
    let album = active ? (a.media_album_name || '') : '';
    if (title && (/^https?:\/\//i.test(title) || (st && (title === st.url || nrcNorm(title) === nrcNorm(st.name))))) title = '';
    ({ title, artist } = nrcSplit(title, artist));

    const laut = active && st && c.laut_meta !== false ? nrcLautName(st.url) : null;
    if (laut) {
      this._ensureLaut(laut);
      const ls = this._lautSong;
      if (ls && (!title || !artist)) { title = ls.title; artist = ls.artist; album = album || ls.album; }
    } else if (this._lautName) {
      this._stopLaut();
    }

    const stationName = st ? st.name : (a.media_channel || a.app_name || '');
    let line; let main; let sub;
    if (!active) {
      line = a.friendly_name || pid;
      main = st ? st.name : 'Выберите станцию';
      sub = state === 'unavailable' ? 'Плеер недоступен' : off ? 'Плеер выключен' : 'Остановлено';
    } else {
      line = stationName || 'Радио';
      main = title || stationName || 'Прямой эфир';
      sub = title ? [artist, album].filter(Boolean).join(' • ') : (state === 'buffering' ? 'Подключение…' : 'Прямой эфир');
    }
    this._setText(this.$.stname, line);
    if (this.$.titleSpan.textContent !== main) {
      this.$.titleSpan.textContent = main;
      this.$.title.title = main;
      requestAnimationFrame(() => this._marquee());
    }
    this._setText(this.$.sub, sub);

    // обложка
    const key = active && title && artist ? `${artist}|${title}` : '';
    if (key !== this._coverKey) {
      this._coverKey = key;
      this._cover = null;
      if (key && c.cover_lookup !== false) {
        nrcFindCover(artist, title).then((u) => {
          if (this._coverKey === key && u) { this._cover = u; this._update(); }
        });
      }
    }
    const playerArt = active && c.player_art !== false && a.entity_picture ? a.entity_picture : null;
    this._setCover(this._cover || playerArt || (st && st.image) || null, !!(this._cover || playerArt) && active);

    // кнопки
    const f = a.supported_features || 0;
    const icon = state === 'buffering' ? 'mdi:loading' : playing ? (f & 1 ? 'mdi:pause' : 'mdi:stop') : 'mdi:play';
    if (this.$.playIcon.getAttribute('icon') !== icon) this.$.playIcon.setAttribute('icon', icon);
    this.$.play.classList.toggle('spin', state === 'buffering');
    this.$.play.title = playing ? 'Пауза' : 'Играть';


    const B = this._buttons;
    this.$.prev.hidden = !B.has('prev') || this._stations.length < 2;
    this.$.next.hidden = !B.has('next') || this._stations.length < 2;
    this.$.play.hidden = !B.has('play');
    this.$.stop.hidden = !B.has('stop');

    const level = typeof a.volume_level === 'number';
    const showSlider = B.has('volume') && level;
    const showMute = B.has('mute') && (!!(f & 8) || level);
    this.$.range.hidden = !showSlider;
    this.$.mute.hidden = !showMute;
    this.$.vol.hidden = !showSlider && !showMute;
    this.$.vol.classList.toggle('slim', !showSlider);
    this.$.vstep.hidden = !B.has('volume') || level || !(f & (1024 | 4));

    const muted = this._isMuted(s);
    this.$.vol.classList.toggle('muted', muted);
    this.$.mute.classList.toggle('on', muted);
    this.$.mute.title = muted ? 'Вернуть звук' : 'Без звука';
    const v = level ? Math.round(a.volume_level * 100) : 50;
    const vi = muted ? 'mdi:volume-off' : v < 34 ? 'mdi:volume-low' : v < 67 ? 'mdi:volume-medium' : 'mdi:volume-high';
    if (this.$.muteIcon.getAttribute('icon') !== vi) this.$.muteIcon.setAttribute('icon', vi);
    if (showSlider) {
      if (!this._dragging && Number(this.$.range.value) !== v) {
        this.$.range.value = v;
        this.$.range.style.setProperty('--p', `${v}%`);
      }
    }
  }

  _setCover(src, glow) {
    const img = this.$.img;
    if (src !== this._shownCover) {
      this._shownCover = src;
      img.classList.remove('on');
      if (src) {
        img.onload = () => { if (this._shownCover === src) { img.classList.add('on'); this.$.ph.hidden = true; } };
        img.onerror = () => { if (this._shownCover === src) { img.classList.remove('on'); this.$.ph.hidden = false; } };
        img.src = src;
      } else {
        img.removeAttribute('src');
        this.$.ph.hidden = false;
      }
      this.$.bg.style.backgroundImage = src ? `url("${String(src).replace(/"/g, '%22')}")` : '';
    }
    this.$.bg.classList.toggle('on', !!src && glow);
  }

  _marquee() {
    const box = this.$.title; const span = this.$.titleSpan;
    box.classList.remove('marquee');
    const over = span.scrollWidth - box.clientWidth;
    if (over > 4) {
      span.style.setProperty('--shift', `-${over + 24}px`);
      span.style.setProperty('--dur', `${Math.max(6, (over + 24) / 25)}s`);
      box.classList.add('marquee');
    }
  }
}

/* ---------------- редактор ---------------- */

const NRC_EDITOR_CSS = `
:host { display: block; }
.sec { margin-top: 20px; }
.sec-h { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.sec-h b { font-size: 15px; font-weight: 600; color: var(--primary-text-color); }
.row {
  border: 1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius: 12px;
  padding: 10px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px;
  background: var(--card-background-color, transparent);
}
.rh { display: flex; align-items: center; gap: 6px; }
.rh .num { width: 22px; text-align: center; color: var(--secondary-text-color); font-size: 13px; flex: none; }
input {
  box-sizing: border-box; width: 100%; font: inherit; font-size: 14px; padding: 9px 11px; border-radius: 8px;
  border: 1px solid var(--divider-color, rgba(127,127,127,.35));
  background: var(--secondary-background-color, rgba(127,127,127,.08)); color: var(--primary-text-color);
}
input:focus { outline: none; border-color: var(--primary-color); }
input.name { font-weight: 600; }
.ib {
  width: 34px; height: 34px; border-radius: 50%; border: 0; padding: 0; flex: none; cursor: pointer;
  background: transparent; color: var(--secondary-text-color); display: grid; place-items: center;
}
.ib:hover { background: rgba(127,127,127,.15); color: var(--primary-text-color); }
.ib:disabled { opacity: .3; cursor: default; }
.ib ha-icon { --mdc-icon-size: 20px; }
.ib.del:hover { color: var(--error-color, #db4437); }
.add {
  width: 100%; padding: 10px; border-radius: 10px; cursor: pointer; font: inherit; font-size: 14px;
  border: 1px dashed var(--primary-color); background: transparent; color: var(--primary-color);
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.add ha-icon { --mdc-icon-size: 18px; }
.hint { font-size: 12.5px; color: var(--secondary-text-color); margin: 0 0 10px; }
`;

const NRC_LABELS = {
  name: 'Заголовок (необязательно)',
  entities: 'Избранные плееры (первый — по умолчанию)',
  all_players: 'Выбор любого плеера в карточке',
  columns: 'Колонок в списке станций',
  glass: 'Стеклянный фон',
  cover_lookup: 'Искать обложки в интернете',
  laut_meta: 'Треки laut.fm через их API',
  player_art: 'Обложка от плеера',
  buttons: 'Кнопки управления',
  media_content_type: 'Тип контента для play_media',
};

class NoemaRadioCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._lastSig = null;
  }

  set hass(h) { this._hass = h; if (this._form) this._form.hass = h; }

  connectedCallback() { this._loadHelpers(); }

  async _loadHelpers() {
    if (customElements.get('ha-form') && customElements.get('ha-entity-picker')) return;
    try {
      const helpers = await (window.loadCardHelpers && window.loadCardHelpers());
      const el = helpers && (await helpers.createCardElement({ type: 'entities', entities: [] }));
      if (el && el.constructor.getConfigElement) await el.constructor.getConfigElement();
    } catch (e) { /* ignore */ }
  }

  setConfig(config) {
    this._config = { ...config };
    if (!this._built) this._build();
    this._syncForm();
    const sig = JSON.stringify(config.stations || []);
    if (sig !== this._lastSig) {
      this._lastSig = sig;
      this._stations = nrcNormStations(config.stations);
      this._renderStations();
    }
  }

  _build() {
    this._built = true;
    this.shadowRoot.innerHTML = `<style>${NRC_EDITOR_CSS}</style>
      <div class="form"></div>
      <div class="sec">
        <div class="sec-h"><b>Станции</b></div>
        <p class="hint">Адрес потока — прямая ссылка на mp3/aac. Картинка — ссылка на логотип станции, можно оставить пустой.</p>
        <div class="list"></div>
        <button class="add"><ha-icon icon="mdi:plus"></ha-icon>Добавить станцию</button>
      </div>`;
    this._form = document.createElement('ha-form');
    this._form.computeLabel = (s) => NRC_LABELS[s.name] || s.name;
    this._form.schema = [
      { name: 'name', selector: { text: {} } },
      { name: 'entities', selector: { entity: { multiple: true, filter: { domain: 'media_player' } } } },
      { name: 'columns', selector: { number: { min: 1, max: 4, mode: 'box' } } },
      {
        type: 'grid', name: '', schema: [
          { name: 'all_players', selector: { boolean: {} } },
          { name: 'glass', selector: { boolean: {} } },
          { name: 'cover_lookup', selector: { boolean: {} } },
          { name: 'player_art', selector: { boolean: {} } },
          { name: 'laut_meta', selector: { boolean: {} } },
        ],
      },
      {
        name: 'buttons',
        selector: { select: { multiple: true, mode: 'list', options: NRC_BUTTONS.map((b) => ({ value: b, label: NRC_BUTTON_LABELS[b] })) } },
      },
      { name: 'media_content_type', selector: { text: {} } },
    ];
    if (this._hass) this._form.hass = this._hass;
    this._form.addEventListener('value-changed', (ev) => {
      const v = ev.detail.value || {};
      const cfg = { ...this._config, ...v };
      delete cfg.entity;
      delete cfg.show_volume;
      if (Array.isArray(cfg.buttons) && NRC_BUTTONS.every((b) => cfg.buttons.includes(b))) delete cfg.buttons;
      if (!cfg.name) delete cfg.name;
      this._fire(cfg);
    });
    this.shadowRoot.querySelector('.form').appendChild(this._form);
    this.shadowRoot.querySelector('.add').addEventListener('click', () => {
      this._stations.push({ name: '', url: '', image: '' });
      this._renderStations();
      const inputs = this.shadowRoot.querySelectorAll('.row input.name');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
  }

  _syncForm() {
    const c = this._config;
    const ents = [];
    (Array.isArray(c.entities) ? c.entities : []).forEach((e) => {
      const id = typeof e === 'string' ? e : e && e.entity;
      if (id && !ents.includes(id)) ents.push(id);
    });
    if (c.entity && !ents.includes(c.entity)) ents.unshift(c.entity);
    this._form.data = {
      name: c.name || '',
      entities: ents,
      columns: c.columns || 2,
      all_players: c.all_players !== false,
      glass: c.glass !== false,
      buttons: Array.isArray(c.buttons) ? c.buttons : NRC_BUTTONS.filter((b) => !(b === 'volume' && c.show_volume === false)),
      cover_lookup: c.cover_lookup !== false,
      player_art: c.player_art !== false,
      laut_meta: c.laut_meta !== false,
      media_content_type: c.media_content_type || 'music',
    };
  }

  _renderStations() {
    const list = this.shadowRoot.querySelector('.list');
    if (!list) return;
    list.innerHTML = '';
    const n = this._stations.length;
    this._stations.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="rh">
          <span class="num">${i + 1}</span>
          <input class="name" placeholder="Название">
          <button class="ib up" title="Выше"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
          <button class="ib down" title="Ниже"><ha-icon icon="mdi:arrow-down"></ha-icon></button>
          <button class="ib del" title="Удалить"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
        </div>
        <input class="url" placeholder="Адрес потока, например https://stream.laut.fm/sor" inputmode="url">
        <input class="image" placeholder="Картинка (необязательно)" inputmode="url">`;
      const q = (sel) => row.querySelector(sel);
      [['name', 'name'], ['url', 'url'], ['image', 'image']].forEach(([cls, field]) => {
        const inp = q(`input.${cls}`);
        inp.value = s[field] || '';
        inp.addEventListener('input', () => { this._stations[i][field] = inp.value.trim(); this._commit(); });
      });
      q('.up').disabled = i === 0;
      q('.down').disabled = i === n - 1;
      q('.up').addEventListener('click', () => this._move(i, -1));
      q('.down').addEventListener('click', () => this._move(i, 1));
      q('.del').addEventListener('click', () => { this._stations.splice(i, 1); this._commit(); this._renderStations(); });
      list.appendChild(row);
    });
  }

  _move(i, d) {
    const j = i + d;
    if (j < 0 || j >= this._stations.length) return;
    [this._stations[i], this._stations[j]] = [this._stations[j], this._stations[i]];
    this._commit();
    this._renderStations();
  }

  _commit() {
    const stations = this._stations
      .filter((s) => s.url || s.name)
      .map((s) => {
        const o = { name: s.name || nrcStationName(s.url), url: s.url };
        if (s.image) o.image = s.image;
        if (s.icon) o.icon = s.icon;
        return o;
      });
    this._fire({ ...this._config, stations });
  }

  _fire(cfg) {
    this._config = cfg;
    this._lastSig = JSON.stringify(cfg.stations || []);
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: cfg }, bubbles: true, composed: true }));
  }
}

/* ---------------- регистрация ---------------- */

if (!customElements.get('noema-radio-card')) customElements.define('noema-radio-card', NoemaRadioCard);
if (!customElements.get('noema-radio-card-editor')) customElements.define('noema-radio-card-editor', NoemaRadioCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === 'noema-radio-card')) {
  window.customCards.push({
    type: 'noema-radio-card',
    name: 'NOEMA Radio',
    description: 'Интернет-радио: обложки, исполнитель, выбор плеера, свои станции',
    preview: true,
  });
}

console.info(`%c NOEMA RADIO %c v${NRC_VERSION} `, 'background:#2c3170;color:#fff;border-radius:3px 0 0 3px;padding:2px 4px', 'background:#444;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px');
