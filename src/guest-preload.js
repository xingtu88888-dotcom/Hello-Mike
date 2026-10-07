const { ipcRenderer } = require('electron');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const visible = el => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 4 && r.height > 4 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
};
const rectOf = el => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};
const textOf = el => norm(`${el?.innerText || ''} ${el?.getAttribute?.('aria-label') || ''} ${el?.getAttribute?.('title') || ''} ${el?.getAttribute?.('data-testid') || ''}`);

let notes = {};
let blockChinese = false;
let noteObserver = null;
let noteRaf = 0;
let noteTimer = null;
const nativeWaiters = new Map();
let nativeSeq = 0;
let inlineAutoIncoming = false;
let inlineAutoOutgoing = false;
let inlineTranslationTarget = 'ZH';
let inlineTranslationObserver = null;
let inlineTranslationTimer = null;
let automationMode = false;
const inlinePending = new Set();
const inlineDone = new Map();
const inlineErrors = new Map();
const inlineOpenWanted = new Set();

function send(event){
  ipcRenderer.sendToHost('hm-adapter-event', event);
}
function alog(message, extra='') { try { send({type:'log', message: `${message}${extra ? ' · '+extra : ''}`}); } catch {} }
function result(requestId, ok, data, error) { send({ type: 'result', requestId, ok, data, error }); }
function requestNative(requestId, action, payload = {}, timeout = 4000) {
  const nativeId = `${Date.now()}:${++nativeSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { nativeWaiters.delete(nativeId); reject(new Error(`原生动作 ${action} 超时`)); }, timeout);
    nativeWaiters.set(nativeId, { resolve, reject, timer });
    send({ type: 'native', requestId, nativeId, action, payload });
  });
}
ipcRenderer.on('hm-adapter-native-ack', (_e, msg = {}) => {
  const p = nativeWaiters.get(msg.nativeId);
  if (!p) return;
  clearTimeout(p.timer); nativeWaiters.delete(msg.nativeId);
  msg.ok ? p.resolve(true) : p.reject(new Error(msg.error || '原生动作失败'));
});
ipcRenderer.on('hm-adapter-notes', (_e, msg = {}) => { notes = msg.notes && typeof msg.notes === 'object' ? msg.notes : {}; scheduleNotes(); });

ipcRenderer.on('hm-inline-translation-result', (_e, msg = {}) => {
  const key = String(msg.key || '');
  if (!key) return;
  inlinePending.delete(key);
  if(msg.error){ inlineErrors.set(key,String(msg.error)); applyInlineTranslations(); return; }
  inlineErrors.delete(key);
  if(msg.text){ inlineDone.set(key,String(msg.text)); saveTranslationCache(); }
  applyInlineTranslations();
});

function chatRoot() { return document.querySelector('#pane-side'); }
function chatRows() {
  const root = chatRoot(); if (!root) return [];
  const frames = [...root.querySelectorAll('[data-testid="cell-frame-container"]')];
  const rows = frames.length ? frames.map(f => f.closest('[role="row"],[role="listitem"]') || f.parentElement?.parentElement || f) : [...root.querySelectorAll('[role="row"],[role="listitem"]')];
  return [...new Set(rows)].filter(visible);
}
function rowName(row) {
  const titles = [...row.querySelectorAll('span[title],[title]')].map(x => norm(x.getAttribute('title'))).filter(x => x && x.length < 140);
  if (titles.length) return titles[0];
  return norm((row.innerText || '').split(/\n/).filter(Boolean)[0]).slice(0, 140);
}
function ensureNoteStyle() {
  if (document.getElementById('__hm_adapter_note_style')) return;
  const style = document.createElement('style');
  style.id = '__hm_adapter_note_style';
  style.textContent = `
    .__hm_adapter_note_btn{position:absolute;left:84px;right:72px;top:34px!important;z-index:6;border:0;background:#fff;padding:0 3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font:700 13px/16px system-ui;color:#ef2d2d;cursor:pointer}
    #pane-side [data-testid="cell-frame-secondary"]{transform:translateY(9px)!important}
    .__hm_adapter_note_btn[data-empty="1"]{color:#8d98a7;font-weight:500;opacity:.35;background:transparent}
    .__hm_adapter_note_btn:hover{background:#eef2f6;opacity:1}                        
  `;
  document.head.appendChild(style);
}
function ensureNoteLayer() {
  // v0.12.4: notes now live inside their own WhatsApp chat row.
  // Keeping this helper for compatibility with older callers, but no fixed overlay is created.
  ensureNoteStyle();
  const old = document.getElementById('__hm_adapter_note_layer');
  if (old) old.remove();
  return chatRoot();
}
function bindNoteButton(btn) {
  if (!btn || btn.dataset.hmBound === '1') return;
  btn.dataset.hmBound = '1';
  btn.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  }, true);
  btn.addEventListener('pointerup', e => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const chatName = btn.dataset.chatName || '';
    const now = Date.now();
    if (chatName && (!window.__hmLastNoteOpen || now-window.__hmLastNoteOpen>350)) {
      window.__hmLastNoteOpen = now;
      send({ type: 'note-edit', chatName });
    }
  }, true);
}
// HM_ARCHIVE_NOTE_FIX_20260919_R1
function hmNoteIsArchiveLabel(value) {
  const label = norm(value).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  return /^(?:已归档|已歸檔|已封存|归档|歸檔|封存|archived(?: chats)?|archiviati|archiviate|archivados|archivadas|arquivadas|arquivados|archivés|archivées|archivierte chats|arsip)(?:\s*[(（]?\s*\d+\s*[)）]?)?$/i.test(label);
}

function hmNoteIsNavigation(row) {
  if (!row) return true;
  const firstLine = String(row.innerText || row.textContent || '').split(/\r?\n/).map(norm).find(Boolean) || '';
  const ownLabels = [firstLine, row.getAttribute('aria-label'), row.getAttribute('title')];
  if (!ownLabels.some(hmNoteIsArchiveLabel)) return false;
  const markers = [row, ...row.querySelectorAll('[data-icon],[data-testid]')];
  const hasArchiveMarker = markers.some(el => /^(?:archive|archived|archive-refreshed|archived-chats|archived-chats-entry|archived-chats-button|archived-chats-row|archive-chat-list)$/i.test(el.getAttribute('data-icon') || '') || /^(?:archived-chats|archived-chats-entry|archived-chats-button|archived-chats-row|archive-chat-list)$/i.test(el.getAttribute('data-testid') || ''));
  const titles = [...row.querySelectorAll('span[title]')].filter(el => !el.closest('.__hm_adapter_note_btn'));
  const isChatNamedArchive = titles.some(el => hmNoteIsArchiveLabel(el.getAttribute('title')));
  const hasAvatar = !!row.querySelector('img,[data-icon="default-user"],[data-icon="default-group"],[data-testid="avatar"]');
  // Keep a real contact/group literally named Archived. Exclude its navigation counterpart.
  return hasArchiveMarker || !isChatNamedArchive || !hasAvatar;
}

function hmNoteRows(root) {
  if (!root) return [];
  const frameSelector = '[data-testid="cell-frame-container"]';
  const raw = [...new Set(chatRows())].filter(row => row && row !== root && root.contains(row) && visible(row));
  const frames = [...root.querySelectorAll(frameSelector)].filter(visible);
  function eligible(row) {
    if (!row || row === root || !root.contains(row) || !visible(row)) return false;
    if (row.matches('[role="grid"],[role="list"],[role="rowgroup"]')) return false;
    if (hmNoteIsNavigation(row)) return false;
    // Never attach a note to an outer list wrapper or to two nested representations.
    if (raw.some(other => other !== row && row.contains(other))) return false;
    const inside = [...row.querySelectorAll(frameSelector)];
    if (row.matches(frameSelector)) inside.unshift(row);
    const independent = inside.filter(frame => !inside.some(parent => parent !== frame && parent.contains(frame)));
    return independent.length <= 1;
  }
  const rows = raw.filter(eligible);
  for (const frame of frames) {
    if (rows.some(row => row === frame || row.contains(frame))) continue;
    let row = frame.closest('[role="row"],[role="listitem"]');
    if (!eligible(row)) row = frame;
    if (eligible(row)) rows.push(row);
  }
  const unique = [...new Set(rows)];
  return unique.filter(row => !unique.some(other => other !== row && row.contains(other)));
}

function hmNoteRowName(row) {
  // Our own note title must never become a contact's name.
  const titles = [...row.querySelectorAll('span[title],[title]')]
    .filter(el => !el.closest('.__hm_adapter_note_btn'))
    .map(el => norm(el.getAttribute('title')))
    .filter(value => value && value.length < 140);
  if (titles.length) return titles[0];
  return norm(String(row.innerText || '').split(/\n/).filter(Boolean)[0]).slice(0, 140);
}

function decorateNotes() {
  ensureNoteStyle();
  const root = chatRoot();
  if (!root) return;
  const rootRect = root.getBoundingClientRect();
  const activeRows = new Set();
  for (const row of hmNoteRows(root)) {
    const name = hmNoteRowName(row);
    if (!name) continue;
    const r = row.getBoundingClientRect();
    const inside = r.bottom > rootRect.top + 1 && r.top < rootRect.bottom - 1 && r.width >= 120 && r.height >= 40;
    if (!inside) continue;
    activeRows.add(row);
    const existing = [...row.querySelectorAll(':scope > .__hm_adapter_note_btn')];
    let btn = existing.shift();
    existing.forEach(extra => extra.remove());
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = '__hm_adapter_note_btn';
      btn.setAttribute('aria-label', '编辑备注');
      bindNoteButton(btn);
      if (getComputedStyle(row).position === 'static') row.style.position = 'relative';
      row.appendChild(btn);
    }
    if (btn.dataset.chatName !== name) btn.dataset.chatName = name;
    const value = String(notes[name] || '').trim();
    const label = value || '添加备注';
    const empty = value ? '0' : '1';
    const title = value ? `本地备注：${value}` : '添加本地备注';
    if (btn.textContent !== label) btn.textContent = label;
    if (btn.dataset.empty !== empty) btn.dataset.empty = empty;
    if (btn.title !== title) btn.title = title;
    const top = `${Math.max(26, Math.min(40, Math.round(r.height * .50)))}px`;
    if (btn.style.top !== top) btn.style.top = top;
  }
  // Remove only Hello Mike's generated controls, never stored note data or WhatsApp UI.
  root.querySelectorAll('.__hm_adapter_note_btn').forEach(btn => {
    if (!activeRows.has(btn.parentElement)) btn.remove();
  });
}

function scheduleNotes() { cancelAnimationFrame(noteRaf); noteRaf = requestAnimationFrame(decorateNotes); }
function installNotes() {
  if (noteObserver) return;
  ensureNoteStyle();
  const old = document.getElementById('__hm_adapter_note_layer');
  if (old) old.remove();
  noteObserver = new MutationObserver(scheduleNotes);
  noteObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter:['style','class'] });
  document.addEventListener('scroll', scheduleNotes, true);
  window.addEventListener('resize', scheduleNotes, true);
  // Faster reconciliation keeps pace with WhatsApp virtual-list recycling during quick wheel scrolling.
  noteTimer = setInterval(scheduleNotes, 180);
  scheduleNotes(); send({ type: 'notes-request' });
}


function hashText(s){let h=2166136261;for(const ch of String(s||'')){h^=ch.codePointAt(0);h=Math.imul(h,16777619)}return (h>>>0).toString(36)}
function messageNodes(){
  const main=document.querySelector('#main'); if(!main)return [];
  const raw=[...main.querySelectorAll('[data-testid="msg-container"], .message-in, .message-out')];
  return [...new Set(raw.map(x=>x.closest?.('[data-testid="msg-container"]')||x).filter(visible))];
}
function messageDirection(node){
  if(node.closest?.('.message-out')||node.classList?.contains('message-out'))return 'outgoing';
  if(node.closest?.('.message-in')||node.classList?.contains('message-in'))return 'incoming';
  return 'incoming';
}
function cleanMessageElementText(el){
  if(!el)return '';
  try{
    const clone=el.cloneNode(true);
    clone.querySelectorAll?.('.__hm_translation_wrap,.__hm_adapter_note_layer,button').forEach(x=>x.remove());
    return norm(clone.textContent||'');
  }catch{return norm(el.innerText||el.textContent||'');}
}
function messageText(node){
  // Prefer WhatsApp's actual text span. Never feed Hello Mike's own controls back into translation.
  const primary=[...node.querySelectorAll('[data-testid="msg-text"],span.selectable-text')].filter(x=>!x.closest('.__hm_translation_wrap'));
  let t=primary.map(cleanMessageElementText).filter(Boolean)[0]||'';
  if(!t){
    const copy=[...node.querySelectorAll('div.copyable-text')].filter(x=>!x.closest('.__hm_translation_wrap'));
    t=copy.map(cleanMessageElementText).filter(Boolean)[0]||cleanMessageElementText(node);
  }
  t=t.replace(/\n?(Hello Mike 翻译|GPT-4o 翻译|智能翻译)[:：]?.*$/s,'').replace(/\n?收起翻译\s*$/,'').trim();
  return t.length>0&&t.length<5000?t:'';
}
function translationHost(node){
  return node.querySelector('[data-testid="msg-text"]')?.parentElement || node.querySelector('.copyable-text') || node;
}
function translationKey(node,text,direction){
  const id=node.getAttribute('data-id')||node.dataset?.id||'';
  return `${direction}:${id||hashText(text)}:${hashText(text)}:${inlineTranslationTarget}`;
}
function translationContext(node){
  const nodes=messageNodes(); const at=Math.max(0,nodes.indexOf(node));
  return nodes.slice(Math.max(0,at-6),at).map(n=>({direction:messageDirection(n),text:messageText(n)})).filter(x=>x.text).slice(-6);
}
function loadTranslationCache(){
  try{
    const raw=JSON.parse(localStorage.getItem('__hello_mike_translation_cache_v4')||'{}');
    for(const [k,v] of Object.entries(raw||{}))if(typeof v==='string'&&v)inlineDone.set(k,v);
  }catch{}
}
function saveTranslationCache(){
  try{
    const entries=[...inlineDone.entries()].filter(([,v])=>v&&v!=='__HM_NO_TRANSLATION__').slice(-500);
    localStorage.setItem('__hello_mike_translation_cache_v4',JSON.stringify(Object.fromEntries(entries)));
  }catch{}
}
function ensureInlineTranslationStyle(){
  if(document.getElementById('__hm_inline_translation_style'))return;
  const st=document.createElement('style');st.id='__hm_inline_translation_style';st.textContent=`
  .__hm_translation_wrap{margin-top:4px;display:block;max-width:100%}
  .__hm_translate_btn{border:0;background:transparent;color:#1688d4;padding:1px 0;font:600 11px/1.4 system-ui;cursor:pointer;opacity:.82}
  .__hm_translate_btn:hover{opacity:1;text-decoration:underline}
  .__hm_translate_btn[disabled]{cursor:wait;opacity:.55;text-decoration:none}
  .__hm_inline_translation{margin-top:3px;padding:5px 7px;border-left:2px solid #32a6e6;background:rgba(50,166,230,.08);border-radius:4px;color:inherit;font:500 13px/1.48 system-ui;white-space:pre-wrap;word-break:break-word}
  .__hm_inline_translation small{display:block;color:#1688d4;font:600 10px/1.2 system-ui;margin-bottom:2px}`;document.head.appendChild(st);
}
// HM_TRANSLATION_UI_PATCH_20260919_R2
// Manual translation only. No account/session/proxy changes.
const hmTranslationPreparations = new Map();
const hmTranslationPreparingNodes = new WeakMap();


function hmTranslationNodeId(node) {
  return String(node?.getAttribute?.('data-id') || node?.closest?.('[data-id]')?.getAttribute('data-id') || '');
}
function hmTranslationLockId(node, key) {
  return hmTranslationNodeId(node) || key;
}
function hmTranslationPreparation(node, key) {
  return hmTranslationPreparingNodes.get(node) || hmTranslationPreparations.get(hmTranslationLockId(node, key));
}
function hmTranslationButton(button, label, disabled, title = '') {
  if (!button) return;
  if (button.textContent !== label) button.textContent = label;
  if (button.disabled !== disabled) button.disabled = disabled;
  if (button.title !== title) button.title = title;
}
function hmTranslationOutput(output, value) {
  if (output.__hmTranslationValue === value) return;
  output.innerHTML = '<small>Google 翻译</small>' + String(value).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  output.__hmTranslationValue = value;
}
function hmFindTranslationMore(node) {
  if (!node) return null;
  const labelPattern = /^(?:查看更多|显示更多|顯示更多|阅读更多|閱讀更多|read\s+more|show\s+more|leggi\s+altro|leggi\s+di\s+pi[uù]|leggi\s+tutto|mostra\s+altro|mostra\s+di\s+pi[uù]|ver\s+m[aá]s|leer\s+m[aá]s|mostrar\s+mais|mehr\s+anzeigen|voir\s+plus|lire\s+la\s+suite)(?:\s*[.…]+)?$/i;
  for (const el of node.querySelectorAll('button,[role="button"],[tabindex],span,a')) {
    if (!visible(el)) continue;
    if (el.closest('.__hm_translation_wrap,blockquote,[data-testid*="quoted"],[data-testid*="link-preview"],[role="menu"]')) continue;
    // Do not follow any URL embedded in a message.
    if (el.closest('a[href]')) continue;
    const labels = [el.innerText || el.textContent || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || ''];
    if (!labels.some(label => labelPattern.test(norm(label)))) continue;
    const isControl = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.hasAttribute('tabindex') || /read[-_]?more/i.test(el.getAttribute('data-testid') || '') || getComputedStyle(el).cursor === 'pointer';
    if (isControl && typeof el.click === 'function') return el;
  }
  return null;
}
function hmResolveTranslationMessage(ctx) {
  if (inlineTranslationTarget !== ctx.target || activeChatTitle() !== ctx.chat) {
    throw new Error('聊天或目标语言已切换，请在当前消息上重新点击翻译。');
  }
  const main = document.querySelector('#main');
  let node = ctx.node;
  if (!node?.isConnected || !main?.contains(node) || (ctx.id && hmTranslationNodeId(node) !== ctx.id)) {
    node = ctx.id ? messageNodes().find(el => hmTranslationNodeId(el) === ctx.id) : null;
  }
  if (!node?.isConnected || !main?.contains(node)) {
    throw new Error('消息在展开时被页面重新载入，请重新点击该消息的翻译。');
  }
  const text = messageText(node);
  if (text && ctx.prefix && !norm(text).startsWith(ctx.prefix)) {
    throw new Error('消息内容已变化，请重新点击翻译。');
  }
  if (ctx.node !== node) {
    hmTranslationPreparingNodes.delete(ctx.node);
    ctx.node = node;
    hmTranslationPreparingNodes.set(node, ctx);
  }
  return node;
}
async function hmReadExpandedTranslationMessage(ctx) {
  let node = hmResolveTranslationMessage(ctx);
  const more = hmFindTranslationMore(node);
  if (!more) return node;
  // Only the selected message's explicit expansion control is clicked.
  more.click();
  const deadline = Date.now() + 6500;
  let lastText = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    await sleep(100);
    node = hmResolveTranslationMessage(ctx);
    const text = messageText(node);
    if (!hmFindTranslationMore(node) && text) {
      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 500) {
        return node;
      }
    } else {
      lastText = '';
      stableSince = 0;
    }
  }
  throw new Error('未能确认长消息已完整展开，或正文超出原有长度限制。请先手动展开后重试；本次未提交截断内容。');
}
async function requestTranslation(node, key, text, direction, button) {
  if (inlinePending.has(key) || hmTranslationPreparation(node, key)) return;
  const lock = hmTranslationLockId(node, key);
  const folded = !!hmFindTranslationMore(node);
  const ctx = {
    node, id: hmTranslationNodeId(node), chat: activeChatTitle(),
    target: inlineTranslationTarget, prefix: norm(text).slice(0, 24),
    label: folded ? '正在展开消息…' : '翻译中…'
  };
  hmTranslationPreparations.set(lock, ctx);
  hmTranslationPreparingNodes.set(node, ctx);
  inlinePending.add(key);
  inlineErrors.delete(key);
  // A cached translation of a folded excerpt must not bypass expansion.
  if (folded && inlineDone.has(key)) {
    inlineDone.delete(key);
    saveTranslationCache();
  }
  hmTranslationButton(button, ctx.label, true);
  let finalKey = key;
  let forwarded = false;
  let ownsFinalPending = false;
  try {
    const currentNode = await hmReadExpandedTranslationMessage(ctx);
    hmResolveTranslationMessage(ctx);
    const fullText = messageText(currentNode);
    if (!fullText) throw new Error('未能读取完整正文，或正文超出原有长度限制；本次未提交翻译。');
    const currentDirection = messageDirection(currentNode);
    finalKey = translationKey(currentNode, fullText, currentDirection);
    inlineOpenWanted.add(finalKey);
    if (finalKey !== key && inlinePending.has(finalKey)) return;
    inlineErrors.delete(finalKey);
    const cached = inlineDone.get(finalKey);
    if (cached && cached !== '__HM_NO_TRANSLATION__') return;
    inlinePending.add(finalKey);
    ownsFinalPending = true;
    send({type:'translate-request', key:finalKey, text:fullText, target:inlineTranslationTarget, direction:currentDirection, context:translationContext(currentNode)});
    forwarded = true;
  } catch (error) {
    if (ownsFinalPending) inlinePending.delete(finalKey);
    const errorText = String(error?.message || error);
    let errorKey = finalKey;
    if (ctx.node?.isConnected && activeChatTitle() === ctx.chat && inlineTranslationTarget === ctx.target) {
      const currentText = messageText(ctx.node);
      if (currentText) errorKey = translationKey(ctx.node, currentText, messageDirection(ctx.node));
      const currentButton = translationHost(ctx.node).querySelector('.__hm_translate_btn');
      hmTranslationButton(currentButton, '翻译失败，重试', false, errorText);
    }
    inlineErrors.set(errorKey, errorText);
    inlineOpenWanted.delete(finalKey);
  } finally {
    if (!forwarded || finalKey !== key) inlinePending.delete(key);
    hmTranslationPreparations.delete(lock);
    hmTranslationPreparingNodes.delete(ctx.node);
    scheduleInlineTranslations();
  }
}
function applyInlineTranslations() {
  ensureInlineTranslationStyle();
  for (const node of messageNodes()) {
    const text = messageText(node);
    if (!text) continue;
    const direction = messageDirection(node);
    const key = translationKey(node, text, direction);
    const host = translationHost(node);
    let wrap = host.querySelector(':scope > .__hm_translation_wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = '__hm_translation_wrap';
      wrap.dataset.hmKey = key;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = '__hm_translate_btn';
      btn.textContent = '翻译';
      const out = document.createElement('div');
      out.className = '__hm_inline_translation';
      out.hidden = true;
      wrap.append(btn, out);
      host.appendChild(wrap);
      btn.addEventListener('click', e => {
        // Preserve the original real-user-click requirement.
        if (!e.isTrusted) return;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        const currentNode = node.isConnected && node.contains(wrap) ? node : messageNodes().find(el => el.contains(wrap));
        if (!currentNode) return;
        const currentText = messageText(currentNode);
        if (!currentText) return;
        const currentDirection = messageDirection(currentNode);
        const k = translationKey(currentNode, currentText, currentDirection);
        if (inlinePending.has(k) || hmTranslationPreparation(currentNode, k)) return;
        const value = inlineDone.get(k);
        if (value && value !== '__HM_NO_TRANSLATION__') {
          if (!out.hidden && wrap.dataset.hmKey === k) {
            out.hidden = true;
            hmTranslationButton(btn, '翻译', false);
            return;
          }
          if (!hmFindTranslationMore(currentNode)) {
            hmTranslationOutput(out, value);
            out.hidden = false;
            out.dataset.initialized = '1';
            hmTranslationButton(btn, '收起翻译', false);
            return;
          }
        }
        requestTranslation(currentNode, k, currentText, currentDirection, btn).catch(error => {
          hmTranslationButton(btn, '翻译失败，重试', false, String(error?.message || error));
        });
      }, true);
    }
    const btn = wrap.querySelector('.__hm_translate_btn');
    const out = wrap.querySelector('.__hm_inline_translation');
    if (!btn || !out) continue;
    if (wrap.dataset.hmKey !== key) {
      wrap.dataset.hmKey = key;
      out.hidden = true;
      out.textContent = '';
      delete out.__hmTranslationValue;
      delete out.dataset.initialized;
    }
    const preparing = hmTranslationPreparation(node, key);
    if (preparing) {
      hmTranslationButton(btn, preparing.label, true);
      out.hidden = true;
    } else if (inlinePending.has(key)) {
      hmTranslationButton(btn, '翻译中…', true);
      out.hidden = true;
    } else if (inlineErrors.has(key)) {
      hmTranslationButton(btn, '翻译失败，重试', false, inlineErrors.get(key) || '');
      out.hidden = true;
    } else if (inlineDone.has(key)) {
      const value = inlineDone.get(key);
      if (value === '__HM_NO_TRANSLATION__') {
        hmTranslationButton(btn, '翻译', false);
        out.hidden = true;
      } else {
        hmTranslationOutput(out, value);
        if (inlineOpenWanted.has(key)) {
          out.hidden = false;
          out.dataset.initialized = '1';
          inlineOpenWanted.delete(key);
        } else if (!out.dataset.initialized) {
          out.hidden = true;
          out.dataset.initialized = '1';
        }
        hmTranslationButton(btn, out.hidden ? '翻译' : '收起翻译', false);
      }
    } else {
      hmTranslationButton(btn, '翻译', false);
      out.hidden = true;
      // Opening or scrolling a chat never requests translation or expands messages.
    }
  }
}
function hmShouldRefreshTranslationButtons(records) {
  const ownSelector = '.__hm_translation_wrap,.__hm_adapter_note_btn,.__hm_adapter_note_layer,#__hm_inline_translation_style,#__hm_adapter_note_style';
  const ownNode = node => {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return !!el?.closest?.(ownSelector);
  };
  return records.some(record => {
    if (ownNode(record.target)) return false;
    if (record.type === 'characterData') return true;
    return [...record.addedNodes, ...record.removedNodes].some(node => !ownNode(node));
  });
}
function scheduleInlineTranslations() {
  // Throttle: later mutations do not keep postponing a pending refresh.
  if (inlineTranslationTimer !== null) return;
  inlineTranslationTimer = setTimeout(() => {
    inlineTranslationTimer = null;
    applyInlineTranslations();
  }, 40);
}
function installInlineTranslations() {
  if (inlineTranslationObserver || !document.documentElement) return;
  document.querySelectorAll('.__hm_translation_wrap').forEach(el => el.remove());
  inlinePending.clear(); inlineErrors.clear(); inlineOpenWanted.clear();
  loadTranslationCache();
  applyInlineTranslations();
  inlineTranslationObserver = new MutationObserver(records => {
    if (hmShouldRefreshTranslationButtons(records)) scheduleInlineTranslations();
  });
  inlineTranslationObserver.observe(document.documentElement, {subtree:true, childList:true, characterData:true});
  document.addEventListener('scroll', scheduleInlineTranslations, true);
  window.addEventListener('resize', scheduleInlineTranslations, {passive:true});
  scheduleInlineTranslations();
}

function composer() { return document.querySelector('footer [contenteditable="true"][role="textbox"]') || document.querySelector('footer [contenteditable="true"]'); }
function installChineseGuard() {
  if (window.__hmAdapterChineseGuard) return;
  window.__hmAdapterChineseGuard = true;
  const han = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
  const blocked = () => blockChinese && han.test(norm(composer()?.innerText || composer()?.textContent || ''));
  const warn = () => {
    let n = document.getElementById('__hm_adapter_guard');
    if (!n) { n = document.createElement('div'); n.id='__hm_adapter_guard'; Object.assign(n.style,{position:'fixed',left:'50%',bottom:'90px',transform:'translateX(-50%)',zIndex:'2147483647',background:'#b42318',color:'#fff',padding:'11px 17px',borderRadius:'10px',font:'600 14px system-ui',boxShadow:'0 8px 30px #0007'}); document.body.appendChild(n); }
    n.textContent='已阻止发送：消息中包含中文，请先翻译。'; n.style.display='block'; clearTimeout(window.__hmAdapterGuardTimer); window.__hmAdapterGuardTimer=setTimeout(()=>n.style.display='none',2500);
  };
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && blocked()) { e.preventDefault(); e.stopImmediatePropagation(); warn(); } }, true);
  document.addEventListener('click', e => { const b=e.target?.closest?.('button,[role="button"]'); if(!b)return; const a=(b.getAttribute('aria-label')||'').toLowerCase(); if((a.includes('send')||b.querySelector?.('[data-icon="send"]'))&&blocked()){e.preventDefault();e.stopImmediatePropagation();warn();}}, true);
}

function findMenuButton() {
  const exact=[
    '#side header [data-icon="menu"]','#side header [data-testid*="menu"]','header [data-icon="menu"]','header [data-testid*="menu"]',
    '[aria-label="菜单"]','[aria-label="選單"]','[aria-label="Menu"]','[aria-label="More options"]','[title="菜单"]','[title="Menu"]'
  ];
  for(const q of exact){const n=document.querySelector(q);const b=n?.closest?.('button,[role="button"],div[tabindex="0"]')||n;if(b&&visible(b))return b;}
  const pane=chatRoot();const controls=[...document.querySelectorAll('button,[role="button"],div[tabindex="0"]')].filter(visible);
  const labels=/(菜单|選單|menu|menú|menù|menü|更多|更多选项|more options)/i;
  const labeled=controls.find(x=>labels.test(textOf(x)+' '+(x.getAttribute?.('aria-label')||'')+' '+(x.getAttribute?.('title')||'')));if(labeled)return labeled;
  const right=pane?.getBoundingClientRect?.().right||Math.min(innerWidth*.62,900);
  return controls.filter(x=>{const r=x.getBoundingClientRect();return r.top<160&&r.left<right&&r.left>right-240&&r.width<90&&r.height<90;}).sort((a,b)=>b.getBoundingClientRect().left-a.getBoundingClientRect().left)[0]||null;
}

function findMarkAllReadItem() {
  const re = /(全标为已读|全部标为已读|全部標為已讀|標示全部為已讀|全部设为已读|全部設為已讀|mark all as read|segna tutto come letto|segna tutti come letti|marcar todo como leído|marcar todos como leídos|marcar tudo como lido|alle als gelesen markieren)/i;
  return [...document.querySelectorAll('[role="menuitem"],[role="option"],li,button,div[tabindex="0"]')].filter(visible).find(x => re.test(textOf(x))) || null;
}
function findConfirmMarkReadButton() {
  const dialog = [...document.querySelectorAll('[role="dialog"],div[aria-modal="true"]')].filter(visible).find(d => /(将所有对话标记为已读|将所有聊天标记为已读|全部.*已读|mark all.*read|segna.*lett|marcar.*leído|marcar.*lido)/i.test(textOf(d)));
  if (!dialog) return null;
  const candidates = [...dialog.querySelectorAll('button,[role="button"]')].filter(visible);
  const positive = /^(确定|確認|确认|好|ok|okay|mark as read|mark all as read|segna|conferma|confirm|sí|sim)$/i;
  return candidates.find(b => positive.test(textOf(b))) || candidates.filter(b => !/(取消|cancel|annulla|no)$/i.test(textOf(b))).at(-1) || null;
}
function unreadFilterCount(){
  const root=chatRoot(); if(!root)return null;
  const top=(root.getBoundingClientRect?.().top||0)+210;
  const re=/(未读|未讀|unread|non letti|no leídos|não lidas)/i;
  const btn=[...document.querySelectorAll('button,[role="button"],div[tabindex="0"]')].filter(visible).find(x=>{const r=x.getBoundingClientRect();return r.top<top&&re.test(norm(textOf(x)));});
  if(!btn)return null;
  const t=norm(textOf(btn)); const m=t.match(/(\d{1,4})/); return m?Number(m[1]):0;
}
function unreadSummary() {
  const root=chatRoot(); if(!root) return {count:null, badges:[]};
  const filterCount=unreadFilterCount();
  const badges=[];
  for(const row of chatRows()){
    const name=rowName(row); if(!name) continue;
    const aria=[...row.querySelectorAll('[aria-label],[data-icon]')].map(x=>norm(`${x.getAttribute?.('aria-label')||''} ${x.getAttribute?.('data-icon')||''}`)).filter(Boolean);
    let unread=aria.some(t=>/(unread|未读|未讀)/i.test(t));
    if(!unread){
      unread=[...row.querySelectorAll('span')].some(x=>{
        const t=norm(x.textContent);if(!/^\d{1,4}$/.test(t))return false;
        const r=x.getBoundingClientRect(),rr=row.getBoundingClientRect();if(!(r.width<44&&r.height<34&&r.right>rr.right-90))return false;
        const cs=getComputedStyle(x);const bg=cs.backgroundColor||'';const rad=parseFloat(cs.borderRadius)||0;
        return rad>=6 && bg && !/rgba?\(0,\s*0,\s*0,\s*0\)/.test(bg) && bg!=='transparent' && !/rgb\(255,\s*255,\s*255\)/.test(bg);
      });
    }
    if(unread) badges.push(name);
  }
  const count=filterCount!==null?filterCount:badges.length;
  return {count,badges,filterCount};
}
async function waitFor(fn, timeout=3500, interval=90) {
  const end=Date.now()+timeout;
  while(Date.now()<end){ const v=fn(); if(v)return v; await sleep(interval); }
  return null;
}
async function markAllRead(requestId) {
  const root = chatRoot(); if (!root) throw new Error('WhatsApp 聊天列表尚未就绪');
  const before = unreadSummary();
  alog('全部已读', `开始，检测到未读会话 ${before.count ?? '?'} 个`);
  if (before.count === 0) return { method:'无需处理', before, after:before, verified:true, skipped:true };

  const clickDirect = (el) => {
    if (!el) return false;
    try { el.scrollIntoView?.({block:'nearest',inline:'nearest'}); el.focus?.({preventScroll:true}); el.click(); return true; } catch { return false; }
  };
  const menuVisible = () => !!findMarkAllReadItem();
  const confirmVisible = () => !!findConfirmMarkReadButton();

  // 1) Close transient popovers, then open the sidebar menu. Prefer DOM click because it
  // targets the exact React-bound element; fall back to native input only if the menu does not appear.
  await requestNative(requestId,'key',{keyCode:'ESCAPE'}).catch(()=>{});
  await sleep(100);
  const menu = findMenuButton(); if (!menu) throw new Error('找不到 WhatsApp 左侧聊天列表顶部的三点菜单');
  alog('全部已读','已找到三点菜单');
  clickDirect(menu);
  let item = await waitFor(findMarkAllReadItem, 1500, 70);
  if (!item) {
    alog('全部已读','DOM 点击未打开菜单，尝试原生点击');
    await requestNative(requestId, 'click', { rect: rectOf(menu) });
    item = await waitFor(findMarkAllReadItem, 3000, 80);
  }
  if (!item) { await requestNative(requestId,'key',{keyCode:'ESCAPE'}).catch(()=>{}); throw new Error('已尝试打开三点菜单，但没有出现“全标为已读”菜单项'); }

  // 2) Execute WhatsApp's own menu command, then confirm its own confirmation dialog.
  alog('全部已读','已找到“全标为已读”');
  clickDirect(item);
  let confirmBtn = await waitFor(findConfirmMarkReadButton, 1200, 60);
  if (!confirmBtn) {
    // If direct click was ignored, reopen menu and use native click on the exact item.
    if (!confirmVisible()) {
      const menu2=findMenuButton(); if(menu2){ clickDirect(menu2); await sleep(180); }
      const item2=await waitFor(findMarkAllReadItem,1200,70);
      if(item2) await requestNative(requestId,'click',{rect:rectOf(item2)}).catch(()=>{});
      confirmBtn=await waitFor(findConfirmMarkReadButton,2200,70);
    }
  }
  if (confirmBtn) {
    alog('全部已读','正在自动确认 WhatsApp 对话框');
    clickDirect(confirmBtn);
    await sleep(180);
    if (confirmVisible()) await requestNative(requestId,'click',{rect:rectOf(confirmBtn)}).catch(()=>{});
  }

  // 3) Verification is mandatory. We never report success merely because a click was attempted.
  const end=Date.now()+9000; let after=unreadSummary();
  while(Date.now()<end){
    after=unreadSummary();
    if(after.count===0) break;
    await sleep(220);
  }
  const verified = after.count===0;
  alog('全部已读', `验证结果 ${before.count ?? '?'} → ${after.count ?? '?'}`);
  if(!verified) throw new Error(`WhatsApp 命令已执行，但未读会话仍有 ${after.count ?? '?'} 个；本账号未判定为成功`);
  return { method:'WhatsApp 三点菜单 → 全标为已读 → 自动确认', before, after, verified:true };
}

async function collectChats(requestId) {
  const root=chatRoot(); if(!root) throw new Error('WhatsApp 聊天列表尚未就绪');
  const findFilter=(kind)=>{
    const patterns={all:/^(所有|全部|all|tutti|todos|tous|alle)$/i,group:/^(群组|群組|groups?|gruppi|grupos|groupes|gruppen)(\s*\d+)?$/i};
    const re=patterns[kind]; const top=(root.getBoundingClientRect?.().top||0)+190;
    return [...document.querySelectorAll('button,[role="button"],div[tabindex="0"]')].filter(visible).find(x=>{const r=x.getBoundingClientRect();return r.top<top&&re.test(norm(textOf(x)));})||null;
  };
  const clickFilter=async(kind)=>{const b=findFilter(kind);if(!b)return false;try{b.click()}catch{};await sleep(260);return true;};
  const findScroller=()=>{
    const cands=[root,...root.querySelectorAll('div')].filter(x=>x.scrollHeight>x.clientHeight+80);
    return cands.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0]||root;
  };
  const collectCurrent=async()=>{
    const scroller=findScroller(),items=new Map();let stagnant=0,lastCount=0,lastTop=-1;
    const scan=()=>chatRows().forEach(r=>{const n=rowName(r);if(n&&n.length<140)items.set(normalizedChatName(n),{name:n});});
    try{scroller.scrollTop=0}catch{};await sleep(160);scan();
    for(let i=0;i<260;i++){
      const max=Math.max(0,scroller.scrollHeight-scroller.clientHeight),step=Math.max(160,Math.floor(scroller.clientHeight*.70));
      scroller.scrollTop=Math.min(max,scroller.scrollTop+step);await sleep(115);scan();
      if(items.size===lastCount&&Math.abs(scroller.scrollTop-lastTop)<3)stagnant++;else stagnant=0;
      lastCount=items.size;lastTop=scroller.scrollTop;
      if((scroller.scrollTop>=max-3&&stagnant>=2)||stagnant>=7)break;
    }
    try{scroller.scrollTop=0}catch{};await sleep(100);return [...items.values()];
  };
  await clickFilter('all'); const all=await collectCurrent();
  let groups=[]; if(await clickFilter('group'))groups=await collectCurrent();
  await clickFilter('all');
  const groupNames=new Set(groups.map(x=>normalizedChatName(x.name)));
  const junk=/^(已归档|已封存|archived|archiviati|archivados|archivées)$/i;
  // Group write permission is checked immediately before sending. This keeps first-load scanning fast
  // and avoids opening dozens of chats merely to build the picker.
  return all.filter(x=>!junk.test(norm(x.name))).map(x=>({name:x.name,type:groupNames.has(normalizedChatName(x.name))?'group':'contact',canSend:groupNames.has(normalizedChatName(x.name))?null:true}));
}

