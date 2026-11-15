import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const languages = {
  'zh-CN': '桌面创作客户端', 'zh-TW': '桌面創作客戶端', en: 'Desktop client',
  fr: 'Client de bureau', ru: 'Клиент для ПК', ja: 'デスクトップアプリ', vi: 'Ứng dụng máy tính',
};
const existingNav = `<a href="/">Home</a><a href="/dashboard">Console</a><a href="/pricing">Model Square</a><a href="/rankings">Rankings</a><a href="/about">About</a>`;
// Public anonymous ShadowDOM snapshot, 2026-10-14: original hero/launch markup and .ze styles.
const productionHomeStyles = ".ze{\n  --acc: var(--primary, #16a34a);\n  --acc-fg: var(--primary-foreground, #fff);\n  --fg: var(--foreground, #111);\n  --muted: var(--muted-foreground, #667);\n  --card: var(--card, #fff);\n  --line: var(--border, #e5e7eb);\n  --soft: color-mix(in oklch, var(--acc) 8%, transparent);\n  font-family: var(--font-body, system-ui, -apple-system, sans-serif);\n  color: var(--fg);\n  line-height: 1.6;\n}\n.ze *{box-sizing:border-box}\n.ze section{max-width:1080px;margin:0 auto;padding:52px 24px;scroll-margin-top:32px}\n.ze h1,.ze h2,.ze h3{margin:0;line-height:1.25}\n.ze p{margin:0}\n.ze a{text-decoration:none}\n\n/* hero（logo 各语言共用一份，放在语言块外面） */\n/* 顶部导航是悬浮的（64px 高），上边距要把它算进去：字标离导航底边约 32px（手机 24px） */\n.ze .logo{max-width:1080px;margin:0 auto;padding:96px 24px 0}\n.ze .logo img{width:min(300px,68%);height:auto;display:block;margin:0 auto 26px}\n.ze .hero{text-align:center;padding-top:0;padding-bottom:0}\n.ze .hero + section{padding-top:40px}\n.ze .hero h1{font-size:clamp(1.9rem,5vw,3rem);letter-spacing:-.02em;font-weight:700}\n.ze .hero h1 em{font-style:normal;color:var(--acc)}\n.ze .lead{color:var(--muted);font-size:clamp(1rem,2.2vw,1.18rem);max-width:600px;margin:18px auto 0}\n.ze .btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:32px}\n.ze .btn{display:inline-flex;align-items:center;gap:8px;padding:13px 30px;border-radius:999px;font-weight:600;font-size:.98rem;border:1px solid transparent;transition:opacity .15s}\n.ze .btn:hover{opacity:.88}\n.ze .btn.p{background:var(--acc);color:var(--acc-fg)}\n.ze .btn.s{border-color:var(--line);color:var(--fg)}\n.ze .facts{display:flex;gap:10px 28px;justify-content:center;flex-wrap:wrap;margin-top:28px;color:var(--muted);font-size:.88rem}\n.ze .facts span{display:inline-flex;align-items:center;gap:7px}\n.ze .facts i{width:6px;height:6px;border-radius:50%;background:var(--acc);display:inline-block;font-style:normal}\n\n/* GPT-6.1 Sol 入口 */\n.ze .launch{max-width:640px;margin:34px auto 0;padding:24px 26px;border-radius:16px;background:var(--soft);border:1px solid color-mix(in oklch,var(--acc) 22%,transparent);display:flex;flex-direction:column;align-items:center;gap:8px}\n.ze .launch-t{font-size:1.2rem;font-weight:700;color:var(--fg)}\n.ze .launch-d{color:var(--muted);font-size:.95rem}\n.ze .launch .btn{margin-top:10px}\n\n/* section heads */\n.ze .kicker{text-align:center;color:var(--acc);font-weight:600;letter-spacing:.08em;text-transform:uppercase;font-size:.78rem;margin-bottom:10px}\n.ze h2{text-align:center;font-size:clamp(1.4rem,3.4vw,1.85rem);font-weight:700;letter-spacing:-.01em}\n.ze .sub2{text-align:center;color:var(--muted);margin:12px auto 36px;max-width:560px;font-size:.96rem}\n\n/* cards */\n.ze .grid2{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}\n.ze .grid3{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}\n.ze .grid4{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(360px,1fr))}\n.ze .card{border:1px solid var(--line);border-radius:16px;padding:26px;background:var(--card)}\n.ze .card h3{font-size:1.12rem;font-weight:650;margin-bottom:10px}\n.ze .card p{color:var(--muted);font-size:.93rem}\n.ze code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:var(--soft);padding:1px 5px;border-radius:5px;color:var(--fg)}\n.ze .tag{display:inline-block;padding:3px 10px;border-radius:999px;background:var(--soft);color:var(--acc);font-size:.76rem;font-weight:600;margin-bottom:14px}\n.ze .models{margin:16px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:7px}\n.ze .models li{border:1px solid var(--line);border-radius:7px;padding:4px 9px;font-size:.79rem;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}\n\n/* usage split */\n.ze .way{border:1px solid var(--line);border-radius:16px;padding:26px;background:var(--card);display:flex;flex-direction:column}\n.ze .way .who{color:var(--acc);font-size:.84rem;font-weight:600;margin-bottom:8px}\n.ze .way h3{font-size:1.12rem;font-weight:650;margin-bottom:10px}\n.ze .way p{flex:1}\n.ze .ticks{margin:16px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px}\n.ze .ticks li{position:relative;padding-left:22px;color:var(--muted);font-size:.9rem}\n.ze .ticks li::before{content:'';position:absolute;left:0;top:.45em;width:11px;height:6px;border-left:2px solid var(--acc);border-bottom:2px solid var(--acc);transform:rotate(-45deg)}\n.ze .way .go{margin-top:18px;color:var(--acc);font-weight:600;font-size:.92rem}\n.ze pre{margin:16px 0 0;padding:15px;border-radius:10px;background:var(--soft);font-size:.8rem;line-height:1.65;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}\n.ze pre b{color:var(--acc);font-weight:600}\n\n/* steps */\n.ze .step{text-align:left}\n.ze .step .no{width:30px;height:30px;border-radius:50%;background:var(--acc);color:var(--acc-fg);display:flex;align-items:center;justify-content:center;font-size:.88rem;font-weight:700;margin-bottom:14px}\n\n/* faq */\n.ze details{border-bottom:1px solid var(--line);padding:18px 0}\n.ze details:first-of-type{border-top:1px solid var(--line)}\n.ze summary{cursor:pointer;font-weight:600;font-size:1rem;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:16px}\n.ze summary::-webkit-details-marker{display:none}\n.ze summary::after{content:'+';color:var(--acc);font-size:1.3rem;font-weight:400;flex-shrink:0}\n.ze details[open] summary::after{content:'\\2212'}\n.ze details p{color:var(--muted);font-size:.93rem;margin-top:12px;max-width:760px}\n.ze .faqwrap{max-width:760px;margin:0 auto}\n\n/* cta */\n.ze .cta{text-align:center;border-radius:20px;background:var(--soft);padding:54px 24px}\n.ze .cta h2{margin-bottom:12px}\n\n.ze footer{border-top:1px solid var(--line);padding:30px 24px;text-align:center;color:var(--muted);font-size:.83rem;line-height:2}\n.ze footer a{color:var(--muted)}\n.ze footer a:hover{color:var(--acc)}\n@media (max-width:600px){.ze section{padding:44px 20px}.ze .logo{padding:88px 20px 0}}\n\n/* 多语言：每种语言一整份内容，按界面语言（外层元素的 lang）只显示一份；拿不到语言时显示简体中文 */\n.ze .l{display:none}\n.ze .l-zh-CN{display:block}\n[lang=\"zh-TW\"] .ze .l-zh-CN,[lang=\"en\"] .ze .l-zh-CN,[lang=\"fr\"] .ze .l-zh-CN,[lang=\"ru\"] .ze .l-zh-CN,[lang=\"ja\"] .ze .l-zh-CN,[lang=\"vi\"] .ze .l-zh-CN{display:none}\n[lang=\"zh-TW\"] .ze .l-zh-TW,[lang=\"en\"] .ze .l-en,[lang=\"fr\"] .ze .l-fr,[lang=\"ru\"] .ze .l-ru,[lang=\"ja\"] .ze .l-ja,[lang=\"vi\"] .ze .l-vi{display:block}\n";
const productionHeroes = {
  "zh-CN": "<section class=\"hero\">\n    <h1>一个令牌,<em>接入多家 AI 模型</em></h1>\n    <p class=\"lead\">YITOKEN 是统一的 AI API 网关。OpenAI 风格接口,一套账户、一份额度、一处用量明细。当前接入 Seedance 视频、Seedream 与无界图片,以及 GPT-6.1 Sol 文本模型。</p>\n    <div class=\"btns\">\n      <a class=\"btn p\" href=\"/sign-up\">免费注册</a>\n      <a class=\"btn s\" href=\"/pricing\">看模型和价格</a>\n      <a class=\"btn s\" href=\"#studio\">不写代码？用创作台</a>\n    </div>\n    <div class=\"facts\">\n      <span><i></i>OpenAI 风格接口</span>\n      <span><i></i>视频 · 图片 · 文本</span>\n      <span><i></i>按次计费,不办会员</span>\n      <span><i></i>支付宝 / 微信充值</span>\n    </div>\n    <div class=\"launch\">\n      <p class=\"launch-t\">YiToken 现已支持 GPT‑6.1 Sol。</p>\n      <p class=\"launch-d\">更适合复杂写代码、连续处理多件事和日常工作。</p>\n      <a class=\"btn p\" href=\"/playground?model=gpt-6.1-sol&amp;group=GPT%20Codex\">立即使用 GPT‑6.1 Sol</a>\n    </div>\n  </section>",
  "zh-TW": "<section class=\"hero\">\n    <h1>一把金鑰，<em>串接多家 AI 模型</em></h1>\n    <p class=\"lead\">YITOKEN 是統一的 AI API 閘道。OpenAI 風格介面，一個帳號、一份額度、一處用量明細。目前已串接 Seedance 影片、Seedream 與無界圖片，以及 GPT-6.1 Sol 文字模型。</p>\n    <div class=\"btns\">\n      <a class=\"btn p\" href=\"/sign-up\">免費註冊</a>\n      <a class=\"btn s\" href=\"/pricing\">看模型與價格</a>\n      <a class=\"btn s\" href=\"#studio-zh-tw\">不寫程式？用創作台</a>\n    </div>\n    <div class=\"facts\">\n      <span><i></i>OpenAI 風格介面</span>\n      <span><i></i>影片 · 圖片 · 文字</span>\n      <span><i></i>按次計費，不必加入會員</span>\n      <span><i></i>支付寶 / 微信支付儲值</span>\n    </div>\n    <div class=\"launch\">\n      <p class=\"launch-t\">YiToken 現已支援 GPT‑6.1 Sol。</p>\n      <p class=\"launch-d\">更適合複雜的程式開發、連續處理多件事與日常工作。</p>\n      <a class=\"btn p\" href=\"/playground?model=gpt-6.1-sol&amp;group=GPT%20Codex\">立即使用 GPT‑6.1 Sol</a>\n    </div>\n  </section>",
  "en": "<section class=\"hero\">\n    <h1>One API key, <em>many AI models</em></h1>\n    <p class=\"lead\">YITOKEN is a unified AI API gateway: an OpenAI-style API with one account, one balance and one usage log. Available now: Seedance video, Seedream and noimg images, and the GPT-6.1 Sol text model.</p>\n    <div class=\"btns\">\n      <a class=\"btn p\" href=\"/sign-up\">Sign up free</a>\n      <a class=\"btn s\" href=\"/pricing\">Models &amp; pricing</a>\n      <a class=\"btn s\" href=\"#studio-en\">No code? Use Studio</a>\n    </div>\n    <div class=\"facts\">\n      <span><i></i>OpenAI-style API</span>\n      <span><i></i>Video · Image · Text</span>\n      <span><i></i>Pay per use, no membership</span>\n      <span><i></i>Top up via Alipay / WeChat Pay</span>\n    </div>\n    <div class=\"launch\">\n      <p class=\"launch-t\">YiToken now supports GPT‑6.1 Sol.</p>\n      <p class=\"launch-d\">Better suited to complex coding, handling several things in a row, and everyday work.</p>\n      <a class=\"btn p\" href=\"/playground?model=gpt-6.1-sol&amp;group=GPT%20Codex\">Use GPT‑6.1 Sol now</a>\n    </div>\n  </section>",
  "fr": "<section class=\"hero\">\n    <h1>Une seule clé API, <em>de nombreux modèles d'IA</em></h1>\n    <p class=\"lead\">YITOKEN est une passerelle API d'IA unifiée&nbsp;: une API de style OpenAI, avec un seul compte, un seul solde et un seul historique d'utilisation. Déjà disponibles&nbsp;: la vidéo Seedance, les images Seedream et noimg, ainsi que le modèle de texte GPT-6.1 Sol.</p>\n    <div class=\"btns\">\n      <a class=\"btn p\" href=\"/sign-up\">Inscription gratuite</a>\n      <a class=\"btn s\" href=\"/pricing\">Modèles et tarifs</a>\n      <a class=\"btn s\" href=\"#studio-fr\">Sans code&nbsp;? Utilisez Studio</a>\n    </div>\n    <div class=\"facts\">\n      <span><i></i>API de style OpenAI</span>\n      <span><i></i>Vidéo · Image · Texte</span>\n      <span><i></i>Paiement à l'usage, sans abonnement</span>\n      <span><i></i>Recharge par Alipay / WeChat Pay</span>\n    </div>\n    <div class=\"launch\">\n      <p class=\"launch-t\">YiToken prend désormais en charge GPT‑6.1 Sol.</p>\n      <p class=\"launch-d\">Idéal pour le code complexe, l'enchaînement de plusieurs tâches et le travail au quotidien.</p>\n      <a class=\"btn p\" href=\"/playground?model=gpt-6.1-sol&amp;group=GPT%20Codex\">Utiliser GPT‑6.1 Sol</a>\n    </div>\n  </section>",
  "ru": "<section class=\"hero\">\n    <h1>Один API-ключ — <em>множество моделей ИИ</em></h1>\n    <p class=\"lead\">YITOKEN — единый API-шлюз для моделей ИИ: API в стиле OpenAI, один аккаунт, один баланс и одна история использования. Уже доступны видео Seedance, изображения Seedream и noimg, а также текстовая модель GPT-6.1 Sol.</p>\n    <div class=\"btns\">\n      <a class=\"btn p\" href=\"/sign-up\">Зарегистрироваться бесплатно</a>\n      <a class=\"btn s\" href=\"/pricing\">Модели и цены</a>\n      <a class=\"btn s\" href=\"#studio-ru\">Без кода? Откройте Студию</a>\n    </div>\n    <div class=\"facts\">\n      <span><i></i>API в стиле OpenAI</span>\n      <span><i></i>Видео · Изображения · Текст</span>\n      <span><i></i>Оплата по факту, без подписки</span>\n      <span><i></i>Пополнение через Alipay / WeChat Pay</span>\n    </div>\n    <div class=\"launch\">\n      <p class=\"launch-t\">YiToken теперь поддерживает GPT‑6.1 Sol.</p>\n      <p class=\"launch-d\">Лучше подходит для сложного программирования, нескольких задач подряд и повседневной работы.</p>\n      <a class=\"btn p\" href=\"/playground?model=gpt-6.1-sol&amp;group=GPT%20Codex\">Открыть GPT‑6.1 Sol</a>\n    </div>\n  </section>",
  "ja": "<section class=\"hero\">\n    <h1>APIキーひとつで、<em>複数の AI モデルへ</em></h1>\n    <p class=\"lead\">YITOKEN は統合型の AI API ゲートウェイです。OpenAI スタイルの API で、アカウント・残高・利用明細をひとつにまとめられます。現在は Seedance の動画、Seedream と noimg の画像、GPT-6.1 Sol のテキストモデルを提供しています。</p>\n    <div class=\"btns\">\n      <a class=\"btn p\" href=\"/sign-up\">無料で登録</a>\n      <a class=\"btn s\" href=\"/pricing\">モデルと料金を見る</a>\n      <a class=\"btn s\" href=\"#studio-ja\">コード不要？スタジオへ</a>\n    </div>\n    <div class=\"facts\">\n      <span><i></i>OpenAI スタイルの API</span>\n      <span><i></i>動画 · 画像 · テキスト</span>\n      <span><i></i>従量課金・月額プランなし</span>\n      <span><i></i>Alipay / WeChat Pay でチャージ</span>\n    </div>\n    <div class=\"launch\">\n      <p class=\"launch-t\">YiToken が GPT‑6.1 Sol に対応しました。</p>\n      <p class=\"launch-d\">複雑なコーディング、複数の作業の連続処理、日常業務により適しています。</p>\n      <a class=\"btn p\" href=\"/playground?model=gpt-6.1-sol&amp;group=GPT%20Codex\">今すぐ GPT‑6.1 Sol を使う</a>\n    </div>\n  </section>",
  "vi": "<section class=\"hero\">\n    <h1>Một khóa API, <em>kết nối nhiều mô hình AI</em></h1>\n    <p class=\"lead\">YITOKEN là cổng API AI hợp nhất: API theo phong cách OpenAI, một tài khoản, một số dư và một nơi xem chi tiết sử dụng. Hiện có video Seedance, ảnh Seedream và noimg, cùng mô hình văn bản GPT-6.1 Sol.</p>\n    <div class=\"btns\">\n      <a class=\"btn p\" href=\"/sign-up\">Đăng ký miễn phí</a>\n      <a class=\"btn s\" href=\"/pricing\">Xem mô hình và giá</a>\n      <a class=\"btn s\" href=\"#studio-vi\">Không viết code? Dùng Studio</a>\n    </div>\n    <div class=\"facts\">\n      <span><i></i>API phong cách OpenAI</span>\n      <span><i></i>Video · Hình ảnh · Văn bản</span>\n      <span><i></i>Trả theo mức dùng, không gói hội viên</span>\n      <span><i></i>Nạp tiền qua Alipay / WeChat Pay</span>\n    </div>\n    <div class=\"launch\">\n      <p class=\"launch-t\">YiToken nay đã hỗ trợ GPT‑6.1 Sol.</p>\n      <p class=\"launch-d\">Phù hợp hơn cho lập trình phức tạp, xử lý liên tiếp nhiều việc và công việc hằng ngày.</p>\n      <a class=\"btn p\" href=\"/playground?model=gpt-6.1-sol&amp;group=GPT%20Codex\">Dùng GPT‑6.1 Sol ngay</a>\n    </div>\n  </section>"
};
const home = `<style>${productionHomeStyles}</style><div data-fixture-language lang="en"><div class="ze">${Object.keys(languages).map(lang => `<div class="l l-${lang}" lang="${lang}">${productionHeroes[lang]}<section id="studio-${lang}" data-existing-business><h2>Original web studio</h2><a href="/dashboard/studio">Original studio</a></section><footer><div>Copyright original</div><div><a href="/source/">Original source</a> · <a href="/about">About</a></div><div>Original registration</div></footer></div>`).join('')}</div></div>`;
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font:16px Arial}header{position:fixed;top:0;width:100%;background:white;z-index:20}header>nav{display:flex;align-items:center;justify-content:space-between;min-height:64px;padding:12px 16px}header>nav>a{width:100px;flex-shrink:0}.desktop{display:flex;gap:2px}.desktop>a{padding:8px 12px}.actions{display:flex;gap:8px}.mobile-actions{display:none}.overlay{display:none;position:fixed;inset:0;padding:80px 30px;background:white;z-index:10}.overlay.open{display:block}.overlay nav{display:flex;flex-direction:column}.overlay a{padding:12px 0}.custom-home-content{padding-top:70px}@media(max-width:639px){.desktop,.actions{display:none}.mobile-actions{display:flex}}</style></head><body><div id="root"><header><nav><a href="/">YITOKEN</a><div class="desktop">${existingNav}<div class="actions"><button>Language</button><a href="/sign-in">Sign in</a></div></div><div class="mobile-actions"><button aria-label="Toggle navigation menu">Menu</button></div></nav></header><div class="overlay"><nav>${existingNav}</nav><a href="/sign-in">Sign in</a></div><div class="custom-home-content"></div><footer><a href="https://github.com/QuantumNous/new-api">New API / QuantumNous</a></footer></div><script>window.originalNav=${JSON.stringify(existingNav)};window.originalHome=${JSON.stringify(home)};const host=document.querySelector('.custom-home-content');host.attachShadow({mode:'open'}).innerHTML=window.originalHome;window.originalShadowHTML=host.shadowRoot.innerHTML;window.originalLaunchNodes=[...host.shadowRoot.querySelectorAll('.hero>.launch')];document.querySelector('[aria-label="Toggle navigation menu"]').onclick=()=>{document.querySelector('.overlay').classList.toggle('open');document.body.style.overflow=document.querySelector('.overlay').classList.contains('open')?'hidden':'';};</script><script type="module" src="/site-entry.mjs"></script></body></html>`;
let server, browser, profile, socket, base, sequence = 0;
const pending = new Map();
const requests = [];
const networkRequests = [];
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)); }, 15000);
    pending.set(id, m => { clearTimeout(timeout); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function evaluate(expression, sessionId) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression, sessionId) {
  return evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;function check(){if(${expression})return resolve(true);if(Date.now()>end)return reject(Error('Expected DOM state: '+${JSON.stringify(expression)}));setTimeout(check,20)}check()})`, sessionId);
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
    else if (path === '/studio-guide.mjs') {
      try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL('../studio-guide/studio-guide.mjs', import.meta.url))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; res.statusCode = 404; res.end('not implemented'); }
    }
    else if (path === '/studio') { res.setHeader('Content-Type', 'text/html'); res.end(studioFixture); }
    else if (path === '/studio-host') { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><iframe src="http://localhost:${server.address().port}/studio?fixture=do-not-forward#fixture-fragment"></iframe>`); }
    else if (path === '/downloads/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Downloads destination</title><h1>Native document download page</h1>'); }
    else if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); }
    else { res.statusCode = 404; res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(join(tmpdir(), 'yitoken-entry-test-'));
  const chrome = process.env.CHROME_BIN || 'google-chrome';
  const startupDeadline = Date.now() + 30000;
  let stderrTail = Buffer.alloc(0), launchError, lastStartupError, target;
  browser = spawn(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', chunk => { stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-8192); });
  browser.once('error', error => { launchError = error; });
  function browserStartupError(reason) {
    return Error(`${reason}; executable=${chrome}; exitCode=${browser.exitCode}; signal=${browser.signalCode}; spawnError=${launchError?.message || 'none'}; lastReadinessError=${lastStartupError?.message || 'none'}\nChrome stderr (last 8192 bytes):\n${stderrTail.toString('utf8') || '(empty)'}`);
  }
  while (Date.now() < startupDeadline) {
    if (launchError || browser.exitCode !== null || browser.signalCode !== null) throw browserStartupError('Isolated Chrome failed before readiness');
    try {
      const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw Error('DevToolsActivePort does not contain a valid port');
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, startupDeadline - Date.now()))) });
      if (!response.ok) throw Error(`DevTools /json/list HTTP ${response.status}`);
      target = (await response.json()).find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (!target) throw Error('DevTools does not yet expose a page target');
    } catch (error) { lastStartupError = error; }
    if (launchError || browser.exitCode !== null || browser.signalCode !== null) throw browserStartupError('Isolated Chrome failed before readiness');
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(100, startupDeadline - Date.now()))));
  }
  if (!target) throw browserStartupError('Isolated Chrome did not become ready within 30000ms');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(browserStartupError('Chrome DevTools WebSocket did not open within startup deadline')), Math.max(1, startupDeadline - Date.now()));
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(browserStartupError('Chrome DevTools WebSocket failed to open')); }, { once: true });
  });
  socket.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Network.requestWillBeSent') networkRequests.push(m.params);
    if (m.method === 'Fetch.requestPaused') send('Fetch.fulfillRequest', {
      requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: Buffer.from('<!doctype html><title>Downloads destination</title><h1>Native document download page</h1>').toString('base64'),
    }, m.sessionId).catch(error => { throw error; });
  });
  await send('Page.enable');
  await send('Network.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://yitoken.com.cn/downloads/', resourceType: 'Document', requestStage: 'Request' }] });
});
after(async () => {
  socket?.close();
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) { const exit = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGTERM'); await exit; }
  if (server) await new Promise(resolve => server.close(resolve));
  // CI observed ENOTEMPTY while Chrome finished writing its isolated Default profile.
  // Bound cleanup retries to this owned directory; persistent failures still fail the hook.
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
test('guests get native desktop and mobile download links without replacing existing navigation', async () => {
  await navigate();
  await evaluate(`globalThis.YitokenSiteDownloadEntries?.refresh()`);
  const result = await evaluate(`({links:[...document.querySelectorAll('header a[href="/downloads/"],.overlay a[href="/downloads/"]')].map(a=>({href:a.getAttribute('href'),target:a.target,rel:a.rel})),signIn:document.querySelectorAll('a[href="/sign-in"]').length,about:document.querySelectorAll('a[href="/about"]').length,attribution:document.body.innerText.includes('New API / QuantumNous')})`);
  assert.equal(result.links.length, 2, 'Feature absent: both original navigation locations need a download link');
  assert.ok(result.links.every(a => a.href === '/downloads/' && a.target === '_blank' && a.rel.split(/\s+/).includes('noopener') && a.rel.split(/\s+/).includes('noreferrer')));
  assert.equal(result.signIn, 2); assert.equal(result.about, 2); assert.equal(result.attribution, true);
});
test('all seven language blocks have a visible desktop app card and footer link while web studio and copyright remain', async () => {
  await navigate(); await waitFor(`document.querySelector('.custom-home-content').shadowRoot.querySelector('[data-yitoken-download-card]')`);
  for (const [lang, label] of Object.entries(languages)) {
    await evaluate(`document.documentElement.lang=${JSON.stringify(lang)}`);
    await waitFor(`document.querySelector('header a[href="/downloads/"]')?.textContent===${JSON.stringify(label)}`);
    const result = await evaluate(`(()=>{const s=document.querySelector('.custom-home-content').shadowRoot;const b=s.querySelector('.l[lang='+${JSON.stringify(lang)}+']');return {cards:b.querySelectorAll('[data-yitoken-download-card]').length,cardHref:b.querySelector('[data-yitoken-download-card] a')?.getAttribute('href'),footerHref:b.querySelector('footer a[href="/downloads/"]')?.getAttribute('href'),footerText:b.querySelector('footer a[href="/downloads/"]')?.textContent,original:b.querySelector('[data-existing-business]')?.textContent,source:!!b.querySelector('footer a[href="/source/"]'),copyright:b.querySelector('footer')?.textContent.includes('Original registration')}})()`);
    assert.equal(result.cards, 1); assert.equal(result.cardHref, '/downloads/'); assert.equal(result.footerHref, '/downloads/'); assert.equal(result.footerText, label);
    assert.ok(result.original.includes('Original web studio')); assert.equal(result.source, true); assert.equal(result.copyright, true);
  }
});
test('actual public GPT launch and Studio form a compact equal desktop pair in all seven languages', async () => {
  const metrics = [];
  if (process.env.YITOKEN_SCREENSHOT_DIR) await mkdir(process.env.YITOKEN_SCREENSHOT_DIR, { recursive: true });
  await navigate(); await waitFor(`document.querySelector('.custom-home-content').shadowRoot.querySelector('[data-yitoken-home-promos]')`);
  for (const width of [390, 700, 701, 768, 1024, 1280, 1920]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1400, deviceScaleFactor: 1, mobile: false });
    for (const lang of Object.keys(languages)) {
      await evaluate(`document.documentElement.lang=${JSON.stringify(lang)};document.querySelector('.custom-home-content').shadowRoot.querySelector('[data-fixture-language]').lang=${JSON.stringify(lang)}`);
      const result = await evaluate(`(()=>{const root=document.querySelector('.custom-home-content').shadowRoot,b=root.querySelector('.l[lang="'+${JSON.stringify(lang)}+'"]'),pair=b.querySelector('[data-yitoken-home-promos]'),model=pair.querySelector('.launch'),studio=pair.querySelector('[data-yitoken-download-card] .card'),rect=n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]};return {pairs:b.querySelectorAll('[data-yitoken-home-promos]').length,model:rect(model),studio:rect(studio),align:[getComputedStyle(model).textAlign,getComputedStyle(studio).textAlign],contentAlign:[...model.querySelectorAll('.launch-t,.launch-d,a'),...studio.querySelectorAll('.kicker,h2,.sub2,a,.download-note')].map(n=>getComputedStyle(n).textAlign),buttonCenters:[model,studio].map(n=>{const r=n.getBoundingClientRect(),a=n.querySelector('a').getBoundingClientRect();return a.x+a.width/2-r.x-r.width/2}),href:model.querySelector('a').getAttribute('href'),target:studio.querySelector('a').target,note:studio.querySelector('.download-note').textContent,button:parseFloat(getComputedStyle(studio.querySelector('a')).fontSize),padding:parseFloat(getComputedStyle(studio).paddingTop),hero:b.querySelector('.hero').innerHTML,originalNode:window.originalLaunchNodes.includes(model),business:b.querySelector('[data-existing-business]').textContent,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()`);
      metrics.push({lang,width,...result});
      if (process.env.YITOKEN_SCREENSHOT_DIR && ['zh-CN','fr'].includes(lang) && [390,768,1280,1920].includes(width)) {
        const top=result.model[1],height=Math.max(result.model[1]+result.model[3],result.studio[1]+result.studio[3])-top+16;
        const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:top,width,height,scale:1}});
        await writeFile(join(process.env.YITOKEN_SCREENSHOT_DIR,`fixture-after-${lang}-${width}.png`),Buffer.from(shot.data,'base64'));
      }
      assert.equal(result.pairs,1); assert.equal(result.originalNode,true);
      assert.equal(result.href,'/playground?model=gpt-6.1-sol&group=GPT%20Codex'); assert.equal(result.target,'_self');
      assert.deepEqual(result.align,['center','center']);
      assert.ok(result.contentAlign.every(align=>align==='center'), `${lang}/${width}: only the two promo cards center their titles, descriptions, buttons and notes`);
      assert.ok(result.buttonCenters.every(offset=>Math.abs(offset)<=1), `${lang}/${width}: both buttons must be centered within their own card`); assert.ok(result.padding<=24); assert.ok(result.button<=14);
      assert.ok(!/预发布|預發布|Prerelease|Préversion|Предварительная версия|プレビュー版|Bản xem trước/.test(result.note));
      assert.ok(result.business.includes('Original web studio')); assert.equal(result.overflow,0,`${lang}/${width}`);
      if(width>700){assert.equal(result.model[1],result.studio[1],`${lang}/${width}: same row`);assert.ok(Math.abs(result.model[2]-result.studio[2])<1);assert.ok(Math.abs(result.model[3]-result.studio[3])<1);}
      else {assert.equal(result.model[0],result.studio[0]);assert.ok(result.studio[1]>=result.model[1]+result.model[3]);}
    }
  }
  if (process.env.YITOKEN_SCREENSHOT_DIR) await writeFile(join(process.env.YITOKEN_SCREENSHOT_DIR,'fixture-after-metrics.json'),JSON.stringify(metrics,null,2));
});
test('compact home refresh and rerender remain idempotent; stop restores exact original ShadowDOM', async () => {
  await navigate(); await waitFor(`document.querySelector('.custom-home-content').shadowRoot.querySelector('[data-yitoken-home-promos]')`);
  await evaluate(`YitokenSiteDownloadEntries.refresh();YitokenSiteDownloadEntries.refresh()`);
  assert.equal(await evaluate(`document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-yitoken-home-promos]').length`),7);
  await evaluate(`YitokenSiteDownloadEntries.stop()`);
  assert.equal(await evaluate(`document.querySelector('.custom-home-content').shadowRoot.innerHTML===window.originalShadowHTML`),true,'No original hero/card/content/metadata changes remain');
  assert.equal(await evaluate(`window.originalLaunchNodes.every(n=>n.isConnected && n.parentElement.classList.contains('hero'))`),true);
  await evaluate(`document.querySelector('.custom-home-content').shadowRoot.innerHTML=window.originalHome;import('/site-entry.mjs').then(m=>m.startDownloadEntries(document))`);
  await waitFor(`document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-yitoken-home-promos]').length===7`);
});
test('unknown or duplicate original GPT launch markup fails closed without changing original heroes', async () => {
  await navigate(); await waitFor(`document.querySelector('.custom-home-content').shadowRoot.querySelector('[data-yitoken-download-card]')`);
  await waitFor(`document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-yitoken-home-promos]').length===7`);
  await evaluate(`for(const n of document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-yitoken-home-promos]>.launch'))n.className='unknown-promo'`);
  await waitFor(`document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-yitoken-home-promos]').length===0`);
  assert.equal(await evaluate(`document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('.hero>.unknown-promo').length`),7,'A later unknown class must restore the original position without rewriting the node');
  await evaluate(`YitokenSiteDownloadEntries.stop()`);
  assert.equal(await evaluate(`document.querySelector('.custom-home-content').shadowRoot.innerHTML===window.originalShadowHTML.replaceAll('class="launch"','class="unknown-promo"')`),true,'Preserve the external class change, remove only our structure');
  for(const mutation of ["n.remove()", "n.querySelector('a').setAttribute('href','/unreviewed-model')", "n.after(n.cloneNode(true))", "n.className='unknown-promo'"]){
    await evaluate(`(()=>{YitokenSiteDownloadEntries.stop();const root=document.querySelector('.custom-home-content').shadowRoot;root.innerHTML=window.originalHome;for(const n of root.querySelectorAll('.hero>.launch')){${mutation}}window.unknownHeroes=[...root.querySelectorAll('.hero')].map(n=>n.outerHTML);import('/site-entry.mjs').then(m=>m.startDownloadEntries(document));})()`);
    await waitFor(`document.querySelector('.custom-home-content').shadowRoot.querySelector('[data-yitoken-download-card]')`);
    assert.equal(await evaluate(`document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-yitoken-home-promos]').length`),0);
    assert.equal(await evaluate(`JSON.stringify([...document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('.hero')].map(n=>n.outerHTML))===JSON.stringify(window.unknownHeroes)`),true);
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
  for (const width of [390, 768, 1024, 1280, 1920]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(()=>{YitokenSiteDownloadEntries.stop();document.documentElement.lang='fr';const labels=['Accueil','Console','Catalogue des modèles','Classement','À propos'];document.querySelector('.desktop').innerHTML=window.originalNav+'<div class="actions"><button>Langue</button><a href="/sign-in">Se connecter</a></div>';[...document.querySelectorAll('.desktop>a')].forEach((a,i)=>a.textContent=labels[i]);})()`);
    const baseline = await evaluate(`({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,original:[...document.querySelectorAll('.desktop>a')].map(a=>a.textContent)})`);
    await evaluate(`import('/site-entry.mjs').then(m=>m.startDownloadEntries(document))`);
    await waitFor(`document.querySelector('header a[href="/downloads/"]')?.textContent==='Client de bureau'`);
    const result = await evaluate(`({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,signIn:[...document.querySelectorAll('header a[href="/sign-in"]')].map(a=>a.getBoundingClientRect().right),navWrap:getComputedStyle(document.querySelector('.desktop')).flexWrap,original:[...document.querySelectorAll('.desktop>a:not([data-yitoken-download-nav-link])')].map(a=>a.textContent),links:[...document.querySelectorAll('.desktop a')].map(a=>{const r=a.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}})})`);
    assert.equal(result.overflow, 0); assert.ok(result.signIn.every(right => right <= width + 1));
    assert.ok(result.overflow <= baseline.overflow, `${width}: long original French navigation must not gain overflow`);
    assert.deepEqual(result.original, baseline.original);
    if (width >= 640) {
      assert.equal(result.navWrap, 'wrap');
      assert.ok(result.links.every(r=>r.width > 0 && r.left >= 0 && r.right <= width + 1), `${width}: all original navigation and client link stay visible`);
    }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[aria-label="Toggle navigation menu"]').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.overlay')).display`), 'block');
  assert.equal(await evaluate(`document.body.style.overflow`), 'hidden');
});
for (const location of ['card', 'footer']) {
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
test('authenticated header preserves 48px layout and original controls across desktop widths and seven labels', async () => {
  const frenchNav = `<a href="/">Accueil</a><a href="/dashboard">Console</a><a href="/pricing">Catalogue des modèles</a><a href="/rankings">Classement</a><a href="/about">À propos</a>`;
  const measure = `(()=>{const nav=document.querySelector('.console-top-nav').getBoundingClientRect(),search=document.querySelector('.console-search').getBoundingClientRect();return {header:document.querySelector('header').getBoundingClientRect().height,wrapper:document.querySelector('.console-nav-wrap').getBoundingClientRect().height,navCenter:nav.y+nav.height/2,searchCenter:search.y+search.height/2,publicBar:!!document.querySelector('.console-nav-wrap[data-yitoken-download-bar]'),wrap:getComputedStyle(document.querySelector('.console-top-nav')).flexWrap,profile:document.querySelector('.console-actions').lastElementChild.textContent,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,controls:[...document.querySelectorAll('.console-search,.console-actions>button')].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}),original:[...document.querySelectorAll('.console-top-nav a:not([data-yitoken-download-nav-link])')].map(n=>n.textContent)}})()`;
  for (const width of [1024, 1280, 1920]) {
    for (const [lang, label] of Object.entries(languages)) {
      await navigate(); await waitFor(`document.querySelector('header a[href="/downloads/"]')`);
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const nav = lang === 'fr' ? frenchNav : existingNav;
      await evaluate(`YitokenSiteDownloadEntries.stop();document.documentElement.lang=${JSON.stringify(lang)};const style=document.createElement('style');style.textContent='.console-header{height:48px}.console-inner{display:flex;height:100%;align-items:center;gap:8px;padding:0 12px}.console-brand{width:120px}.console-actions{display:flex;align-items:center;gap:8px;margin-left:auto}.console-top-nav{display:flex;align-items:center;gap:16px}.console-top-nav a{font-size:14px;line-height:20px;white-space:nowrap}.console-search{height:32px;width:160px}';document.head.append(style);document.querySelector('header').outerHTML='<header class="console-header"><div class="console-inner"><a class="console-brand" href="/">YITOKEN</a><div class="console-actions"><div class="console-nav-wrap"><nav class="console-top-nav">'+${JSON.stringify(nav)}+'</nav></div><input class="console-search" aria-label="Search"><button>Notification</button><button>Profile</button></div></div></header>'`);
      const baseline = await evaluate(measure);
      await evaluate(`import('/site-entry.mjs').then(m=>m.startDownloadEntries(document))`);
      await waitFor(`document.querySelector('.console-top-nav a[href="/downloads/"]')?.textContent===${JSON.stringify(label)}`);
      assert.deepEqual(await evaluate(`(()=>{const a=document.querySelector('.console-top-nav a[data-yitoken-download-nav-link]');return {target:a.target,rel:a.rel}})()`),{target:'_blank',rel:'noopener noreferrer'});
      const result = await evaluate(measure);
      const context = `${lang}/${width}`;
      assert.equal(result.header, 48, context);
      assert.equal(result.wrapper, baseline.wrapper, `${context}: AppHeader wrapper must not be raised to the PublicHeader 64px minimum`);
      assert.equal(result.navCenter, baseline.navCenter, context);
      assert.equal(result.searchCenter, baseline.searchCenter, context);
      assert.equal(result.publicBar, false, context); assert.equal(result.wrap, 'nowrap', context); assert.equal(result.profile, 'Profile', context);
      assert.deepEqual(result.original, baseline.original, `${context}: no original links removed`);
      assert.deepEqual(result.controls, baseline.controls, `${context}: original controls must not move or resize`);
      assert.equal(result.overflow, baseline.overflow, `${context}: no added page overflow`);
    }
  }
});
test('navigation opens isolated download tabs while the current website page stays open', async () => {
  for (const selector of ['header a[data-yitoken-download-nav-link]', '.overlay a[data-yitoken-download-nav-link]']) {
    await navigate(); await waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    const originalURL = await evaluate('location.href');
    const before = (await send('Target.getTargets')).targetInfos.filter(t=>t.type==='page');
    const prior = requests.filter(r=>r.path==='/downloads/' && r.document).length;
    await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)}).click()`, userGesture: true });
    let popup;
    const deadline = Date.now()+5000;
    while (Date.now()<deadline) {
      popup = (await send('Target.getTargets')).targetInfos.find(t=>t.type==='page' && !before.some(old=>old.targetId===t.targetId));
      if (popup) break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(popup, 'Navigation click must open a new tab');
    try {
      const {sessionId}=await send('Target.attachToTarget',{targetId:popup.targetId,flatten:true});
      await waitFor(`document.title==='Downloads destination' && location.href===${JSON.stringify(base+'/downloads/')}`,sessionId);
      assert.equal(await evaluate('window.opener===null',sessionId),true,'Download tab must not have an opener');
      assert.equal(await evaluate('location.href'),originalURL,'Current website must not navigate away');
      assert.equal(requests.filter(r=>r.path==='/downloads/' && r.document).length,prior+1);
      assert.equal((await send('Target.getTargets')).targetInfos.filter(t=>t.type==='page').length,before.length+1);
    } finally { await send('Target.closeTarget',{targetId:popup.targetId}); }
  }
});
test('non-navigation download anchors explicitly remain in this tab even with a default blank base target', async () => {
  await navigate(); await waitFor(`document.querySelector('header a[href="/downloads/"]')`);
  await evaluate(`const base=document.createElement('base');base.target='_blank';document.head.append(base)`);
  const targets = await evaluate(`[...document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('a[data-yitoken-download-link]')].map(a=>a.target)`);
  assert.ok(targets.length > 0); assert.ok(targets.every(target=>target==='_self'), 'Cards and footer keep explicit same-tab navigation');
  const before = (await send('Target.getTargets')).targetInfos.filter(target=>target.type==='page').length;
  await evaluate(`document.querySelector('.custom-home-content').shadowRoot.querySelector('[data-yitoken-download-card] a').click()`);
  await waitFor(`location.pathname==='/downloads/' && document.title==='Downloads destination'`);
  assert.equal((await send('Target.getTargets')).targetInfos.filter(target=>target.type==='page').length, before, 'Card click must not open another tab');
});
test('cleanup removes only injected entries and leaves original content available for rollback', async () => {
  await navigate(); await waitFor(`document.querySelector('header a[href="/downloads/"]')`);
  await evaluate(`globalThis.YitokenSiteDownloadEntries.stop()`);
  const result = await evaluate(`({nav:document.querySelectorAll('a[href="/downloads/"]').length,cards:document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-yitoken-download-card]').length,source:document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('a[href="/source/"]').length,studio:document.querySelector('.custom-home-content').shadowRoot.querySelectorAll('[data-existing-business]').length,attribution:document.body.innerText.includes('New API / QuantumNous')})`);
  assert.deepEqual(result, { nav: 0, cards: 0, source: 7, studio: 7, attribution: true });
});

