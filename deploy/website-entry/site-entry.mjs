// SPDX-License-Identifier: AGPL-3.0-or-later
// Site-only enhancement; original new-api / QuantumNous code and attribution remain unchanged.
export const copy = {
  'zh-CN': { nav: '软件下载', kicker: '桌面创作客户端', description: 'AI 剧本、分镜、图片与视频创作，将已有视频在本地合成为整片 MP4。', action: '下载 YITOKEN Studio', note: 'Windows / macOS / Linux · 预发布 · API Key 由你在 YITOKEN 官网获取' },
  'zh-TW': { nav: '軟體下載', kicker: '桌面創作客戶端', description: 'AI 劇本、分鏡、圖片與影片創作，將已有影片在本機合成為完整 MP4。', action: '下載 YITOKEN Studio', note: 'Windows / macOS / Linux · 預發布 · 請自行在 YITOKEN 官網取得 API Key' },
  en: { nav: 'Downloads', kicker: 'Desktop creation app', description: 'Create AI scripts, storyboards, images and videos. Combine existing clips into a complete MP4 locally.', action: 'Download YITOKEN Studio', note: 'Windows / macOS / Linux · Prerelease · Get your own API key from YITOKEN' },
  fr: { nav: 'Téléchargements', kicker: 'Application de création', description: 'Créez des scripts, storyboards, images et vidéos avec l’IA. Assemblez vos clips en un MP4 complet sur votre ordinateur.', action: 'Télécharger YITOKEN Studio', note: 'Windows / macOS / Linux · Préversion · Obtenez votre propre clé API sur YITOKEN' },
  ru: { nav: 'Скачать', kicker: 'Приложение для творчества', description: 'Создавайте сценарии, раскадровки, изображения и видео с ИИ. Собирайте готовые клипы в полный MP4 локально.', action: 'Скачать YITOKEN Studio', note: 'Windows / macOS / Linux · Предварительная версия · Получите свой API-ключ на YITOKEN' },
  ja: { nav: 'ダウンロード', kicker: 'デスクトップ制作アプリ', description: 'AIで脚本、絵コンテ、画像、動画を制作。既存の動画をローカルで1本のMP4に結合できます。', action: 'YITOKEN Studio をダウンロード', note: 'Windows / macOS / Linux · プレビュー版 · APIキーはYITOKENでご自身で取得してください' },
  vi: { nav: 'Tải xuống', kicker: 'Ứng dụng sáng tạo trên máy tính', description: 'Tạo kịch bản, bảng phân cảnh, ảnh và video bằng AI. Ghép các clip có sẵn thành MP4 hoàn chỉnh trên máy tính.', action: 'Tải YITOKEN Studio', note: 'Windows / macOS / Linux · Bản xem trước · Tự lấy khóa API tại YITOKEN' },
};
function language(value) {
  const key = String(value || '').toLowerCase();
  if (key.startsWith('zh')) return /tw|hant|hk/.test(key) ? 'zh-TW' : 'zh-CN';
  const primary = key.split('-')[0];
  return Object.hasOwn(copy, primary) ? primary : 'zh-CN';
}
const css = `
[data-yitoken-download-bar] > a,[data-yitoken-download-bar] > div:not([data-yitoken-download-nav="desktop"]){flex-shrink:0}
[data-yitoken-download-nav="desktop"]{flex:1 1 0%;min-width:0;flex-wrap:wrap;justify-content:flex-end;margin-inline:12px}
[data-yitoken-download-nav="desktop"] > a{flex-shrink:0;white-space:nowrap}
[data-yitoken-download-bar]{height:auto;min-height:64px}
[data-yitoken-download-bar].h-12{min-height:48px}
[data-yitoken-download-link]:focus-visible{outline:2px solid var(--primary,#16a34a);outline-offset:-2px}
.ze [data-yitoken-download-card] .card{text-align:center;background:var(--soft);border-color:var(--line)}
.ze [data-yitoken-download-card] .download-note{font-size:.88rem;color:var(--muted);margin-top:16px;overflow-wrap:anywhere}
.ze [data-yitoken-download-card] .sub2{margin:14px auto 0}
.ze [data-yitoken-download-card] .btn{white-space:normal;text-align:center;max-width:100%}
`;
function downloadLink(doc, text, className = '') {
  const link = doc.createElement('a');
  link.href = '/downloads/';
  link.textContent = text;
  link.className = className;
  link.dataset.yitokenDownloadLink = '1';
  return link;
}
function downloadCard(doc, text) {
  const section = doc.createElement('section');
  section.dataset.yitokenDownloadCard = '1';
  const card = doc.createElement('div'); card.className = 'card';
  const kicker = doc.createElement('p'); kicker.className = 'kicker'; kicker.textContent = text.kicker;
  const title = doc.createElement('h2'); title.textContent = 'YITOKEN Studio';
  const description = doc.createElement('p'); description.className = 'sub2'; description.textContent = text.description;
  const actions = doc.createElement('div'); actions.className = 'btns';
  actions.append(downloadLink(doc, text.action, 'btn p'));
  const note = doc.createElement('p'); note.className = 'download-note'; note.textContent = text.note;
  card.append(kicker, title, description, actions, note); section.append(card);
  return section;
}
export function startDownloadEntries(doc) {
  const view = doc.defaultView;
  if (view.YitokenSiteDownloadEntries?.active) return view.YitokenSiteDownloadEntries;
  const app = doc.getElementById('root');
  if (!app) return null;
  let active = true, pending = false;
  const shadows = new Map();
  const waiting = new WeakSet();
  const timers = new Set();
  function schedule() {
    if (!active || pending) return;
    pending = true;
    view.requestAnimationFrame(() => { pending = false; if (active) refresh(); });
  }
  function ensureStyle(root) {
    if (root.querySelector('style[data-yitoken-download-style]')) return;
    const style = doc.createElement('style'); style.dataset.yitokenDownloadStyle = '1'; style.textContent = css;
    root.append(style);
  }
  function updateNav(container, mode, text) {
    const template = container.querySelector('a[href="/about"]') || container.querySelector('a[href="/pricing"]');
    if (!template || !container.querySelector('a[href="/dashboard"]')) return;
    let link = container.querySelector('a[data-yitoken-download-nav-link]');
    if (!link) {
      link = downloadLink(doc, text);
      link.dataset.yitokenDownloadNavLink = '1';
      const home = container.querySelector('a[href="/"]');
      if (home) home.after(link); else container.append(link);
    }
    const classes = template.className.split(/\s+/).filter(name => name !== 'active' && name !== 'text-foreground').join(' ');
    if (link.className !== classes) link.className = classes;
    if (link.style.transitionDelay !== template.style.transitionDelay) link.style.transitionDelay = template.style.transitionDelay;
    if (link.textContent !== text) link.textContent = text;
    if (container.dataset.yitokenDownloadNav !== mode) container.dataset.yitokenDownloadNav = mode;
    if (mode === 'desktop') container.parentElement.dataset.yitokenDownloadBar = '1';
  }
  function updateFooter(footer, text) {
    if (footer.querySelector('[data-yitoken-download-footer]')) return;
    const wrapper = doc.createElement('span'); wrapper.dataset.yitokenDownloadFooter = '1';
    wrapper.append(doc.createTextNode(' · '), downloadLink(doc, text));
    const original = footer.querySelector('a[href="/source/"]') || footer.querySelector('a');
    (original?.parentElement || footer).append(wrapper);
  }
  function refresh() {
    if (!active) return;
    const text = copy[language(doc.documentElement.lang)];
    ensureStyle(doc.head);
    for (const header of app.querySelectorAll('header')) {
      const template = header.querySelector('nav a[href="/about"]') || header.querySelector('nav a[href="/pricing"]');
      if (template) updateNav(template.parentElement, 'desktop', text.nav);
      const mobile = header.nextElementSibling?.querySelector('nav');
      if (mobile) updateNav(mobile, 'mobile', text.nav);
    }
    for (const footer of app.querySelectorAll('footer')) {
      updateFooter(footer, text.nav);
      const link = footer.querySelector('[data-yitoken-download-footer] a');
      if (link && link.textContent !== text.nav) link.textContent = text.nav;
    }
    for (const [host, observer] of shadows) if (!host.isConnected) { observer.disconnect(); shadows.delete(host); }
    for (const host of app.querySelectorAll('.custom-home-content')) {
      const root = host.shadowRoot;
      if (!root) {
        if (!waiting.has(host)) {
          waiting.add(host);
          let attempts = 0;
          const timer = view.setInterval(() => {
            if (!active || !host.isConnected || host.shadowRoot || ++attempts >= 20) {
              view.clearInterval(timer); timers.delete(timer); schedule();
            }
          }, 100);
          timers.add(timer);
        }
        continue;
      }
      if (!shadows.has(host)) {
        const observer = new view.MutationObserver(schedule);
        observer.observe(root, { childList: true, subtree: true }); shadows.set(host, observer);
      }
      ensureStyle(root);
      for (const block of root.querySelectorAll('.l[lang]')) {
        const localized = copy[language(block.lang)];
        const hero = block.querySelector('.hero');
        if (hero && !block.querySelector('[data-yitoken-download-card]')) hero.after(downloadCard(doc, localized));
        const footer = block.querySelector('footer');
        if (footer) updateFooter(footer, localized.nav);
      }
    }
  }
  const appObserver = new view.MutationObserver(schedule);
  appObserver.observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  const languageObserver = new view.MutationObserver(schedule);
  languageObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['lang'] });
  view.addEventListener('resize', schedule);
  const api = {
    get active() { return active; }, refresh,
    stop() {
      active = false; appObserver.disconnect(); languageObserver.disconnect(); view.removeEventListener('resize', schedule);
      for (const timer of timers) view.clearInterval(timer);
      for (const observer of shadows.values()) observer.disconnect();
      const roots = [doc, ...[...shadows.keys()].map(host => host.shadowRoot).filter(Boolean)];
      for (const root of roots) {
        root.querySelectorAll('[data-yitoken-download-card],[data-yitoken-download-footer],[data-yitoken-download-nav-link],style[data-yitoken-download-style]').forEach(node => node.remove());
        root.querySelectorAll('[data-yitoken-download-nav]').forEach(node => node.removeAttribute('data-yitoken-download-nav'));
        root.querySelectorAll('[data-yitoken-download-bar]').forEach(node => node.removeAttribute('data-yitoken-download-bar'));
      }
      shadows.clear(); timers.clear();
    },
  };
  view.YitokenSiteDownloadEntries = api;
  refresh();
  return api;
}
if (typeof document !== 'undefined') startDownloadEntries(document);
