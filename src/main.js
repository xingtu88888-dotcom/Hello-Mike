console.log("===== MY MAIN JS LOADED =====");
const { app, BrowserWindow, ipcMain, session, Menu, clipboard, nativeImage, safeStorage, powerMonitor, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const netNode = require('net');
const { URL, pathToFileURL } = require('url');
const { SocksClient } = require('socks');
const hmClipboard = require('./clipboard-bridge').createClipboardBridge(require('electron'));
function hmClipboardMenuTask(task) {
  Promise.resolve().then(task).catch(() => {
    dialog.showErrorBox('Hello Mike', '\u526a\u8d34\u677f\u64cd\u4f5c\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002');
  });
}
function hmTrustedLocalClipboard(event) {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!wc || event.sender !== wc || event.senderFrame !== wc.mainFrame ||
      event.senderFrame?.url !== pathToFileURL(path.join(__dirname,'index.html')).href) {
    throw new Error('CLIPBOARD_IPC_FORBIDDEN');
  }
}


// Pin userData to a version-independent location so installer upgrades keep profiles and Chromium partitions.
const STABLE_USER_DATA = path.join(app.getPath('appData'), 'Hello Mike');
try { app.setPath('userData', STABLE_USER_DATA); } catch {}

const ROOT_DATA = () => app.getPath('userData');
const USERS_FILE = () => path.join(ROOT_DATA(), 'users.json');
let activeLocalUser = null;
function userDataRoot() {
  if (!activeLocalUser) return ROOT_DATA();
  // The first migrated owner keeps the legacy root so existing WhatsApp partitions stay logged in.
  if (activeLocalUser.legacyOwner) return ROOT_DATA();
  return path.join(ROOT_DATA(), 'users', activeLocalUser.id);
}
const DATA_FILE = () => path.join(userDataRoot(), 'profiles.json');
const NOTES_FILE = () => path.join(userDataRoot(), 'chat-notes-backup.json');
const SETTINGS_FILE = () => path.join(userDataRoot(), 'settings.json');
const SECURITY_FILE = () => path.join(userDataRoot(), 'security.json');

const SCHEDULED_TASKS_FILE = () => path.join(userDataRoot(), 'scheduled-tasks.json');
const SCHEDULED_MEDIA_DIR = () => path.join(userDataRoot(), 'scheduled-media');
let allowScheduledWindowClose = false;

function loadScheduledTasksRaw() {
  const v = readJsonFile(SCHEDULED_TASKS_FILE(), []);
  return Array.isArray(v) ? v : [];
}
function saveScheduledTasksRaw(tasks) {
  writeJsonFile(SCHEDULED_TASKS_FILE(), Array.isArray(tasks) ? tasks : []);
}
function deleteScheduledMedia(taskId) {
  try {
    fs.rmSync(path.join(SCHEDULED_MEDIA_DIR(), String(taskId || '')), {
      recursive: true,
      force: true
    });
  } catch {}
}
function scheduledImageMime(ext) {
  return ({
    '.png':'image/png',
    '.jpg':'image/jpeg',
    '.jpeg':'image/jpeg',
    '.webp':'image/webp',
    '.gif':'image/gif'
  })[String(ext || '').toLowerCase()] || 'application/octet-stream';
}
function removeScheduledTask(taskId) {
  const id=String(taskId||'');
  const tasks=loadScheduledTasksRaw();
  const found=tasks.find(x=>String(x?.id||'')===id);
  const next=tasks.filter(x=>String(x?.id||'')!==id);
  saveScheduledTasksRaw(next);
  if(found)deleteScheduledMedia(id);
  return found || null;
}
function countOpenScheduledTasks() {
  if(!activeLocalUser)return 0;
  return loadScheduledTasksRaw().filter(x=>
    ['pending','missed','sending'].includes(String(x?.status||'pending'))
  ).length;
}
let mainWindow;
// HM_AUTO_UPDATE_0130: preserve all existing profile and translation paths.
let hmUpdateInstalling = false;
let hmTranslationJobs = 0;
let hmUpdateController = null;
const hmIsPrimaryInstance = app.requestSingleInstanceLock();
if (!hmIsPrimaryInstance) app.quit();
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  }
});
const windows = new Map();
const proxyByWebContentsId = new Map();
const proxyBySession = new WeakMap();
const guardByWebContentsId = new Map();
const proxyBridges = new Map();
const CJK_RE_SOURCE = '[\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF]';
const IP_ENDPOINT = 'https://api.ipify.org?format=json';
const GEO_ENDPOINT = ip => `https://ipwho.is/${encodeURIComponent(ip)}`;