function findSearchBox(){
  const candidates=[...document.querySelectorAll('input[placeholder],input[aria-label]'),...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(x=>visible(x)&&!x.closest('footer'));
  return candidates.find(x=>/(搜索|search|cerca|buscar|rechercher|suchen)/i.test(textOf(x)||x.getAttribute?.('placeholder')||''))||candidates[0]||null;
}
function normalizedChatName(v){return norm(v).toLocaleLowerCase().replace(/[\s\u00a0]+/g,' ').replace(/[·•]/g,'-').trim();}
function sameChatName(a,b){const x=normalizedChatName(a),y=normalizedChatName(b);return !!x&&!!y&&(x===y||x.replace(/\s/g,'')===y.replace(/\s/g,''));}
function findChatRow(name){
  const rows=[...new Set([...chatRows(),...[...document.querySelectorAll('[role="row"],[role="listitem"]')].filter(visible)])];
  return rows.find(r=>sameChatName(rowName(r),name))||null;
}
function fieldText(el){return norm(el?.value??el?.innerText??el?.textContent??'');}
function setFieldTextDom(el,text){
  if(!el)return false;
  try{
    el.focus({preventScroll:true});
    if(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement){
      const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set; if(setter)setter.call(el,String(text)); else el.value=String(text);
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:String(text)}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }else{
      const sel=window.getSelection();const range=document.createRange();range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range);
      document.execCommand('insertText',false,String(text));
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:String(text)}));
    }
    return fieldText(el).includes(norm(text))||norm(text).includes(fieldText(el));
  }catch{return false;}
}
async function setFieldText(requestId,el,text){
  if(!el)throw new Error('目标输入框不存在');
  try{el.scrollIntoView?.({block:'nearest'});}catch{}
  await requestNative(requestId,'click',{rect:rectOf(el)}).catch(()=>{});
  const raw=String(text??'');
  let ok=false;
  // For WhatsApp contenteditable fields use a real clipboard paste first. This preserves paragraphs/newlines.
  if(!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)){
    await requestNative(requestId,'clear').catch(()=>{});
    await requestNative(requestId,'paste',{text:raw}).catch(()=>{});
    await sleep(220);
    const got=fieldText(el);ok=got.includes(norm(raw))||norm(raw).includes(got);
  }
  if(!ok){ok=setFieldTextDom(el,raw);await sleep(140);}
  if(!ok){await requestNative(requestId,'clear').catch(()=>{});await requestNative(requestId,'paste',{text:raw}).catch(()=>{});await sleep(200);const got=fieldText(el);ok=got.includes(norm(raw))||norm(raw).includes(got);}
  return ok;
}
function activeChatTitleCandidates(){
  const h=document.querySelector('#main header'); if(!h)return [];
  const vals=[];
  for(const el of h.querySelectorAll('span[title],[title],[aria-label]')){
    if(!visible(el))continue;
    const v=norm(el.getAttribute?.('title')||el.getAttribute?.('aria-label')||'');
    if(v&&v.length<180)vals.push(v);
  }
  const first=norm((h.innerText||'').split(/\n/).filter(Boolean)[0]); if(first)vals.push(first);
  return [...new Set(vals)];
}
function activeChatMatches(name){return activeChatTitleCandidates().some(v=>sameChatName(v,name));}
async function waitForActiveChat(name, timeout=6000){const end=Date.now()+timeout;while(Date.now()<end){if(activeChatMatches(name))return true;await sleep(120);}return false;}
async function openChatForSend(requestId,name){
  if(await waitForActiveChat(name,250))return true;
  let row=findChatRow(name);
  if(row){
    try{row.scrollIntoView?.({block:'center'});}catch{}
    const exact=[...row.querySelectorAll('[title]')].find(x=>sameChatName(x.getAttribute('title'),name));
    const target=exact||row;
    try{target.click()}catch{}; if(await waitForActiveChat(name,2600))return true;
    await requestNative(requestId,'click',{rect:rectOf(target)}).catch(()=>{}); if(await waitForActiveChat(name,3000))return true;
  }
  const search=findSearchBox();if(!search)throw new Error('找不到 WhatsApp 搜索框');
  if(!await setFieldText(requestId,search,name))throw new Error(`无法在搜索框输入：${name}`);
  row=await waitFor(()=>findChatRow(name),9000,100);if(!row)throw new Error(`搜索后找不到聊天：${name}`);
  try{row.scrollIntoView?.({block:'center'});}catch{};
  const exact=[...row.querySelectorAll('[title]')].find(x=>sameChatName(x.getAttribute('title'),name));
  const target=exact||row;
  try{target.click()}catch{};
  if(!await waitForActiveChat(name,3000)){await requestNative(requestId,'click',{rect:rectOf(target)}).catch(()=>{});}
  if(!await waitForActiveChat(name,6500))throw new Error(`未能进入正确聊天：${name}（当前：${activeChatTitleCandidates().slice(0,3).join(' / ')||'未识别'}）`);
  await requestNative(requestId,'key',{keyCode:'ESCAPE'}).catch(()=>{});await sleep(140);
  return true;
}

