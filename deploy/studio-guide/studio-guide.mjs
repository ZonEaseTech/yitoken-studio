// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent enhancement for the public studio toolbar; no business or credential access.
export const copy = {
  'zh-CN': '下载桌面版',
  'zh-TW': '下載桌面版',
  en: 'Download desktop app',
  fr: 'Télécharger l’application',
  ru: 'Скачать приложение',
  ja: 'デスクトップ版をダウンロード',
  vi: 'Tải ứng dụng máy tính',
};
function language(value) {
  const key = String(value || '').toLowerCase();
  if (key.startsWith('zh')) return /tw|hant|hk/.test(key) ? 'zh-TW' : 'zh-CN';
  const primary = key.split('-')[0];
  return Object.hasOwn(copy, primary) ? primary : 'zh-CN';
}
const css = `
[data-yitoken-studio-guide]{display:inline-block;box-sizing:border-box;flex:0 1 auto;max-width:max(0px,calc(100vw - 620px));height:28px;padding:3px 8px;border:1px solid #d9f99d;border-radius:6px;line-height:20px;color:#3f6212;background:#f7fee7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}
[data-yitoken-studio-guide]:hover{background:#ecfccb}
.dark [data-yitoken-studio-guide]{color:#bef264;background:#1a2e05;border-color:#3f6212}
[data-yitoken-studio-guide]:focus-visible{outline:2px solid #65a30d;outline-offset:2px}
@media(max-width:700px){[data-yitoken-studio-guide]{display:none}}
`;
export function startStudioGuide(doc) {
  const view = doc.defaultView;
  if (view.YitokenStudioGuide?.active) return view.YitokenStudioGuide;
  let active = true, frame = null, link = null, style = null;
  function schedule() {
    if (!active || frame !== null) return;
    frame = view.requestAnimationFrame(() => { frame = null; refresh(); });
  }
  function refresh() {
    if (!active) return;
    // Fail closed if the verified production layout changes; never scan form/task content.
    const shell = doc.getElementById('root')?.firstElementChild;
    const main = shell?.matches('div.flex.h-screen') && shell.querySelector(':scope > aside.w-80')
      ? shell.querySelector(':scope > main.flex.min-w-0.flex-1.flex-col') : null;
    const toolbar = main?.firstElementChild;
    const matches = toolbar?.matches('div.flex.items-center.gap-2.border-b.px-6.py-3');
    const controls = matches ? [...toolbar.children].filter(node => node !== link) : [];
    const logs = controls[2];
    const valid = controls.length === 3 && controls[0].tagName === 'BUTTON' && controls[1].tagName === 'BUTTON'
      && logs?.matches('a.ml-auto.text-xs[href$="/usage-logs/task"]');
    if (link && (!valid || link.parentElement !== toolbar)) { link.remove(); link = null; }
    if (!valid) { style?.remove(); style = null; return; }
    if (!style) {
      style = doc.createElement('style');
      style.dataset.yitokenStudioGuideStyle = '1'; style.textContent = css;
      doc.head.append(style);
    }
    if (!link) {
      link = doc.createElement('a'); link.dataset.yitokenStudioGuide = '1';
      link.href = 'https://yitoken.com.cn/downloads/'; link.target = '_top';
      link.rel = 'noreferrer';
      link.className = 'text-xs';
      toolbar.append(link);
    }
    const text = copy[language(doc.documentElement.lang)];
    if (link.textContent !== text) link.textContent = text;
    if (link.title !== text) link.title = text;
  }
  const observer = new view.MutationObserver(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['lang', 'class', 'href'] });
  const api = {
    get active() { return active; }, refresh,
    stop() {
      active = false; observer.disconnect();
      if (frame !== null) view.cancelAnimationFrame(frame);
      frame = null; link?.remove(); style?.remove(); link = null; style = null;
    },
  };
  view.YitokenStudioGuide = api;
  refresh();
  return api;
}
if (typeof document !== 'undefined') startStudioGuide(document);