function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}
function loadUsersRaw() {
  const data = readJsonFile(USERS_FILE(), []);
  return Array.isArray(data) ? data : [];
}
function saveUsersRaw(users) { writeJsonFile(USERS_FILE(), users); }
function publicUser(u) { return u ? { id:u.id, username:u.username, role:u.role||'member', createdAt:u.createdAt||null, legacyOwner:Boolean(u.legacyOwner) } : null; }
function normalizeUsername(v) { return String(v||'').trim(); }
function usernameKey(v) { return normalizeUsername(v).toLocaleLowerCase(); }
function derivePassword(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}
function validatePassword(password) {
  const v=String(password||'');
  if (v.length < 8) throw new Error('密码至少需要 8 位。');
  if (v.length > 128) throw new Error('密码过长。');
}
function generateRecoveryKey() {
  // 20 random bytes, grouped for easier manual storage. The plain key is shown only once.
  const raw=crypto.randomBytes(20).toString('hex').toUpperCase();
  return `HM-${raw.match(/.{1,8}/g).join('-')}`;
}
function normalizeRecoveryKey(v) { return String(v||'').trim().toUpperCase().replace(/\s+/g,''); }
function deriveRecoveryKey(key, saltHex) {
  return crypto.scryptSync(normalizeRecoveryKey(key), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}
function setRecoveryKeyOnUser(user, plainKey) {
  const recoverySalt=crypto.randomBytes(16).toString('hex');
  user.recoverySalt=recoverySalt;
  user.recoveryHash=deriveRecoveryKey(plainKey,recoverySalt);
  user.recoveryUpdatedAt=new Date().toISOString();
}
function verifyRecoveryKey(user, plainKey) {
  if(!user?.recoverySalt || !user?.recoveryHash) return false;
  const actual=deriveRecoveryKey(plainKey,user.recoverySalt);
  const a=Buffer.from(actual,'hex'), b=Buffer.from(user.recoveryHash,'hex');
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function hasLegacyData() {
  return ['profiles.json','chat-notes-backup.json','settings.json'].some(n => fs.existsSync(path.join(ROOT_DATA(), n)));
}
function localAuthState() {
  const users=loadUsersRaw();
  return { needsSetup: users.length===0, loggedIn:Boolean(activeLocalUser), user:publicUser(activeLocalUser), users: activeLocalUser?.role==='admin' ? users.map(publicUser) : [] };
}
function rememberedLogin() {
  const s=readJsonFile(path.join(ROOT_DATA(),'login-preferences.json'),{});
  let password='';
  if(s.remember && s.passwordEnc){ try{password=decryptSecret(s.passwordEnc);}catch{} }
  return {remember:Boolean(s.remember),username:String(s.username||''),password};
}
function saveRememberedLogin(username,password,remember){
  const f=path.join(ROOT_DATA(),'login-preferences.json');
  if(!remember){ writeJsonFile(f,{remember:false,username:String(username||'')}); return; }
  writeJsonFile(f,{remember:true,username:String(username||''),passwordEnc:encryptSecret(String(password||''))});
}

function rootOwnsProfile(profileId) {
  try {
    const f=path.join(ROOT_DATA(),'profiles.json');
    const raw=readJsonFile(f,[]);
    const list=Array.isArray(raw)?raw:(Array.isArray(raw?.profiles)?raw.profiles:[]);
    return list.some(p=>String(p?.id||'')===String(profileId||''));
  } catch { return false; }
}
function partitionForProfile(profileId) {
  // Preserve the exact pre-v0.12 Chromium partition for migrated/root profiles.
  // This prevents an auth-user migration from silently creating a fresh WhatsApp session.
  if (!activeLocalUser || activeLocalUser.legacyOwner || (activeLocalUser.role==='admin' && rootOwnsProfile(profileId))) {
    return `persist:profile-${profileId}`;
  }
  return `persist:user-${activeLocalUser.id}-profile-${profileId}`;
}
function lineRootForProfile(profileId) {
  if (!activeLocalUser || activeLocalUser.legacyOwner) return path.join(ROOT_DATA(), 'line-chrome', profileId);
  return path.join(ROOT_DATA(), 'users', activeLocalUser.id, 'line-chrome', profileId);
}
function loadSecurityRaw() {
  const data = readJsonFile(SECURITY_FILE(), {});
  return data && typeof data==='object' && !Array.isArray(data) ? data : {};
}
function saveSecurityRaw(data) { writeJsonFile(SECURITY_FILE(), data || {}); }
function currentUserRequired() {
  if (!activeLocalUser) throw new Error('请先登录 Hello Mike。');
  return activeLocalUser;
}

function loadSettingsRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function saveSettingsRaw(data) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  const tmp = `${SETTINGS_FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data || {}, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE());
  try { fs.chmodSync(SETTINGS_FILE(), 0o600); } catch {}
}

function getOpenAIKey() {
  const settings = loadSettingsRaw();
  if (!settings.openaiApiKeyEnc) return '';
  try { return decryptSecret(settings.openaiApiKeyEnc); }
  catch { return ''; }
}

function sanitizeSettings() {
  const s = loadSettingsRaw();
  return {
    openaiConfigured: Boolean(s.openaiApiKeyEnc),
    translationModel: s.translationModel || 'gpt-4o'
  };
}

function loadNotesBackupRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(NOTES_FILE(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function saveNotesBackupRaw(data) {
  fs.mkdirSync(path.dirname(NOTES_FILE()), { recursive: true });
  const tmp = `${NOTES_FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data || {}, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, NOTES_FILE());
  try { fs.chmodSync(NOTES_FILE(), 0o600); } catch {}
}

function loadProfilesRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveProfilesRaw(profiles) {
  fs.mkdirSync(path.dirname(DATA_FILE()), { recursive: true });
  const tmp = `${DATA_FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(profiles, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE());
  try { fs.chmodSync(DATA_FILE(), 0o600); } catch {}
}

function encryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable(); }
  catch { return false; }
}

function encryptSecret(value) {
  if (!value) return null;
  if (!encryptionAvailable()) throw new Error('系统安全存储当前不可用，无法安全保存代理密码。');
  return safeStorage.encryptString(String(value)).toString('base64');
}

function decryptSecret(ciphertext) {
  if (!ciphertext) return '';
  if (!encryptionAvailable()) throw new Error('系统安全存储当前不可用，无法读取代理密码。');
  return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
}

function migratePlaintextPasswords() {
  const profiles = loadProfilesRaw();
  let changed = false;
  for (const p of profiles) {
    if (!p.proxy) continue;
    if (typeof p.proxy.password === 'string' && p.proxy.password.length > 0) {
      if (!encryptionAvailable()) continue;
      p.proxy.passwordEnc = encryptSecret(p.proxy.password);
      delete p.proxy.password;
      changed = true;
    } else if (Object.prototype.hasOwnProperty.call(p.proxy, 'password')) {
      delete p.proxy.password;
      changed = true;
    }
  }
  if (changed) saveProfilesRaw(profiles);
}

function sanitizeProfile(profile) {
  const p = JSON.parse(JSON.stringify(profile));
  if (!p.proxy) p.proxy = { type: 'none' };
  p.proxy.hasPassword = Boolean(p.proxy.passwordEnc);
  delete p.proxy.passwordEnc;
  delete p.proxy.password;
  p.translation = p.translation || { source: 'AUTO', target: 'ZH' };
  p.guard = p.guard || { blockChinese: false };
  return p;
}

function loadProfileById(id) {
  return loadProfilesRaw().find(p => p.id === id);
}

function profileWithDecryptedSecret(profile) {
  const p = JSON.parse(JSON.stringify(profile));
  if (p.proxy) {
    p.proxy.password = p.proxy.passwordEnc ? decryptSecret(p.proxy.passwordEnc) : '';
    delete p.proxy.passwordEnc;
  }
  return p;
}

function proxyRule(p) {
  if (!p || p.type === 'none' || !p.host || !p.port) return null;
  return `${p.type}://${p.host}:${p.port}`;
}

function proxySignature(p) {
  if (!p || p.type === 'none') return 'none';
  return [p.type, p.host, p.port, p.username || '', p.password || ''].join('|');
}

async function closeProxyBridge(id) {
  const old = proxyBridges.get(id);
  if (!old) return;
  proxyBridges.delete(id);
  await new Promise(resolve => {
    try { old.server.close(() => resolve()); }
    catch { resolve(); }
    setTimeout(resolve, 250);
  });
}

async function createAuthenticatedSocksBridge(profile) {
  const key = profile.id || `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sig = proxySignature(profile.proxy);
  const existing = proxyBridges.get(key);
  if (existing && existing.signature === sig) return existing;
  if (existing) await closeProxyBridge(key);

  const upstream = profile.proxy;
  const connectViaSocks = async (host, port) => {
    const result = await SocksClient.createConnection({
      proxy: {
        host: upstream.host,
        port: Number(upstream.port),
        type: 5,
        userId: upstream.username || undefined,
        password: upstream.password || undefined
      },
      command: 'connect',
      destination: { host, port: Number(port) },
      timeout: 12000
    });
    return result.socket;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url);
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      const socket = await connectViaSocks(u.hostname, port);
      const headers = { ...req.headers, host: u.host, connection: 'close', 'proxy-connection': undefined };
      const lines = [`${req.method} ${u.pathname || '/'}${u.search || ''} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) if (v !== undefined) lines.push(`${k}: ${v}`);
      lines.push('', '');
      socket.write(lines.join('\r\n'));
      req.pipe(socket);
      let headDone = false;
      socket.on('data', chunk => {
        if (!headDone) { headDone = true; res.socket?.write(chunk); }
        else res.socket?.write(chunk);
      });
      socket.on('end', () => res.socket?.end());
      socket.on('error', () => { try { res.destroy(); } catch {} });
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Hello Mike proxy bridge error: ${e.message}`);
    }
  });

  server.on('connect', async (req, clientSocket, head) => {
    const [host, portText] = String(req.url || '').split(':');
    const port = Number(portText || 443);
    try {
      const remote = await connectViaSocks(host, port);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Hello-Mike\r\n\r\n');
      if (head?.length) remote.write(head);
      clientSocket.pipe(remote);
      remote.pipe(clientSocket);
      const destroy = () => { try { remote.destroy(); } catch {}; try { clientSocket.destroy(); } catch {} };
      remote.on('error', destroy); clientSocket.on('error', destroy);
    } catch (e) {
      try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch {}
      try { clientSocket.destroy(); } catch {}
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = server.address().port;
  const bridge = { server, port, signature: sig, rule: `http://127.0.0.1:${port}`, upstreamRule: proxyRule(upstream) };
  proxyBridges.set(key, bridge);
  return bridge;
}