const studioToolbar = `<div class="flex items-center gap-2 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800"><button class="rounded-md px-3 py-1.5 text-sm">图片</button><button class="rounded-md px-3 py-1.5 text-sm">视频</button><a class="ml-auto text-xs text-zinc-400 hover:text-lime-600" href="https://yitoken.com.cn/usage-logs/task" target="_blank" rel="noreferrer">任务日志 ↗</a></div>`;
const studioFixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font:16px Arial}.flex{display:flex}.h-screen{height:100vh}.w-80{width:320px}.shrink-0{flex-shrink:0}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}.min-w-0{min-width:0}.gap-2{gap:8px}.items-center{align-items:center}.border-b{border-bottom:1px solid #ddd}.px-6{padding-left:24px;padding-right:24px}.py-3{padding-top:12px;padding-bottom:12px}.px-3{padding-left:12px;padding-right:12px}.py-1\\.5{padding-top:6px;padding-bottom:6px}.text-sm{font-size:14px;line-height:20px}.text-xs{font-size:12px;line-height:16px}.ml-auto{margin-left:auto}.overflow-y-auto{overflow-y:auto}button{font:inherit;border:0;white-space:nowrap}a{white-space:nowrap}</style><div id="root"><div class="flex h-screen bg-white text-zinc-800"><aside class="flex w-80 shrink-0 flex-col"><h1>灵感创作</h1><label>令牌<input value="fixture-key-do-not-read"></label></aside><main class="flex min-w-0 flex-1 flex-col">${studioToolbar}<div class="flex-1 overflow-y-auto px-6 py-4">原结果保存提示</div><div class="border-t"><textarea>原提示词</textarea><button>生成</button></div></main></div></div><script>window.originalToolbar=${JSON.stringify(studioToolbar)};window.originalControls=[...document.querySelectorAll('aside,input,textarea,button')];window.originalClicks=0;document.querySelector('main button').onclick=()=>window.originalClicks++;Object.defineProperty(window,'localStorage',{get(){throw Error('must not read credentials')}});Object.defineProperty(document,'cookie',{get(){throw Error('must not read cookies')}});window.fetch=()=>{throw Error('must not send API/analytics')};window.XMLHttpRequest=function(){throw Error('must not send API/analytics')};</script><script type="module" src="/studio-guide.mjs"></script></html>`;
async function navigateStudio() {
  await send('Page.navigate', { url: base + '/studio' });
  await waitFor(`document.readyState==='complete' && !!document.querySelector('main')`);
}
const studioLanguages = {
  'zh-CN': '下载桌面版', 'zh-TW': '下載桌面版', en: 'Download desktop app',
  fr: 'Télécharger l’application', ru: 'Скачать приложение', ja: 'デスクトップ版をダウンロード', vi: 'Tải ứng dụng máy tính',
};
test('studio adds one compact native top link next to task logs without replacing business controls', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigateStudio(); await waitFor(`document.querySelector('[data-yitoken-studio-guide]')`);
  const result = await evaluate(`(()=>{const a=document.querySelector('[data-yitoken-studio-guide]');return {count:document.querySelectorAll('[data-yitoken-studio-guide]').length,href:a.getAttribute('href'),target:a.target,previous:a.previousElementSibling.textContent,toolbar:a.parentElement===document.querySelector('main').firstElementChild,controls:window.originalControls.every(n=>n.isConnected),parent:document.querySelector('main').children.length,linkHeight:a.getBoundingClientRect().height}})()`);
  assert.deepEqual({ ...result, linkHeight: undefined }, { count: 1, href: 'https://yitoken.com.cn/downloads/', target: '_top', previous: '任务日志 ↗', toolbar: true, controls: true, parent: 3, linkHeight: undefined });
  assert.ok(result.linkHeight <= 32);
  const appearance = await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('[data-yitoken-studio-guide]'));return {color:s.color,background:s.backgroundColor,border:s.borderTopWidth,height:s.height}})()`);
  assert.deepEqual(appearance, { color: 'rgb(63, 98, 18)', background: 'rgb(247, 254, 231)', border: '1px', height: '28px' });
  await evaluate(`document.documentElement.classList.add('dark')`);
  assert.deepEqual(await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('[data-yitoken-studio-guide]'));return [s.color,s.backgroundColor,s.borderTopColor]})()`), ['rgb(190, 242, 100)', 'rgb(26, 46, 5)', 'rgb(63, 98, 18)']);
  await evaluate(`document.documentElement.classList.remove('dark')`);
  await evaluate(`document.querySelector('main button').click()`);
  assert.equal(await evaluate(`window.originalClicks`), 1);
  assert.equal(networkRequests.filter(r=>r.documentURL?.includes('/studio') && !r.request.url.startsWith(base)).length, 0, 'Guide does not initiate external requests');
});
test('studio seven language labels follow document language, preserving toolbar/left form/prompt geometry', async () => {
  await navigateStudio(); await waitFor(`document.querySelector('[data-yitoken-studio-guide]')`);
  for (const width of [390, 768, 1280]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [lang, text] of Object.entries(studioLanguages)) {
      await evaluate(`document.documentElement.lang=${JSON.stringify(lang)}`);
      await waitFor(`document.querySelector('[data-yitoken-studio-guide]')?.textContent===${JSON.stringify(text)}`);
      const baseline = await evaluate(`(()=>{YitokenStudioGuide.stop();const nodes=[document.querySelector('aside'),document.querySelector('main').firstElementChild,document.querySelector('main').lastElementChild,...document.querySelectorAll('main button')];return {geometry:nodes.map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}),overflow:document.documentElement.scrollWidth}})()`);
      await evaluate(`import('/studio-guide.mjs').then(m=>m.startStudioGuide(document))`);
      await waitFor(`document.querySelector('[data-yitoken-studio-guide]')?.textContent===${JSON.stringify(text)}`);
      const result = await evaluate(`(()=>{const nodes=[document.querySelector('aside'),document.querySelector('main').firstElementChild,document.querySelector('main').lastElementChild,...document.querySelectorAll('main button')];const link=document.querySelector('[data-yitoken-studio-guide]');return {geometry:nodes.map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}),overflow:document.documentElement.scrollWidth,linkVisible:!!link.getBoundingClientRect().width}})()`);
      assert.deepEqual(result.geometry, baseline.geometry, `${lang}/${width}: original controls must not resize or move`);
      assert.equal(result.overflow, baseline.overflow, `${lang}/${width}: no additional page overflow`);
      if (width >= 768) assert.equal(result.linkVisible, true);
    }
  }
});
test('studio rerender/unmount/stop recover or remove only module-owned nodes and remain idempotent', async () => {
  await navigateStudio(); await waitFor(`document.querySelector('[data-yitoken-studio-guide]')`);
  await evaluate(`document.querySelector('main').firstElementChild.outerHTML=window.originalToolbar`);
  await waitFor(`document.querySelector('[data-yitoken-studio-guide]')`);
  await evaluate(`YitokenStudioGuide.refresh();YitokenStudioGuide.refresh();import('/studio-guide.mjs').then(m=>m.startStudioGuide(document))`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-yitoken-studio-guide]').length`), 1);
  await evaluate(`window.detached=document.querySelector('main');detached.remove()`);
  await waitFor(`!window.detached.querySelector('[data-yitoken-studio-guide]')`);
  await evaluate(`document.querySelector('#root>.flex').append(window.detached)`);
  await waitFor(`document.querySelector('[data-yitoken-studio-guide]')`);
  await evaluate(`YitokenStudioGuide.stop();YitokenStudioGuide.stop();document.documentElement.lang='en'`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-yitoken-studio-guide],style[data-yitoken-studio-guide-style]').length`), 0);
  assert.equal(await evaluate(`document.querySelector('main').firstElementChild.outerHTML===window.originalToolbar`), true);
  assert.equal(await evaluate(`YitokenStudioGuide.active`), false);
});
test('studio unknown markup fails closed rather than inserting beside arbitrary controls', async () => {
  await navigateStudio(); await waitFor(`document.querySelector('[data-yitoken-studio-guide]')`);
  await evaluate(`document.querySelector('main').firstElementChild.className='unrelated-toolbar'`);
  await waitFor(`!document.querySelector('[data-yitoken-studio-guide]')`);
  assert.equal(await evaluate(`document.querySelectorAll('main button').length`), 3);
});
test('cross-origin studio iframe normal click performs native same-tab top-level Document GET without credentials', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/studio-host' });
  let child;
  for (let attempt=0;attempt<100;attempt++) {
    child=(await send('Target.getTargets')).targetInfos.find(t=>t.type==='iframe' && t.url.includes('/studio'));
    if (child) break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(child, 'Real cross-origin child target must exist');
  assert.notEqual(new URL(child.url).origin, new URL(base).origin);
  const {sessionId}=await send('Target.attachToTarget',{targetId:child.targetId,flatten:true});
  await waitFor(`document.querySelector('[data-yitoken-studio-guide]')`, sessionId);
  const before=(await send('Target.getTargets')).targetInfos.filter(t=>t.type==='page').length;
  const prior=networkRequests.length;
  // Child DOM readiness alone does not establish a visibly painted OOPIF surface.
  // Capture the parent surface before the one trusted click; do not retry input.
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const position=await evaluate(`(()=>{const r=document.querySelector('[data-yitoken-studio-guide]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,sessionId);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...position,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...position,button:'left',clickCount:1});
  await waitFor(`location.href==='https://yitoken.com.cn/downloads/' && document.title==='Downloads destination'`);
  const navigation=networkRequests.slice(prior).filter(r=>r.type==='Document' && r.request.url==='https://yitoken.com.cn/downloads/');
  assert.equal(navigation.length,1); assert.equal(navigation[0].request.method,'GET');
  assert.equal(navigation[0].request.headers.Referer,undefined,'Native link must not disclose the studio URL');
  assert.equal((await send('Target.getTargets')).targetInfos.filter(t=>t.type==='page').length,before);
  assert.equal((await send('Page.getFrameTree')).frameTree.frame.url,'https://yitoken.com.cn/downloads/');
});