let broadcastAbortRequested=false;
function assertBroadcastActive(){if(broadcastAbortRequested)throw new Error('群发已取消');}
async function sleepBroadcast(ms){const end=Date.now()+ms;while(Date.now()<end){assertBroadcastActive();await sleep(Math.min(180,end-Date.now()));}}
function composerText(){return norm(composer()?.innerText||composer()?.textContent||'');}
function latestOutgoingTexts(){const main=document.querySelector('#main');if(!main)return [];return [...main.querySelectorAll('[data-testid="msg-container"],div.message-out')].slice(-8).map(x=>norm(x.innerText||x.textContent||'')).filter(Boolean);}
function outgoingCount(){const main=document.querySelector('#main');return main?[...main.querySelectorAll('[data-testid="msg-container"] .message-out,div.message-out')].length:0;}
function findSendButton(scope=document){return [...scope.querySelectorAll('button,[role="button"]')].filter(visible).find(x=>/(发送|send|invia|enviar)/i.test(textOf(x))||x.querySelector?.('[data-icon="send"]'))||null;}

async function sendTextToCurrentChat(requestId,message){
  assertBroadcastActive();
  const box=await waitFor(()=>{const x=composer();return x&&visible(x)?x:null;},7000,100);if(!box)throw new Error('找不到消息输入框');
  if(!await setFieldText(requestId,box,message))throw new Error('消息未能写入输入框');
  assertBroadcastActive();
  const before=latestOutgoingTexts();const beforeLen=before.length;const needle=norm(message).slice(0,Math.min(48,norm(message).length));
  const sendBtn=await waitFor(()=>findSendButton(document.querySelector('#main')||document),1800,70);
  if(sendBtn){
    // Exactly one logical send. DOM click first; native fallback only if the composer is still unchanged after 1.2s.
    const rect=rectOf(sendBtn);try{sendBtn.click()}catch{}
    const firstEnd=Date.now()+1200;let progressed=false;
    while(Date.now()<firstEnd){assertBroadcastActive();const now=latestOutgoingTexts();if(!composerText()||now.length>beforeLen){progressed=true;break;}await sleep(100);}
    if(!progressed&&composerText())await requestNative(requestId,'click',{rect}).catch(()=>{});
  }else{
    await requestNative(requestId,'key',{keyCode:'ENTER'}).catch(()=>{});
  }
  // Fast-path confirmation: the user's main complaint was that WhatsApp had already
  // sent the message while Hello Mike kept waiting before showing the final result.
  // If the composer clears after our single send action, treat that as immediate success.
  // A short settle window avoids reporting success on a transient repaint.
  const quickStart=Date.now(),quickEnd=quickStart+1200;
  let emptySince=0;
  while(Date.now()<quickEnd){
    assertBroadcastActive();
    const now=latestOutgoingTexts();
    if(now.length>beforeLen){
      const fresh=now.slice(beforeLen);const matches=needle?fresh.filter(x=>x.includes(needle)).length:fresh.length;
      if(matches>1)throw new Error('检测到同一条消息可能被重复发送，已停止当前群发');
      if(matches>=1)return true;
    }
    if(!composerText()){
      if(!emptySince)emptySince=Date.now();
      if(Date.now()-emptySince>=180)return true;
    }else emptySince=0;
    await sleep(60);
  }
  // Slow-path verification is deliberately short. It is only used when WhatsApp does not
  // expose the usual cleared-composer signal. This keeps the final result box responsive.
  const verifyStart=Date.now(),end=verifyStart+2200;
  while(Date.now()<end){
    assertBroadcastActive();
    const now=latestOutgoingTexts();
    if(now.length>beforeLen){
      const fresh=now.slice(beforeLen);const matches=needle?fresh.filter(x=>x.includes(needle)).length:fresh.length;
      if(matches>1)throw new Error('检测到同一条消息可能被重复发送，已停止当前群发');
      if(matches>=1)return true;
    }
    if(!composerText())return true;
    await sleep(90);
  }
  throw new Error('WhatsApp 未确认文字消息已发送');
}