async function proxyRuntime(profile) {
  const p = profile?.proxy;
  if (!p || p.type === 'none' || !p.host || !p.port) return { rule: null, displayRoute: 'DIRECT', bridged: false };
  if (p.type === 'socks5' && (p.username || p.password)) {
    const bridge = await createAuthenticatedSocksBridge(profile);
    return { rule: bridge.rule, displayRoute: `${proxyRule(p)} · 认证桥接`, bridged: true };
  }
  return { rule: proxyRule(p), displayRoute: proxyRule(p), bridged: false };
}

function getChromePath() {
  const candidates = process.platform === 'win32' ? [
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(p => p && fs.existsSync(p));
}

async function openInternalProfile(profile) {
  if (windows.has(profile.id)) { windows.get(profile.id).focus(); return { ok: true, reused: true }; }
  const ses = session.fromPartition(partitionForProfile(profile.id));
  const runtime = await proxyRuntime(profile);
  const rule = runtime.rule;
  await ses.setProxy(rule ? { proxyRules: rule } : { mode: 'direct' });
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    title: `${profile.name} - Hello Mike`,
    backgroundColor: '#08172a',
    webPreferences: { session: ses, contextIsolation: true, sandbox: true }
  });
  proxyByWebContentsId.set(win.webContents.id, profile.proxy || { type: 'none' });
  win.on('closed', () => {
    windows.delete(profile.id);
    proxyByWebContentsId.delete(win.webContents.id);
    guardByWebContentsId.delete(win.webContents.id);
  });
  windows.set(profile.id, win);
  guardByWebContentsId.set(win.webContents.id, profile.guard || { blockChinese: false });
  const target = profile.service === 'whatsapp' ? 'https://web.whatsapp.com/' : (profile.url || 'https://example.com');

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#08172a;color:#dcecff;font:16px Segoe UI,Microsoft YaHei,sans-serif;display:grid;place-items:center;height:100vh}.box{text-align:center}.spin{width:38px;height:38px;border:4px solid #234a72;border-top-color:#3ba7ff;border-radius:50%;margin:0 auto 18px;animation:r 1s linear infinite}@keyframes r{to{transform:rotate(360deg)}}</style><div class="box"><div class="spin"></div><b>正在连接 ${profile.service === 'whatsapp' ? 'WhatsApp Web' : '目标网页'}…</b><div style="margin-top:9px;color:#7fa2c3">网络：${rule || 'DIRECT'}</div></div>`)}`);

  try {
    await loadWithTimeout(win, target, 20000);
    if (profile.service === 'whatsapp') {
      await new Promise(r => setTimeout(r, 2200));
      const shape = await win.webContents.executeJavaScript(`({url:location.href, html:(document.documentElement?.innerHTML||'').length})`);
      if (!String(shape.url || '').startsWith('https://web.whatsapp.com/') || Number(shape.html || 0) < 500) {
        const e = new Error('WhatsApp Web 页面为空白，可能是代理不支持 HTTPS、认证失败或线路被目标站点拒绝。');
        e.code = 'BLANK_PAGE';
        throw e;
      }
    }
  } catch (err) {
    const f = friendlyNetworkError(err, profile);
    await loadErrorPage(win, 'WhatsApp 连接失败', f.reason, `${f.route}\n${f.technical}`);
    return { ok: false, reason: f.reason, technical: f.technical, route: f.route };
  }

  // Message Guard: blocks Enter/click sends when a WhatsApp composer contains Han characters.
  // This is a local outbound safety guard; it does not read or upload conversation content.
  if (profile.service === 'whatsapp' && profile.guard?.blockChinese) {
    try {
      await win.webContents.executeJavaScript(`(() => {
        if (window.__mcdChineseGuardInstalled) return true;
        window.__mcdChineseGuardInstalled = true;
        const han = new RegExp(${JSON.stringify(CJK_RE_SOURCE)}, 'u');
        const composer = () => document.querySelector('footer [contenteditable="true"][role="textbox"]') || document.querySelector('footer [contenteditable="true"]');
        const text = el => (el?.innerText || el?.textContent || '').trim();
        const warn = () => {
          let n = document.getElementById('__mcd_guard_notice');
          if (!n) {
            n = document.createElement('div'); n.id='__mcd_guard_notice';
            Object.assign(n.style,{position:'fixed',left:'50%',bottom:'92px',transform:'translateX(-50%)',zIndex:'2147483647',background:'#b42318',color:'#fff',padding:'10px 16px',borderRadius:'9px',font:'600 14px system-ui',boxShadow:'0 6px 24px #0005'});
            document.body.appendChild(n);
          }
          n.textContent='已阻止发送：消息中包含中文，请翻译后再发送。'; n.style.display='block';
          clearTimeout(window.__mcdGuardTimer); window.__mcdGuardTimer=setTimeout(()=>n.style.display='none',2600);
        };
        const shouldBlock=()=>han.test(text(composer()));
        document.addEventListener('keydown',e=>{ if(e.key==='Enter' && !e.shiftKey && shouldBlock()){ e.preventDefault(); e.stopImmediatePropagation(); warn(); } },true);
        document.addEventListener('click',e=>{ const b=e.target?.closest?.('button,[role="button"]'); if(!b)return; const a=(b.getAttribute('aria-label')||b.getAttribute('data-tab')||'').toLowerCase(); const sendish=a.includes('send') || !!b.querySelector('[data-icon="send"]'); if(sendish && shouldBlock()){ e.preventDefault(); e.stopImmediatePropagation(); warn(); } },true);
        return true;
      })()`);
    } catch {}
  }

  win.webContents.on('context-menu', (_e, params) => {
    const selected = (params.selectionText || '').trim();
    const items = [];
    if (selected) items.push({ label: '复制所选文字', click: () => hmClipboardMenuTask(() => hmClipboard.writeText(selected)) });
    if (selected) items.push({
      label: '复制并打开翻译器',
      click: () => hmClipboardMenuTask(async () => {
        await hmClipboard.writeText(selected);
        mainWindow?.webContents.send('translator-fill', selected);
        mainWindow?.show();
      })
    });
    items.push({ type: 'separator' }, { label: '刷新', click: () => win.reload() });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  return { ok: true };
}

async function openLineChrome(profile) {
  const chrome = getChromePath();
  if (!chrome) throw new Error('未找到 Google Chrome。请先安装 Chrome。');
  const dir = lineRootForProfile(profile.id);
  fs.mkdirSync(dir, { recursive: true });
  const args = [`--user-data-dir=${dir}`, '--new-window', 'https://www.line.me/en/'];
  const runtime = await proxyRuntime(profile);
  const rule = runtime.rule;
  if (rule) args.unshift(`--proxy-server=${rule}`);
  // Chrome will request authenticated-proxy credentials itself when needed.
  // Passwords are never written into the Chrome command line.
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();
}


async function fetchJsonViaSession(ses, url, proxy) {
  return new Promise((resolve, reject) => {
    const req = ses.netRequest ? null : null;
    const { net } = require('electron');
    const request = net.request({ url, session: ses, method: 'GET' });
    const chunks = [];
    const timeout = setTimeout(() => { try { request.abort(); } catch {} reject(new Error('IP 检测超时')); }, 10000);
    const wcId = -Math.floor(Math.random() * 1000000000) - 1;
    // net.request proxy auth is handled through app login only when associated with a webContents;
    // unauthenticated proxies work directly. Authenticated proxy verification falls back to the profile window.
    request.on('response', response => {
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        clearTimeout(timeout);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('IP 服务返回了无效数据')); }
      });
    });
    request.on('error', err => { clearTimeout(timeout); reject(err); });
    request.end();
  });
}

