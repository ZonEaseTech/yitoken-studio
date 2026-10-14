import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const languages = {
  'zh-CN': '软件下载', 'zh-TW': '軟體下載', en: 'Downloads',
  fr: 'Téléchargements', ru: 'Скачать', ja: 'ダウンロード', vi: 'Tải xuống',
};
const existingNav = `<a href="/">Home</a><a href="/dashboard">Console</a><a href="/pricing">Model Square</a><a href="/rankings">Rankings</a><a href="/about">About</a>`;
const home = `<style>.ze section{padding:32px 20px}.ze .card{padding:20px;border:1px solid #ccc}.ze .btn{display:inline-flex;padding:12px 20px}.ze footer{padding:20px}</style><div class="ze">${Object.keys(languages).map(lang => `<div class="l" lang="${lang}"><section class="hero"><h1>Original gateway ${lang}</h1></section><section id="studio-${lang}" data-existing-business><h2>Original web studio</h2><a href="/dashboard/studio">Original studio</a></section><footer><div>Copyright original</div><div><a href="/source/">Original source</a> · <a href="/about">About</a></div><div>Original registration</div></footer></div>`).join('')}</div>`;
const fixture = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font:16px Arial}header{position:fixed;top:0;width:100%;background:white;z-index:20}header>nav{display:flex;align-items:center;justify-content:space-between;min-height:64px;padding:12px 16px}header>nav>a{width:100px;flex-shrink:0}.desktop{display:flex;gap:2px}.desktop>a{padding:8px 12px}.actions{display:flex;gap:8px}.mobile-actions{display:none}.overlay{display:none;position:fixed;inset:0;padding:80px 30px;background:white;z-index:10}.overlay.open{display:block}.overlay nav{display:flex;flex-direction:column}.overlay a{padding:12px 0}.custom-home-content{padding-top:70px}@media(max-width:639px){.desktop,.actions{display:none}.mobile-actions{display:flex}}</style></head><body><div id="root"><header><nav><a href="/">YITOKEN</a><div class="desktop">${existingNav}<div class="actions"><button>Language</button><a href="/sign-in">Sign in</a></div></div><div class="mobile-actions"><button aria-label="Toggle navigation menu">Menu</button></div></nav></header><div class="overlay"><nav>${existingNav}</nav><a href="/sign-in">Sign in</a></div><div class="custom-home-content"></div><footer><a href="https://github.com/QuantumNous/new-api">New API / QuantumNous</a></footer></div><script>window.originalNav=${JSON.stringify(existingNav)};window.originalHome=${JSON.stringify(home)};const host=document.querySelector('.custom-home-content');host.attachShadow({mode:'open'}).innerHTML=window.originalHome;document.querySelector('[aria-label="Toggle navigation menu"]').onclick=()=>{document.querySelector('.overlay').classList.toggle('open');document.body.style.overflow=document.querySelector('.overlay').classList.contains('open')?'hidden':'';};</script><script type="module" src="/site-entry.mjs"></script></body></html>`;
let server, browser, profile, socket, base, sequence = 0;
const pending = new Map();
const requests = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)); }, 15000);
    pending.set(id, m => { clearTimeout(timeout); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  return evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;function check(){if(${expression})return resolve(true);if(Date.now()>end)return reject(Error('Expected DOM state: '+${JSON.stringify(expression)}));setTimeout(check,20)}check()})`);
}
async function navigate(path = '/') {
  await send('Page.navigate', { url: base + path });
  await waitFor(`document.readyState==='complete' && !!document.querySelector('.custom-home-content')?.shadowRoot`);
}
before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push({ path, method: req.method, document: req.headers['sec-fetch-dest'] === 'document' });
    if (path === '/site-entry.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL('./site-entry.mjs', import.meta.url))); }
    else if (path === '/downloads/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Downloads destination</title><h1>Native document download page</h1>'); }
    else if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); }
    else { res.statusCode = 404; res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(join(tmpdir(), 'yitoken-entry-test-'));
  browser = spawn(process.env.CHROME_BIN || 'google-chrome', ['--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.ok(port, 'Isolated Chrome must start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', event => { const m = JSON.parse(event.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await send('Page.enable');
});
after(async () => {
  socket?.close();
  if (browser && browser.exitCode === null) { const exit = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGTERM'); await exit; }
  if (server) await new Promise(resolve => server.close(resolve));
  if (profile) await rm(profile, { recursive: true, force: true });
});
test('guests get native desktop and mobile download links without replacing existing navigation', async () => {
  await navigate();
  await evaluate(`globalThis.YitokenSiteDownloadEntries?.refresh()`);
  const result = await evaluate(`({links:[...document.querySelectorAll('header a[href="/downloads/"],.overlay a[href="/downloads/"]')].map(a=>({href:a.getAttribute('href'),target:a.target})),signIn:document.querySelectorAll('a[href="/sign-in"]').length,about:document.querySelectorAll('a[href="/about"]').length,attribution:document.body.innerText.includes('New API / QuantumNous')})`);
  assert.equal(result.links.length, 2, 'Feature absent: both original navigation locations need a download link');
  assert.ok(result.links.every(a => a.href === '/downloads/' && a.target !== '_blank'));
  assert.equal(result.signIn, 2); assert.equal(result.about, 2); assert.equal(result.attribution, true);
});
test('all seven language blocks have a visible desktop app card and footer link while web studio and copyright remain', async () => {
  await navigate(); await waitFor(`document.querySelector('.custom-home-content').shadowRoot.querySelector('[data-yitoken-download-card]')`);
  for (const [lang, label] of Object.entries(languages)) {
    await evaluate(`document.documentElement.lang=${JSON.stringify(lang)}`);
    await waitFor(`document.querySelector('header a[href="/downloads/"]')?.textContent===${JSON.stringify(label)}`);
    const result = await evaluate(`(()=>{const s=document.querySelector('.custom-home-content').shadowRoot;const b=s.querySelector('.l[lang='+${JSON.stringify(lang)}+']');return {cards:b.querySelectorAll('[data-yitoken-download-card]').length,cardHref:b.querySelector('[data-yitoken-download-card] a')?.getAttribute('href'),footerHref:b.querySelector('footer a[href="/downloads/"]')?.getAttribute('href'),original:b.querySelector('[data-existing-business]')?.textContent,source:!!b.querySelector('footer a[href="/source/"]'),copyright:b.querySelector('footer')?.textContent.includes('Original registration')}})()`);
    assert.equal(result.cards, 1); assert.equal(result.cardHref, '/downloads/'); assert.equal(result.footerHref, '/downloads/');
    assert.ok(result.original.includes('Original web studio')); assert.equal(result.source, true); assert.equal(result.copyright, true);
  }
});
test('React-like replacement, Shadow replacement and repeated refresh do not duplicate or lose entry points', async () => {
  await navigate(); await waitFor(`document.querySelector('header a[href="/downloads/"]')`);
  await evaluate(`document.querySelector('.desktop').innerHTML=window.originalNav;document.querySelector('.custom-home-content').shadowRoot.innerHTML=window.originalHome;`);
  await waitFor(`document.querySelector('header a[href="/downloads/"]') && document.querySelector('.custom-home-content').shadowRoot.querySelector('[data-yitoken-download-card]')`);
  await evaluate(`globalThis.YitokenSiteDownloadEntries.refresh();globalThis.YitokenSiteDownloadEntries.refresh();`);
  const counts = await evaluate(`({nav:document.querySelectorAll('header a[href="/downloads/"]').length,cards:document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-yitoken-download-card]').length,footer:document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('footer a[href="/downloads/"]').length})`);
  assert.deepEqual(counts, { nav: 1, cards: 7, footer: 7 });
});
test('long translated labels and tablet navigation remain contained; mobile uses the existing menu', async () => {
  await navigate(); await waitFor(`document.querySelector('header a[href="/downloads/"]')`);
  for (const width of [390, 768, 1280]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.lang='fr'`);
    await waitFor(`document.querySelector('header a[href="/downloads/"]')?.textContent==='Téléchargements'`);
    const result = await evaluate(`({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,signIn:[...document.querySelectorAll('header a[href="/sign-in"]')].map(a=>a.getBoundingClientRect().right),navWrap:getComputedStyle(document.querySelector('.desktop')).flexWrap})`);
    assert.equal(result.overflow, 0); assert.ok(result.signIn.every(right => right <= width + 1));
    if (width >= 640) assert.equal(result.navWrap, 'wrap');
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[aria-label="Toggle navigation menu"]').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.overlay')).display`), 'block');
  assert.equal(await evaluate(`document.body.style.overflow`), 'hidden');
});
for (const location of ['header', 'card', 'footer', 'mobile']) {
  test(`${location} entry performs an unauthenticated top-level Document GET, not an SPA change`, async () => {
    await navigate(); await waitFor(`document.querySelector('header a[href="/downloads/"]')`);
    const prior = requests.filter(r => r.path === '/downloads/' && r.document).length;
    const selector = location === 'header' ? `document.querySelector('header a[href="/downloads/"]')` : location === 'mobile' ? `document.querySelector('.overlay a[href="/downloads/"]')` : `document.querySelector('.custom-home-content').shadowRoot.querySelector('${location === 'card' ? '[data-yitoken-download-card]' : 'footer'} a[href="/downloads/"]')`;
    await evaluate(`${selector}.click()`);
    await waitFor(`location.pathname==='/downloads/' && document.title==='Downloads destination'`);
    assert.equal(requests.filter(r => r.path === '/downloads/' && r.document).length, prior + 1);
    assert.ok(requests.filter(r => r.path === '/downloads/').every(r => r.method === 'GET'));
  });
}
test('cleanup removes only injected entries and leaves original content available for rollback', async () => {
  await navigate(); await waitFor(`document.querySelector('header a[href="/downloads/"]')`);
  await evaluate(`globalThis.YitokenSiteDownloadEntries.stop()`);
  const result = await evaluate(`({nav:document.querySelectorAll('a[href="/downloads/"]').length,cards:document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-yitoken-download-card]').length,source:document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('a[href="/source/"]').length,studio:document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-existing-business]').length,attribution:document.body.innerText.includes('New API / QuantumNous')})`);
  assert.deepEqual(result, { nav: 0, cards: 0, source: 7, studio: 7, attribution: true });
});