function findMediaEditor(){
  const sendBtn=findSendButton(document);
  if(!sendBtn||!visible(sendBtn))return null;
  const media=[...document.querySelectorAll('img,canvas,video')].filter(x=>{if(!visible(x))return false;const r=x.getBoundingClientRect();return r.width>180&&r.height>180;});
  if(!media.length)return null;
  const caption=[...document.querySelectorAll('[contenteditable="true"][role="textbox"],[contenteditable="true"]')].filter(x=>visible(x)&&!x.closest('footer')).at(-1)||null;
  // Find a common visible ancestor containing the send button and a large media preview.
  let root=sendBtn;
  while(root&&root!==document.body){if(media.some(m=>root.contains(m))){return {root,sendBtn,caption,media:media[0]};}root=root.parentElement;}
  return {root:document.body,sendBtn,caption,media:media[0]};
}
async function sendImageAttachment(requestId,attachment,caption=''){
  if(!attachment?.path)throw new Error('图片文件路径无效');
  const box=await waitFor(()=>{const x=composer();return x&&visible(x)?x:null;},7000,100);if(!box)throw new Error('找不到消息输入框');
  assertBroadcastActive();
  await requestNative(requestId,'click',{rect:rectOf(box)}).catch(()=>{});try{box.focus()}catch{};await sleep(100);
  const before=latestOutgoingTexts().length;
  await requestNative(requestId,'pasteImage',{path:attachment.path});
  let editor=null;const openEnd=Date.now()+12000;
  while(Date.now()<openEnd&&!editor){assertBroadcastActive();editor=findMediaEditor();if(!editor)await sleep(140);}
  if(!editor)throw new Error('图片已粘贴，但未识别到 WhatsApp 图片编辑器');
  if(caption){
    const cap=editor.caption||[...document.querySelectorAll('[contenteditable="true"][role="textbox"],[contenteditable="true"]')].filter(x=>visible(x)&&!x.closest('footer')).at(-1);
    if(!cap)throw new Error('图片编辑器已打开，但找不到说明文字输入框');
    if(!await setFieldText(requestId,cap,caption))throw new Error('图片说明文字写入失败');
  }
  assertBroadcastActive();
  // Click once and wait for the editor to disappear. Native fallback is used only if the same editor is still present.
  const sendRect=rectOf(editor.sendBtn);try{editor.sendBtn.click()}catch{}
  let closeEnd=Date.now()+1800;while(Date.now()<closeEnd&&findMediaEditor()){assertBroadcastActive();await sleep(120);}
  if(findMediaEditor()){await requestNative(requestId,'click',{rect:sendRect}).catch(()=>{});}
  // The media editor closing and the normal composer returning is WhatsApp's strongest
  // immediate UI acknowledgement. Do not keep the user waiting several seconds after the
  // image is already visible in the chat.
  const verifyStart=Date.now();closeEnd=verifyStart+2200;let closedSince=0;
  while(Date.now()<closeEnd){
    assertBroadcastActive();
    const editorNow=findMediaEditor();
    if(!editorNow&&latestOutgoingTexts().length>before)return true;
    if(!editorNow&&composer()&&visible(composer())){
      if(!closedSince)closedSince=Date.now();
      if(Date.now()-closedSince>=220)return true;
    }else closedSince=0;
    await sleep(70);
  }
  throw new Error('图片发送后未得到 WhatsApp 成功确认');
}