async function checkProfileIp(profile) {
  const ses = session.fromPartition(partitionForProfile(`ipcheck-${profile.id}`));
  const runtime = await proxyRuntime(profile);
  const rule = runtime.rule;
  await ses.setProxy(rule ? { proxyRules: rule } : { mode: 'direct' });
  proxyBySession.set(ses, profile.proxy || { type: 'none' });
  try { await ses.cookies.flushStore(); await ses.flushStorageData(); } catch {}
  const data = await fetchJsonViaSession(ses, IP_ENDPOINT, profile.proxy);
  const ip = data.ip || '未知';
  let geo = {};
  try {
    const r = await fetch(GEO_ENDPOINT(ip), { signal: AbortSignal.timeout(7000) });
    if (r.ok) { const j = await r.json(); if (j.success !== false) geo = { country: j.country || '', countryCode: j.country_code || '', city: j.city || '', isp: j.connection?.isp || '' }; }
  } catch {}
  return { ip, route: runtime.displayRoute || rule || 'direct', ...geo, checkedAt: Date.now() };
}



function friendlyNetworkError(err, profile) {
  const raw = String(err?.message || err || '未知网络错误');
  const code = String(err?.code || err?.errno || '');
  const text = `${code} ${raw}`;
  let reason = '无法通过当前网络连接到目标服务。';
  if (/SOCKS_CONNECTION_FAILED|-120/i.test(text)) reason = 'SOCKS5 代理连接失败。请确认代理类型、主机、端口以及代理服务器是否在线。';
  else if (/PROXY_CONNECTION_FAILED|-130/i.test(text)) reason = '无法连接到代理服务器。请检查 IP、端口或代理服务是否已失效。';
  else if (/TUNNEL_CONNECTION_FAILED|-111/i.test(text)) reason = 'HTTP/HTTPS 代理隧道建立失败。代理可能不支持 HTTPS CONNECT，或需要正确的用户名和密码。';
  else if (/CONNECTION_REFUSED|-102/i.test(text)) reason = '目标连接被拒绝。代理端口可能错误或服务器没有提供代理服务。';
  else if (/TIMED_OUT|-7/i.test(text)) reason = '连接超时。代理线路可能不可用或延迟过高。';
  else if (/NAME_NOT_RESOLVED|-105/i.test(text)) reason = '域名解析失败。请检查代理的 DNS 能力或网络设置。';
  else if (/AUTH|407/i.test(text)) reason = '代理认证失败。请检查用户名和密码。';
  const route = proxyRule(profile?.proxy) || 'DIRECT';
  return { reason, route, technical: raw };
}