function currentSendPermission(){
  const main=document.querySelector('#main');const txt=norm(main?.innerText||'');
  const denied=/(只有管理员可以发送|仅管理员可以发送|只有管理員可以傳送|you can.?t send messages|only admins can send|only administrators can send|solo gli amministratori possono inviare|non puoi inviare messaggi|solo los administradores pueden enviar|apenas administradores podem enviar)/i.test(txt);
  if(denied)return {allowed:false,reason:'该群组当前账号没有发言权限'};
  const box=composer();return box&&visible(box)?{allowed:true}:{allowed:null,reason:'未检测到消息输入框'};
}

async function sendMessage(requestId,payload){
  const name=String(payload.name||'').trim();
  const message=String(payload.message||'');

  const attachments=Array.isArray(payload.attachments)
    ? payload.attachments.filter(x=>x&&x.path)
    : (payload.attachment?.path ? [payload.attachment] : []);

  if(!name||(!message&&!attachments.length))throw new Error('联系人或消息为空');

  alog('群发',`准备发送给 ${name}`);
  await openChatForSend(requestId,name);

  const perm=currentSendPermission();
  if(perm.allowed===false)throw new Error(perm.reason);
  if(perm.allowed===null)throw new Error(perm.reason);

  if(attachments.length){
    for(let i=0;i<attachments.length;i++){
      assertBroadcastActive();
      await sendImageAttachment(
        requestId,
        attachments[i],
        i===0 ? message : ''
      );
      if(i<attachments.length-1){
        await sleepBroadcast(450);
      }
    }
  }else{
    await sendTextToCurrentChat(requestId,message);
  }

  alog('群发',`${name} 已发送并验证`);
  return {ok:true,name,verified:true,images:attachments.length};
}
async function sendBatch(requestId,payload){
  const targets=Array.isArray(payload.targets)?payload.targets.filter(x=>x&&x.name):[];
  if(!targets.length)throw new Error('没有可发送的联系人或群组');
  const min=Math.max(3,Number(payload.intervalMin||10)),max=Math.max(min,Number(payload.intervalMax||20));
  const results=[];broadcastAbortRequested=false;
  for(let i=0;i<targets.length;i++){
    if(broadcastAbortRequested)break;
    const t=targets[i],name=String(t.name||'').trim();
    send({type:'broadcast-progress',requestId,index:i+1,total:targets.length,name,state:'sending'});
    try{
      const r=await sendMessage(requestId,{name,message:payload.message||'',attachment:payload.attachment||null,attachments:Array.isArray(payload.attachments)?payload.attachments:null});
      results.push({name,ok:true,data:r});send({type:'broadcast-progress',requestId,index:i+1,total:targets.length,name,state:'sent'});
    }catch(e){
      const error=String(e?.message||e);
      if(/群发已取消/.test(error)){broadcastAbortRequested=true;break;}
      results.push({name,ok:false,error});send({type:'broadcast-progress',requestId,index:i+1,total:targets.length,name,state:'failed',error});
    }
    if(i<targets.length-1&&!broadcastAbortRequested){const ms=Math.round((min+Math.random()*(max-min))*1000);send({type:'broadcast-progress',requestId,index:i+1,total:targets.length,name,state:'waiting',waitMs:ms});await sleepBroadcast(ms);}
  }
  const cancelled=broadcastAbortRequested;broadcastAbortRequested=false;
  return {results,sent:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,cancelled};
}

async function checkGroupPermission(requestId,name){
  const prev=activeChatTitle();
  await openChatForSend(requestId,name);