function errorPageHtml(title, message, details = '') {
  const esc = v => String(v || '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  body{margin:0;background:#08172a;color:#e8f1ff;font-family:Segoe UI,Microsoft YaHei,sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(720px,86vw);background:#102640;border:1px solid #29496a;border-radius:18px;padding:30px;box-shadow:0 25px 70px #0007}h1{font-size:24px;margin:0 0 14px}.msg{font-size:16px;line-height:1.8;color:#d7e6f7}.details{margin-top:16px;padding:14px;border-radius:12px;background:#091b30;color:#94b3cf;font:13px/1.6 Consolas,monospace;word-break:break-all}.tip{margin-top:18px;color:#74c8ff}.btn{margin-top:20px;display:inline-block;padding:10px 18px;border-radius:10px;background:#2678ff;color:#fff;font-weight:700}</style></head><body><div class="card"><h1>${esc(title)}</h1><div class="msg">${esc(message)}</div>${details?`<div class="details">${esc(details)}</div>`:''}<div class="tip">请返回 Hello Mike 的“代理 / IP”页面先运行网络诊断，再重新打开账号。</div><div class="btn" onclick="location.reload()">重新尝试</div></div></body></html>`;
}

async function loadErrorPage(win, title, message, details) {
  if (!win || win.isDestroyed()) return;
  const html = errorPageHtml(title, message, details);
  try { await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`); } catch {}
}

function loadWithTimeout(win, url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      win.webContents.removeListener('did-fail-load', fail);
      win.webContents.removeListener('did-finish-load', finish);
    };
    const settle = (fn, value) => { if (done) return; done = true; cleanup(); fn(value); };
    const fail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      const e = new Error(`${errorDescription || '加载失败'} (${errorCode}) loading '${validatedURL || url}'`);
      e.code = errorCode;
      settle(reject, e);
    };
    const finish = () => settle(resolve, true);
    const timer = setTimeout(() => {
      const e = new Error(`连接超时 (${timeoutMs} ms): ${url}`);
      e.code = 'TIMEOUT';
      try { win.webContents.stop(); } catch {}
      settle(reject, e);
    }, timeoutMs);
    win.webContents.on('did-fail-load', fail);
    win.webContents.on('did-finish-load', finish);
    win.loadURL(url).catch(err => settle(reject, err));
  });
}

async function diagnoseProxy(profile) {
  const started = Date.now();
  const runtime = await proxyRuntime(profile);
  const rule = runtime.rule;
  if (!rule) return { ok: true, direct: true, route: 'DIRECT', latency: Date.now() - started, message: '当前账号使用直连网络。' };
  const ses = session.fromPartition(`persist:diag-${profile.id || Date.now()}-${Math.random().toString(36).slice(2)}`);
  await ses.setProxy({ proxyRules: rule });
  proxyBySession.set(ses, profile.proxy || { type: 'none' });
  const win = new BrowserWindow({ show: false, width: 700, height: 520, webPreferences: { session: ses, contextIsolation: true, sandbox: true } });
  proxyByWebContentsId.set(win.webContents.id, profile.proxy || { type: 'none' });
  const result = { ok: false, route: runtime.displayRoute || rule, proxyReachable: false, httpsOk: false, whatsappOk: false, ip: '', latency: 0, bridged: runtime.bridged };
  try {
    await loadWithTimeout(win, IP_ENDPOINT, 10000);
    result.proxyReachable = true;
    result.httpsOk = true;
    try {
      const body = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
      const parsed = JSON.parse(String(body || '{}'));
      result.ip = parsed.ip || '';
    } catch {}
    await loadWithTimeout(win, 'https://web.whatsapp.com/', 18000);
    await new Promise(r => setTimeout(r, 1800));
    const shape = await win.webContents.executeJavaScript(`({url:location.href, html:(document.documentElement?.innerHTML||'').length, text:(document.body?.innerText||'').slice(0,200)})`);
    if (!String(shape.url || '').startsWith('https://web.whatsapp.com/') || Number(shape.html || 0) < 500) {
      const e = new Error('WhatsApp Web 返回了空白或异常页面');
      e.code = 'BLANK_PAGE';
      throw e;
    }
    result.whatsappOk = true;
    result.ok = true;
    result.message = '代理可用，HTTPS 与 WhatsApp Web 均可访问。';
  } catch (err) {
    const f = friendlyNetworkError(err, profile);
    result.reason = f.reason;
    result.technical = f.technical;
    result.message = f.reason;
  } finally {
    result.latency = Date.now() - started;
    proxyByWebContentsId.delete(win.webContents.id);
    try { win.destroy(); } catch {}
  }
  if (String(profile.id || '').startsWith('temp-')) await closeProxyBridge(profile.id);
  if (result.ip) {
    try {
      const r = await fetch(GEO_ENDPOINT(result.ip), { signal: AbortSignal.timeout(5000) });
      if (r.ok) { const j = await r.json(); if (j.success !== false) Object.assign(result, { country: j.country || '', countryCode: j.country_code || '', city: j.city || '', isp: j.connection?.isp || '' }); }
    } catch {}
  }
  return result;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 680,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });
  // Keep the privileged host page local. WhatsApp guests retain their own navigation.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== pathToFileURL(path.join(__dirname,'index.html')).href) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', event => {
    if(allowScheduledWindowClose)return;

    let count=0;
    try{count=countOpenScheduledTasks();}catch{}

    if(!count)return;

    event.preventDefault();

    const choice=dialog.showMessageBoxSync(mainWindow,{
      type:'warning',
      title:'Hello Mike',
      message:`还有 ${count} 个定时发送任务尚未结束`,
      detail:'关闭 Hello Mike 后，这些任务将无法按时发送。任务本身会保留，下次打开时仍可查看。',
      buttons:['继续运行','仍然退出'],
      defaultId:0,
      cancelId:0,
      noLink:true
    });

    if(choice===1){
      allowScheduledWindowClose=true;
      setImmediate(()=>{try{mainWindow?.close();}catch{}});
    }
  });
}

app.on('login', (event, webContents, _details, authInfo, callback) => {
  if (!authInfo.isProxy) return;
  const p = proxyByWebContentsId.get(webContents.id) || proxyBySession.get(webContents.session);
  if (p?.username) {
    event.preventDefault();
    callback(p.username, p.password || '');
  }
});

async function flushPersistentSessions() {
  if (!activeLocalUser) return;
  const profiles = loadProfilesRaw();
  await Promise.allSettled(profiles.map(async p => {
    if (!p?.id || p.service === 'line') return;
    const ses = session.fromPartition(partitionForProfile(p.id));
    try { await ses.cookies.flushStore(); } catch {}
    try { await ses.flushStorageData(); } catch {}
  }));
}

let persistentFlushTimer=null;
app.whenReady().then(() => {
  if (!hmIsPrimaryInstance) return;
  createMainWindow();
  hmUpdateController = require('./updater').createUpdateController({
    app, ipcMain, dialog, getMainWindow: () => mainWindow,
    config: require('./update-config.json'),
    getBusyReason: () => hmTranslationJobs > 0 ? 'UPDATE_TRANSLATIONS_RUNNING' : '',
    setInstallGate: value => { hmUpdateInstalling = Boolean(value); },
    prepareForInstall: () => require('./update-data').prepareUpdateData({
      app,
      sessions: [session.defaultSession, ...loadProfilesRaw().filter(p => p.service !== 'line').map(p => session.fromPartition(partitionForProfile(p.id))) ]
    })
  });
  // Periodically persist cookies + IndexedDB/LocalStorage metadata so a Windows restart or hard close
  // is less likely to lose a linked-device session. This never clears storage.
  persistentFlushTimer=setInterval(()=>{flushPersistentSessions().catch(()=>{});},20000);
  persistentFlushTimer.unref?.();
});
app.on('before-quit', () => { for (const id of [...proxyBridges.keys()]) closeProxyBridge(id); });
app.on('before-quit', () => { flushPersistentSessions().catch(()=>{}); });
app.on('will-quit', () => { flushPersistentSessions().catch(()=>{}); });
app.whenReady().then(() => {
  try { powerMonitor.on('suspend', () => { flushPersistentSessions().catch(()=>{}); }); } catch {}
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (hmIsPrimaryInstance && BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

ipcMain.handle('security:status', () => ({
  encryptionAvailable: encryptionAvailable(),
  backend: process.platform === 'win32' ? 'Windows DPAPI via Electron safeStorage' :
    process.platform === 'darwin' ? 'macOS Keychain via Electron safeStorage' :
      'Linux secret store via Electron safeStorage',
  dataFile: activeLocalUser ? DATA_FILE() : null,
  auth: localAuthState()
}));

ipcMain.handle('auth:state', () => localAuthState());
ipcMain.handle('auth:remembered', () => rememberedLogin());
ipcMain.handle('auth:register', async (_e, payload) => {
  const username=normalizeUsername(payload?.username); const password=String(payload?.password||'');
  if (username.length < 2 || username.length > 40) throw new Error('用户名需要 2–40 个字符。');
  validatePassword(password);
  const users=loadUsersRaw();
  if (users.some(u=>usernameKey(u.username)===usernameKey(username))) throw new Error('该用户名已存在。');
  const salt=crypto.randomBytes(16).toString('hex');
  const first=users.length===0;
  const recoveryKey=generateRecoveryKey();
  const u={id:crypto.randomUUID(),username,role:first?'admin':'member',salt,passwordHash:derivePassword(password,salt),createdAt:new Date().toISOString(),legacyOwner:first&&hasLegacyData()};
  setRecoveryKeyOnUser(u,recoveryKey);
  users.push(u); saveUsersRaw(users); activeLocalUser=u;
  if (!u.legacyOwner) fs.mkdirSync(userDataRoot(), { recursive:true });
  migratePlaintextPasswords();
  return {...localAuthState(), recoveryKey};
});
ipcMain.handle('auth:create-user', async (_e, payload) => {
  currentUserRequired(); if(activeLocalUser.role!=='admin') throw new Error('只有管理员可以创建本地用户。');
  const username=normalizeUsername(payload?.username); const password=String(payload?.password||'');
  if (username.length < 2 || username.length > 40) throw new Error('用户名需要 2–40 个字符。');
  validatePassword(password);
  const users=loadUsersRaw(); if(users.some(u=>usernameKey(u.username)===usernameKey(username))) throw new Error('该用户名已存在。');
  const salt=crypto.randomBytes(16).toString('hex');
  const recoveryKey=generateRecoveryKey();
  const u={id:crypto.randomUUID(),username,role:'member',salt,passwordHash:derivePassword(password,salt),createdAt:new Date().toISOString(),legacyOwner:false};
  setRecoveryKeyOnUser(u,recoveryKey);
  users.push(u); saveUsersRaw(users); fs.mkdirSync(path.join(ROOT_DATA(),'users',u.id),{recursive:true});
  return {users:users.map(publicUser), recoveryKey, user:publicUser(u)};
});
ipcMain.handle('auth:login', async (_e, payload) => {
  const username=normalizeUsername(payload?.username), password=String(payload?.password||'');
  const u=loadUsersRaw().find(x=>usernameKey(x.username)===usernameKey(username));
  if (!u || !u.salt || !u.passwordHash) throw new Error('用户名或密码不正确。');
  const actual=derivePassword(password,u.salt);
  const a=Buffer.from(actual,'hex'), b=Buffer.from(u.passwordHash,'hex');
  if (a.length!==b.length || !crypto.timingSafeEqual(a,b)) throw new Error('用户名或密码不正确。');
  let recoveryKey='';
  if(!u.recoverySalt || !u.recoveryHash){
    recoveryKey=generateRecoveryKey(); setRecoveryKeyOnUser(u,recoveryKey); saveUsersRaw(loadUsersRaw().map(x=>x.id===u.id?u:x));
  }
  activeLocalUser=u; migratePlaintextPasswords();
  saveRememberedLogin(u.username,password,Boolean(payload?.remember));
  return recoveryKey ? {...localAuthState(), recoveryKey} : localAuthState();
});
ipcMain.handle('auth:update-credentials', async (_e,payload)=>{
  currentUserRequired();
  const current=String(payload?.currentPassword||''), nextUser=normalizeUsername(payload?.username||activeLocalUser.username), nextPass=String(payload?.newPassword||'');
  const actual=derivePassword(current,activeLocalUser.salt);
  const a=Buffer.from(actual,'hex'), b=Buffer.from(activeLocalUser.passwordHash,'hex');
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) throw new Error('当前密码不正确。');
  if(nextUser.length<2 || nextUser.length>40) throw new Error('用户名需要 2–40 个字符。');
  const users=loadUsersRaw();
  if(users.some(u=>u.id!==activeLocalUser.id && usernameKey(u.username)===usernameKey(nextUser))) throw new Error('该用户名已存在。');
  const idx=users.findIndex(u=>u.id===activeLocalUser.id); if(idx<0) throw new Error('当前用户不存在。');
  users[idx].username=nextUser;
  if(nextPass){ validatePassword(nextPass); const salt=crypto.randomBytes(16).toString('hex'); users[idx].salt=salt; users[idx].passwordHash=derivePassword(nextPass,salt); }
  saveUsersRaw(users); activeLocalUser=users[idx];
  const pref=rememberedLogin(); if(pref.remember) saveRememberedLogin(nextUser,nextPass||current,true);
  return localAuthState();
});
ipcMain.handle('auth:change-password-public', async (_e,payload)=>{
  const username=normalizeUsername(payload?.username), current=String(payload?.currentPassword||''), nextPass=String(payload?.newPassword||'');
  validatePassword(nextPass);
  const users=loadUsersRaw(); const idx=users.findIndex(x=>usernameKey(x.username)===usernameKey(username));
  if(idx<0) throw new Error('用户名或当前密码不正确。');
  const u=users[idx]; const actual=derivePassword(current,u.salt);
  const a=Buffer.from(actual,'hex'), b=Buffer.from(u.passwordHash,'hex');
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) throw new Error('用户名或当前密码不正确。');
  const salt=crypto.randomBytes(16).toString('hex'); u.salt=salt; u.passwordHash=derivePassword(nextPass,salt);
  saveUsersRaw(users);
  const pref=rememberedLogin(); if(pref.remember && usernameKey(pref.username)===usernameKey(u.username)) saveRememberedLogin(u.username,nextPass,true);
  if(activeLocalUser?.id===u.id) activeLocalUser=u;
  return {ok:true};
});
ipcMain.handle('auth:reset-password', async (_e,payload)=>{
  const username=normalizeUsername(payload?.username), recoveryKey=normalizeRecoveryKey(payload?.recoveryKey), nextPass=String(payload?.newPassword||'');
  validatePassword(nextPass);
  const users=loadUsersRaw(); const idx=users.findIndex(x=>usernameKey(x.username)===usernameKey(username));
  if(idx<0) throw new Error('用户名或恢复密钥不正确。');
  const u=users[idx]; if(!verifyRecoveryKey(u,recoveryKey)) throw new Error('用户名或恢复密钥不正确。');
  const salt=crypto.randomBytes(16).toString('hex'); u.salt=salt; u.passwordHash=derivePassword(nextPass,salt);
  const nextRecoveryKey=generateRecoveryKey(); setRecoveryKeyOnUser(u,nextRecoveryKey);
  saveUsersRaw(users);
  const pref=rememberedLogin(); if(pref.remember && usernameKey(pref.username)===usernameKey(u.username)) saveRememberedLogin(u.username,nextPass,true);
  if(activeLocalUser?.id===u.id) activeLocalUser=u;
  return {ok:true,recoveryKey:nextRecoveryKey};
});
ipcMain.handle('auth:rotate-recovery', async (_e,payload)=>{
  currentUserRequired(); const current=String(payload?.currentPassword||'');
  const actual=derivePassword(current,activeLocalUser.salt); const a=Buffer.from(actual,'hex'), b=Buffer.from(activeLocalUser.passwordHash,'hex');
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) throw new Error('当前密码不正确。');
  const users=loadUsersRaw(); const idx=users.findIndex(u=>u.id===activeLocalUser.id); if(idx<0) throw new Error('当前用户不存在。');
  const recoveryKey=generateRecoveryKey(); setRecoveryKeyOnUser(users[idx],recoveryKey); saveUsersRaw(users); activeLocalUser=users[idx];
  return {recoveryKey};
});

ipcMain.handle('auth:logout', async () => {
  await flushPersistentSessions().catch(()=>{});
  for (const w of windows.values()) { try{w.close();}catch{} }
  windows.clear();
  for (const id of [...proxyBridges.keys()]) await closeProxyBridge(id);
  try { hmTranslationMemo.clear(); } catch {}
  activeLocalUser=null;
  return localAuthState();
});
ipcMain.handle('auth:list-users', () => { currentUserRequired(); return activeLocalUser.role==='admin' ? loadUsersRaw().map(publicUser) : [publicUser(activeLocalUser)]; });
ipcMain.handle('auth:delete-user', async (_e, id) => {
  currentUserRequired(); if(activeLocalUser.role!=='admin') throw new Error('只有管理员可以删除本地用户。');
  if(id===activeLocalUser.id) throw new Error('不能删除当前登录用户。');
  let users=loadUsersRaw(); const target=users.find(u=>u.id===id); if(!target) return users.map(publicUser);
  if(target.legacyOwner) throw new Error('不能删除已迁移的主用户。');
  const userRoot=path.join(ROOT_DATA(),'users',id);
  const userProfiles=readJsonFile(path.join(userRoot,'profiles.json'),[]);
  users=users.filter(u=>u.id!==id); saveUsersRaw(users);
  try{fs.rmSync(userRoot,{recursive:true,force:true});}catch{}
  for(const p of Array.isArray(userProfiles)?userProfiles:[]){
    try{fs.rmSync(path.join(ROOT_DATA(),'Partitions',`user-${id}-profile-${p.id}`),{recursive:true,force:true});}catch{}
  }
  return users.map(publicUser);
});
ipcMain.handle('security:scan', async () => {
  currentUserRequired();
  const profiles=loadProfilesRaw(); const sec=loadSecurityRaw(); sec.networkBaselines=sec.networkBaselines||{};
  const results=[];
  for(const stored of profiles){
    const p=profileWithDecryptedSecret(stored); const configured=proxyRule(p.proxy)||'DIRECT'; let info=null;
    try{info=await checkProfileIp(p);}catch(e){info={ok:false,error:e.message};}
    const old=sec.networkBaselines[p.id]||null;
    const now={route:configured,ip:info?.ip||null,checkedAt:new Date().toISOString()};
    const changed=Boolean(old && ((old.route||'DIRECT')!==now.route || (old.ip&&now.ip&&old.ip!==now.ip)));
    sec.networkBaselines[p.id]=now;
    results.push({id:p.id,name:p.name,service:p.service,route:configured,ip:now.ip,country:info?.country||'',changed,ok:info?.ok!==false,error:info?.error||''});
  }
  saveSecurityRaw(sec);
  return {user:publicUser(activeLocalUser),encryptionAvailable:encryptionAvailable(),results,checkedAt:new Date().toISOString()};
});

ipcMain.handle('profiles:list', () => { currentUserRequired(); return loadProfilesRaw().map(sanitizeProfile); });

ipcMain.handle('profiles:save', async (_e, incoming) => {
  currentUserRequired();
  const profiles = loadProfilesRaw();
  const i = profiles.findIndex(x => x.id === incoming.id);
  const previous = i >= 0 ? profiles[i] : null;
  const proxy = { ...(incoming.proxy || { type: 'none' }) };

  const suppliedPassword = typeof proxy.password === 'string' ? proxy.password : '';
  const clearPassword = Boolean(proxy.clearPassword);
  delete proxy.clearPassword;
  delete proxy.hasPassword;

  if (clearPassword) {
    delete proxy.passwordEnc;
  } else if (suppliedPassword) {
    proxy.passwordEnc = encryptSecret(suppliedPassword);
  } else if (previous?.proxy?.passwordEnc) {
    proxy.passwordEnc = previous.proxy.passwordEnc;
  }
  delete proxy.password;

  const stored = {
    id: incoming.id,
    name: incoming.name,
    service: incoming.service,
    url: incoming.url || '',
    translation: incoming.translation || { source: 'AUTO', target: 'ZH' },
    guard: { blockChinese: Boolean(incoming.guard?.blockChinese) },
    proxy
  };

  if (previous) await closeProxyBridge(incoming.id);
  if (i >= 0) profiles[i] = stored;
  else profiles.push(stored);
  saveProfilesRaw(profiles);
  return profiles.map(sanitizeProfile);
});

ipcMain.handle('profiles:delete', async (_e, id) => {
  currentUserRequired();
  await closeProxyBridge(id);
  const profiles = loadProfilesRaw().filter(x => x.id !== id);
  saveProfilesRaw(profiles);
  return profiles.map(sanitizeProfile);
});

ipcMain.handle('profiles:reorder', async (_e, ids) => {
  currentUserRequired();
  const current = loadProfilesRaw();
  const map = new Map(current.map(p => [p.id, p]));
  const ordered = [];
  for (const id of Array.isArray(ids) ? ids : []) { if (map.has(id)) { ordered.push(map.get(id)); map.delete(id); } }
  for (const p of current) if (map.has(p.id)) { ordered.push(p); map.delete(p.id); }
  saveProfilesRaw(ordered);
  return ordered.map(sanitizeProfile);