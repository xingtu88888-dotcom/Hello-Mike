const $ = id => document.getElementById(id);
let profiles = [];
let activeProfileId = '';
let localAuth = {needsSetup:true,loggedIn:false,user:null,users:[]};
let authMode = 'login';
const ipCache = new Map();
const healthCache = new Map();
const inlineTranslationCache = new Map();

const LANG_NAMES={AUTO:'自动识别',ZH:'中文（简体）',EN:'英语',IT:'意大利语',JA:'日语',KO:'韩语'};
function langName(code){return LANG_NAMES[code]||code||'';}
let __modalHiddenViews=[];
function openDialog(){
  // Electron <webview> is a native guest surface. On Windows it can intercept mouse/keyboard
  // even when a host DOM modal is visually above it. Hide guest surfaces while editing.
  __modalHiddenViews=[];
  for(const item of embeddedViews.values()){
    const el=item?.el; if(!el)continue;
    __modalHiddenViews.push([el,el.style.display,el.style.visibility,el.style.pointerEvents]);
    el.style.visibility='hidden'; el.style.pointerEvents='none';
  }
  const d=$('dlg');
  d.classList.add('open');d.setAttribute('aria-hidden','false');
  // Explicitly restore editable controls; proxyToggleChanged will disable only proxy fields when off.
  ['name','service','url','profileSource','profileTarget','sendTranslate','receiveTranslate','blockChinese','useProxy'].forEach(id=>{const el=$(id);if(el)el.disabled=false;});
  proxyToggleChanged();
  setTimeout(()=>{const n=$('name'); if(n){n.disabled=false;n.readOnly=false;n.focus();n.select?.();}},40);
}
function closeDialog(){
  const d=$('dlg');d.classList.remove('open');d.setAttribute('aria-hidden','true');
  for(const [el,display,visibility,pointerEvents] of __modalHiddenViews){
    if(!el?.isConnected)continue; el.style.display=display;el.style.visibility=visibility;el.style.pointerEvents=pointerEvents;
  }
  __modalHiddenViews=[];
  // Ensure only the active account is visible after restoring.
  for(const [id,item] of embeddedViews){
    if(!item?.el)continue;
    normalizeEmbeddedViewSurface(item,id===activeChatId);
  }
}
function proxyToggleChanged(){
  const on=$('useProxy').checked;
  $('proxyEditor').classList.toggle('disabled',!on);
  ['proxyType','host','port','username','password','clearPassword','testProxy'].forEach(id=>{const el=$(id);if(el)el.disabled=!on;});
  if(!on)$('proxyStatus').textContent='';
}

function esc(s) { return String(s || '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function serviceName(p){ return p.service === 'whatsapp' ? 'WhatsApp Web' : p.service === 'line' ? 'LINE / Chrome' : 'Custom Web'; }



async function translateInlineForProfile(profileId,text,targetOverride,direction='incoming',context=[]){
  const p=profiles.find(x=>x.id===profileId); if(!p)return '';
  const textNorm=String(text||'').trim(); if(!textNorm)return '';
  const target=targetOverride||p.translation?.target||'ZH';
  const contextKey=(Array.isArray(context)?context:[]).slice(-6).map(x=>`${x.direction||''}:${x.text||''}`).join('|');
  const key=`google|${target}|${textNorm}`;
  if(inlineTranslationCache.has(key))return inlineTranslationCache.get(key);
  try{
    const out=await api.translate({provider:'google',source:'AUTO',target,text:textNorm});
    inlineTranslationCache.set(key,out||'');return out||'';
  }catch(e){console.warn('Google inline translation failed',e);throw e;}
}

// v0.7.3 single-window chat workspace.
// v0.8 reliability strategy: lazy-create each account once and keep it alive.
// We no longer auto-destroy warm accounts because repeated guest recreation caused intermittent account failures.
const WEBVIEW_WARM_LIMIT = Number.POSITIVE_INFINITY;
const embeddedViews = new Map();
const adapterByProfile = new Map();
let activeChatId = '';

function setChatStatus(title='', text='', show=true){
  const box=$('chatStatusOverlay'); if(!box)return;
  $('chatStatusTitle').textContent=title; $('chatStatusText').textContent=text||'';
  box.classList.toggle('hidden',!show);
}
function setBroadcastCancelVisible(show){ const box=$('chatStatusOverlay'), b=$('chatStatusCancelBroadcast'); if(!box||!b)return; b.style.display=show?'inline-flex':'none'; box.classList.toggle('cancellable',!!show); if(!show){b.disabled=false;b.textContent='停止群发';} }
function renderChatAccounts(){
  const host=$('chatAccountList'); if(!host)return;
  host.innerHTML=profiles.length?profiles.map(p=>{
    const active=activeChatId===p.id?' active':'';
    const proxied=p.proxy?.type&&p.proxy.type!=='none';
    const ico=p.service==='whatsapp'?'W':p.service==='line'?'L':'↗';
    return `<button class="chatAccount${active}" draggable="true" data-profile-id="${p.id}" onclick="openP('${p.id}')"><span class="railIcon ${p.service}">${ico}</span><span class="railText"><b>${esc(p.name)}</b><small>${proxied?'独立代理':'直连'} · ${p.guard?.blockChinese?'中文保护 ON':'中文保护 OFF'}</small></span><i class="railState"></i></button>`;
  }).join(''):'<div class="chatRailEmpty">还没有账号。点击右上角添加。</div>';
  let dragging='';
  host.querySelectorAll('.chatAccount').forEach(card=>{
    card.addEventListener('dragstart',e=>{dragging=card.dataset.profileId||'';card.classList.add('dragging');e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',dragging)}catch{}});
    card.addEventListener('dragend',()=>{dragging='';host.querySelectorAll('.chatAccount').forEach(x=>x.classList.remove('dragging','dragOver'));});
    card.addEventListener('dragover',e=>{e.preventDefault();if(dragging&&dragging!==card.dataset.profileId)card.classList.add('dragOver');});
    card.addEventListener('dragleave',()=>card.classList.remove('dragOver'));
    card.addEventListener('drop',async e=>{
      e.preventDefault();card.classList.remove('dragOver');
      const from=dragging||e.dataTransfer.getData('text/plain'),to=card.dataset.profileId;if(!from||!to||from===to)return;
      const ids=profiles.map(x=>x.id),a=ids.indexOf(from),b=ids.indexOf(to);if(a<0||b<0)return;
      ids.splice(a,1);ids.splice(b,0,from);
      try{profiles=await api.reorderProfiles(ids);renderV07();}catch(err){alert('账号排序保存失败：'+err.message);}
    });
  });
}
function updateChatToolbar(profile, prep){
  if(!profile)return;
  $('chatActiveName').textContent=profile.name;
  $('chatRoute').textContent=`${serviceName(profile)} · ${prep?.route||'正在准备网络…'}`;
  $('chatServiceDot').className=`serviceDot ${profile.service||''}`;
}
function hideAllEmbedded(){ for(const item of embeddedViews.values()) item.el.style.display='none'; }
function hibernateView(id){
  const item=embeddedViews.get(id); if(!item)return;
  try{ item.ro?.disconnect?.(); }catch{}
  try{ adapterByProfile.get(id)?.dispose?.(); }catch{}
  adapterByProfile.delete(id);
  try{ item.el.remove(); }catch{}
  embeddedViews.delete(id);
}
function trimWarmViews(){ /* v0.8 stable mode: never auto-destroy account webviews */ }
async function installChineseGuard(wv){
  try{
    await wv.executeJavaScript(`(() => {
      if(window.__helloMikeChineseGuardInstalled)return true;
      window.__helloMikeChineseGuardInstalled=true;
      const han=/[\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF]/u;
      const composer=()=>document.querySelector('footer [contenteditable="true"][role="textbox"]')||document.querySelector('footer [contenteditable="true"]');
      const txt=el=>(el?.innerText||el?.textContent||'').trim();
      const warn=()=>{let n=document.getElementById('__hm_guard');if(!n){n=document.createElement('div');n.id='__hm_guard';Object.assign(n.style,{position:'fixed',left:'50%',bottom:'90px',transform:'translateX(-50%)',zIndex:'2147483647',background:'#b42318',color:'#fff',padding:'11px 17px',borderRadius:'10px',font:'600 14px system-ui',boxShadow:'0 8px 30px #0007'});document.body.appendChild(n)}n.textContent='已阻止发送：消息中包含中文，请先翻译。';n.style.display='block';clearTimeout(window.__hmgt);window.__hmgt=setTimeout(()=>n.style.display='none',2600)};
      const block=()=>han.test(txt(composer()));
      document.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&block()){e.preventDefault();e.stopImmediatePropagation();warn()}},true);
      document.addEventListener('click',e=>{const b=e.target?.closest?.('button,[role="button"]');if(!b)return;const a=(b.getAttribute('aria-label')||'').toLowerCase();const send=a.includes('send')||!!b.querySelector('[data-icon="send"]');if(send&&block()){e.preventDefault();e.stopImmediatePropagation();warn()}},true);
      return true;
    })()`);
  }catch{}
}
async function installChatNotes(wv, profileId){
  try{
    const backup = await api.getNoteBackup(profileId).catch(()=>({}));
    await wv.executeJavaScript(`(() => {
      if(window.__helloMikeNotesInstalled){ window.__hmRefreshNotes?.(); return true; }
      window.__helloMikeNotesInstalled=true;
      const KEY='__hello_mike_chat_notes_v1';
      const backup=${JSON.stringify(backup || {})};
      const load=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch{return {}}};
      const save=o=>{try{localStorage.setItem(KEY,JSON.stringify(o))}catch{}};
      try{const local=load();save({...backup,...local})}catch{};
      const normalize=s=>(s||'').replace(/\s+/g,' ').trim();
      const getName=row=>{
        const titles=[...row.querySelectorAll('span[title],[title]')].map(x=>normalize(x.getAttribute('title'))).filter(x=>x&&x.length<120);
        if(titles.length)return titles[0];
        const text=(row.innerText||'').split(/\n/).map(normalize).filter(Boolean);
        return (text[0]||'').slice(0,120);
      };
      const rows=()=>{
        const root=document.querySelector('#pane-side'); if(!root)return [];
        const frames=[...root.querySelectorAll('[data-testid="cell-frame-container"]')];
        const arr=frames.length?frames.map(f=>f.closest('[role="row"],[role="listitem"]')||f.parentElement?.parentElement||f):[...root.querySelectorAll('[role="row"],[role="listitem"]')];
        return [...new Set(arr)].filter(Boolean);
      };
      if(!document.getElementById('__hm_note_style')){
        const style=document.createElement('style');style.id='__hm_note_style';style.textContent='.__hm_note_wrap{position:absolute;left:68px;right:78px;top:33px;z-index:9999;display:flex;align-items:center;pointer-events:none;min-width:0}'+
          '.__hm_note_chip{pointer-events:auto;border:0;background:transparent;color:#ff2525;font:700 12px/1.22 system-ui;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;padding:1px 4px;border-radius:4px;text-align:left}'+
          '.__hm_note_chip[data-empty="1"]{margin-left:auto;color:#8fa1b8;opacity:.32;font-weight:600;max-width:58px}'+
          '.__hm_note_chip:hover{background:#f2f4f7;opacity:1}';document.head.appendChild(style);
      }
      const refresh=()=>{
        const notes=load();
        for(const chip of document.querySelectorAll('.__hm_note_chip')){
          const name=chip.dataset.hmChatName||'';const v=notes[name]||'';
          chip.textContent=v||'＋备注';chip.dataset.empty=v?'0':'1';chip.title=v?('本地备注：'+v):'添加本地备注';
        }
      };
      window.__hmRefreshNotes=refresh;
      const decorate=()=>{
        for(const row of rows()){
          const name=getName(row); if(!name)continue;
          let wrap=row.querySelector('.__hm_note_wrap'),chip=wrap?.querySelector('.__hm_note_chip');
          if(!wrap){
            const cs=getComputedStyle(row); if(cs.position==='static')row.style.position='relative';
            wrap=document.createElement('span');wrap.className='__hm_note_wrap';
            chip=document.createElement('button');chip.type='button';chip.className='__hm_note_chip';
            chip.setAttribute('aria-label','编辑备注');
            wrap.appendChild(chip);row.appendChild(wrap);
          }
          chip.dataset.hmChatName=name;
        }
        refresh();
      };
      let raf=0;const schedule=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(decorate)};
      const obs=new MutationObserver(schedule);obs.observe(document.documentElement,{subtree:true,childList:true});
      window.addEventListener('scroll',schedule,true);decorate();setInterval(decorate,1800);
      return true;
    })()`);
    if(!wv.__hmNoteBackupTimer){
      const sync=async()=>{try{const notes=await wv.executeJavaScript(`(()=>{try{return JSON.parse(localStorage.getItem('__hello_mike_chat_notes_v1')||'{}')}catch{return {}}})()`);await api.saveNoteBackup(profileId,notes||{});}catch{}};
      wv.__hmNoteBackupTimer=setInterval(sync,5000);
      wv.addEventListener('destroyed',()=>{try{clearInterval(wv.__hmNoteBackupTimer)}catch{}},{once:true});
      setTimeout(sync,900);
    }
  }catch{}
}

async function getActiveChatTitle(wv, profileId=activeChatId){
  try{const a=adapterByProfile.get(profileId);if(a){const r=await a.command('activeChat',{},5000);return r?.title||'';}}catch{}
  return '';
}

let noteEditorTarget=null;
function closeNoteEditor(){ $('noteDlg')?.classList.remove('open');$('noteDlg')?.setAttribute('aria-hidden','true');noteEditorTarget=null; }
async function openNoteEditor(profileId, chatName, wv=null){
  const p=profiles.find(x=>x.id===profileId);if(!p||!chatName)return;
  const notes=await api.getNoteBackup(profileId).catch(()=>({}));
  noteEditorTarget={profileId,chatName,wv};
  $('noteChatName').textContent=chatName;$('noteText').value=notes[chatName]||'';
  $('noteDlg').classList.add('open');$('noteDlg').setAttribute('aria-hidden','false');setTimeout(()=>$('noteText')?.focus(),30);
}
async function saveNoteEditor(clear=false){
  const t=noteEditorTarget;if(!t)return;
  const notes=await api.getNoteBackup(t.profileId).catch(()=>({}));const value=clear?'':$('noteText').value.trim();
  if(value)notes[t.chatName]=value;else delete notes[t.chatName];
  await api.saveNoteBackup(t.profileId,notes);
  try{await adapterByProfile.get(t.profileId)?.command('syncNotes',{notes},5000);}catch{}
  closeNoteEditor();
}

async function editCurrentChatNote(){
  const p=profiles.find(x=>x.id===activeChatId); if(!p||p.service!=='whatsapp')return alert('请先选择一个 WhatsApp 账号。');
  const item=await ensureEmbeddedView(p,true);const title=await getActiveChatTitle(item.el,p.id);
  if(!title)return alert('请先在 WhatsApp 中打开一个具体聊天，再添加备注。');
  await openNoteEditor(p.id,title,item.el);
}

function nativeClick(wv, rect, button='left'){
  if(!wv||!rect)return false;
  const x=Math.max(1,Math.floor(rect.x+rect.width/2));
  const y=Math.max(1,Math.floor(rect.y+rect.height/2));
  try{
    wv.focus();
    wv.sendInputEvent({type:'mouseMove',x,y});
    wv.sendInputEvent({type:'mouseDown',x,y,button,clickCount:1});
    wv.sendInputEvent({type:'mouseUp',x,y,button,clickCount:1});
    return true;
  }catch{return false;}
}
function nativeKey(wv,keyCode,modifiers=[]){
  try{
    wv.focus();
    wv.sendInputEvent({type:'keyDown',keyCode,modifiers});
    wv.sendInputEvent({type:'keyUp',keyCode,modifiers});
    return true;
  }catch{return false;}
}
async function nativePaste(wv,text){
  await api.setClipboardText(String(text??''));
  await new Promise(r=>setTimeout(r,60));
  nativeKey(wv,'V',['control']);
  await new Promise(r=>setTimeout(r,90));
}
async function nativePasteImage(wv,filePath){
  await api.setClipboardImagePath(String(filePath||''));
  await new Promise(r=>setTimeout(r,100));
  nativeKey(wv,'V',['control']);
  await new Promise(r=>setTimeout(r,180));
}
async function clearFocusedField(wv){
  nativeKey(wv,'A',['control']);
  await new Promise(r=>setTimeout(r,25));
  nativeKey(wv,'Backspace');
  await new Promise(r=>setTimeout(r,60));
}
async function queryRect(wv, js){
  try{return await wv.executeJavaScript(`(()=>{const el=(${js});if(!el)return null;const r=el.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height,text:(el.innerText||el.textContent||'').trim()}})()`);}catch{return null;}
}

async function createEmbeddedView(profile, prep, visible=true){
  const stage=$('chatStage');
  const wv=document.createElement('webview');
  wv.className='accountWebview';
  // Partition and UA must be set before src so every account keeps its own persistent session.
  wv.setAttribute('partition',prep.partition);
  wv.setAttribute('useragent',prep.userAgent);
  wv.setAttribute('allowpopups','true');
  wv.setAttribute('webpreferences','contextIsolation=yes,sandbox=yes');
  if(prep.guestPreload)wv.setAttribute('preload',prep.guestPreload);
  wv.style.display=visible?'flex':'none';
  const fit=()=>{
    const r=stage.getBoundingClientRect();
    if(r.width>0&&r.height>0){wv.style.width=Math.floor(r.width)+'px';wv.style.height=Math.floor(r.height)+'px';}
  };
  const ro=new ResizeObserver(()=>requestAnimationFrame(fit)); ro.observe(stage);
  wv.__hmResizeObserver=ro;
  const adapter = new window.WhatsAppAdapterHost(wv, profile.id, {
    nativeClick, nativeKey, nativePaste, nativePasteImage, clearFocusedField, openNoteEditor,
    getNotes: id => api.getNoteBackup(id),
    translateText: (profileId, text, target, direction, context) => translateInlineForProfile(profileId, text, target, direction, context),
    broadcastProgress: (profileId, msg) => {
      if(profileId!==activeChatId)return;
      const label=msg.state==='sent'?'已发送':msg.state==='failed'?'发送失败':msg.state==='waiting'?'等待下一条':'正在发送';
      const extra=msg.state==='waiting'&&msg.waitMs?` · ${Math.round(msg.waitMs/1000)} 秒后继续`:msg.error?` · ${msg.error}`:'';
      setChatStatus('WhatsApp 群发执行中…',`${msg.index||0}/${msg.total||0} · ${msg.name||''} · ${label}${extra}`,true); setBroadcastCancelVisible(true);
    },
    log: (profileId, message) => { console.debug('[WhatsAppAdapter]', profile.name, message); if(profileId===activeChatId&&message) setChatStatus('WhatsApp 正在执行…',message,true); }
  });
  adapterByProfile.set(profile.id, adapter);
  wv.addEventListener('did-start-loading',()=>{ if(activeChatId===profile.id)setChatStatus('正在连接 WhatsApp…',prep.route,true); });
  wv.addEventListener('did-stop-loading',async()=>{
    if(activeChatId===profile.id)setChatStatus('', '', false); setTimeout(fit,50);
    try{const item=embeddedViews.get(profile.id);if(item)item.lastHealthy=Date.now();}catch{}
  });
  wv.addEventListener('did-fail-load',e=>{
    if(e.errorCode===-3)return;
    wv.__hmFailCount=(wv.__hmFailCount||0)+1;
    const item=embeddedViews.get(profile.id);if(item)item.lastError=`${e.errorDescription||'网络错误'} (${e.errorCode})`;
    if(activeChatId===profile.id)setChatStatus('页面加载失败',`${e.errorDescription||'网络错误'} (${e.errorCode}) · ${prep.route}`,true);
    if(wv.__hmFailCount===1){setTimeout(()=>{try{wv.reload()}catch{}},1200);}
    else if(activeChatId===profile.id){setChatStatus('账号页面加载失败','已停止自动重建，避免破坏稳定会话。请点击“刷新”；若渲染进程真正崩溃，Hello Mike 才会重建页面。',true);}
  });
  wv.addEventListener('render-process-gone',()=>{
    const item=embeddedViews.get(profile.id);if(item)item.broken=true;
    if(activeChatId===profile.id){setChatStatus('账号页面异常退出','正在自动重建页面；登录数据不会清除。',true);setTimeout(()=>recoverProfileView(profile.id,'渲染进程异常'),700);}
  });
  wv.addEventListener('unresponsive',()=>{if(activeChatId===profile.id)setTimeout(()=>recoverProfileView(profile.id,'页面无响应'),500);});
  wv.addEventListener('dom-ready',async()=>{
    fit(); wv.__hmFailCount=0;
    const item=embeddedViews.get(profile.id);if(item){item.broken=false;item.lastHealthy=Date.now();}
    try{
      const notes=await api.getNoteBackup(profile.id).catch(()=>({}));
      await adapter.command('configure',{blockChinese:!!prep.blockChinese,notes,translation:prep.translation||{}},8000);
    }catch(e){console.warn('Adapter configure failed',e);}
    try{
      await wv.executeJavaScript(`(()=>{document.documentElement.style.minHeight='100%';document.body.style.minHeight='100vh';const app=document.querySelector('#app');if(app){app.style.minHeight='100vh';app.style.height='100vh';}window.dispatchEvent(new Event('resize'));return true})()`);
      const info=await wv.executeJavaScript(`({text:(document.body?.innerText||'').slice(0,500),url:location.href})`);
      if(/WhatsApp.+Google Chrome|支持 Google Chrome|update Chrome/i.test(info.text||'')){
        const chromeTag=(prep.userAgent.split('Chrome/')[1]||'').split(' ')[0]; setChatStatus('WhatsApp 浏览器兼容提示',`Hello Mike 已使用 Chromium ${chromeTag} 的 Chrome 标识；如果仍出现此页，请点击“刷新”。`,true);
      }
    }catch{}
    // v0.12.5: QR loading is intentionally passive.
    // Do NOT reload, clear cache, close connections or rebuild the proxy automatically here.
    // WhatsApp may need time to establish its login WebSocket, especially through an authenticated proxy.
    // Automatic recovery attempts were able to interrupt that handshake and leave the QR placeholder spinning.
    setTimeout(async()=>{
      try{
        if(!wv.isConnected)return;
        const q=await wv.executeJavaScript(`(()=>{
          const logged=!!document.querySelector('#pane-side');
          const qr=!![...document.querySelectorAll('canvas,[data-ref],[data-testid*=qr i]')].find(el=>{
            const r=el.getBoundingClientRect();
            return r.width>=140 && r.height>=140;
          });
          return {logged,qr};
        })()`);
        if(!q.logged && !q.qr && activeChatId===profile.id){
          setChatStatus('WhatsApp 登录二维码仍在加载',`保持当前连接，不自动刷新 · ${prep.route}`,true);
        }
      }catch{}
    },30000);
  });
  stage.appendChild(wv);
  requestAnimationFrame(fit);
  embeddedViews.set(profile.id,{el:wv,lastUsed:Date.now(),lastHealthy:0,prep,profile,ro,broken:false,recovering:false});
  // src is deliberately assigned last. This avoids Chromium creating the guest with a wrong partition.
  wv.src=prep.target;
  trimWarmViews();
  return wv;
}

function waitForWebviewReady(wv, timeout=22000){
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=()=>{if(done)return;done=true;cleanup();resolve(true)};
    const fail=e=>{if(done||e?.errorCode===-3)return;done=true;cleanup();reject(new Error(e?.errorDescription||'页面加载失败'))};
    const cleanup=()=>{clearTimeout(t);wv.removeEventListener('dom-ready',finish);wv.removeEventListener('did-fail-load',fail)};
    const t=setTimeout(()=>{if(done)return;done=true;cleanup();reject(new Error('WhatsApp 页面加载超时'))},timeout);
    try{ if(wv.getURL&&String(wv.getURL()||'').startsWith('https://web.whatsapp.com')) return finish(); }catch{}
    wv.addEventListener('dom-ready',finish,{once:true});wv.addEventListener('did-fail-load',fail);
  });
}

async function probeEmbeddedView(item){
  if(!item?.el?.isConnected)return {ok:false,reason:'页面已销毁'};
  try{
    const r=await item.el.executeJavaScript(`(()=>({url:location.href,ready:document.readyState,html:(document.documentElement?.innerHTML||'').length,side:!!document.querySelector('#pane-side'),qr:/二维码|QR code|scan.*code/i.test((document.body?.innerText||'').slice(0,1200))}))()`);
    const url=String(r?.url||'');
    if(!url.startsWith('https://web.whatsapp.com'))return {ok:false,reason:'地址异常'};
    if(Number(r?.html||0)<500)return {ok:false,reason:'页面内容为空'};
    return {ok:true,...r};
  }catch(e){return {ok:false,reason:String(e.message||e)};}
}

function normalizeEmbeddedViewSurface(item,visible=true){
  const el=item?.el;
  if(!el)return;
  el.style.display=visible?'flex':'none';
  if(!visible)return;
  // Modal stacking can leave a guest webview technically alive but host-hidden.
  // Always restore all three host-side visibility properties before an action.
  el.style.visibility='visible';
  el.style.pointerEvents='auto';
  try{el.focus();}catch{}
  requestAnimationFrame(()=>{
    try{
      const stage=$('chatStage');
      const r=stage?.getBoundingClientRect?.();
      if(r&&r.width>0&&r.height>0){
        el.style.width=Math.floor(r.width)+'px';
        el.style.height=Math.floor(r.height)+'px';
      }
      window.dispatchEvent(new Event('resize'));
      el.executeJavaScript?.(`(()=>{window.dispatchEvent(new Event('resize'));return true})()`).catch?.(()=>{});
    }catch{}
  });
}

async function ensureWhatsAppHealthyForAction(p,item,label='操作'){
  if(!item?.el?.isConnected){
    item=await ensureEmbeddedView(p,true);
  }

  normalizeEmbeddedViewSurface(item,true);
  await waitForWebviewReady(item.el,24000).catch(()=>{});

  let health=await probeEmbeddedView(item);
  if(!health.ok){
    setChatStatus('正在恢复 WhatsApp 页面…',`${label}前检测：${health.reason||'页面异常'}`,true);
    item=await recoverProfileView(p.id,`${label}前检测：${health.reason||'页面异常'}`);
    if(!item?.el)throw new Error('WhatsApp 页面恢复失败。');
    normalizeEmbeddedViewSurface(item,true);
    await waitForWebviewReady(item.el,24000).catch(()=>{});
    health=await probeEmbeddedView(item);
  }

  if(!health.ok){
    throw new Error(`WhatsApp 页面异常：${health.reason||'页面不可用'}`);
  }

  let state=await waitForWhatsAppState(item.el,14000);
  if(state.loggedIn===false){
    throw new Error('WhatsApp 当前处于登录二维码页面，已停止本次发送。');
  }

  // A normal URL with a populated shell can still be a stuck/white WhatsApp renderer.
  // Rebuild the guest once, keeping the same persistent partition and login data.
  if(state.loggedIn!==true){
    setChatStatus('正在恢复 WhatsApp 页面…',`${label}前聊天列表未就绪，正在重建页面。`,true);
    item=await recoverProfileView(p.id,`${label}前聊天列表未就绪`);
    if(!item?.el)throw new Error('WhatsApp 页面恢复失败。');
    normalizeEmbeddedViewSurface(item,true);
    await waitForWebviewReady(item.el,24000).catch(()=>{});
    health=await probeEmbeddedView(item);
    if(!health.ok)throw new Error(`WhatsApp 页面异常：${health.reason||'页面不可用'}`);
    state=await waitForWhatsAppState(item.el,16000);
  }

  if(state.loggedIn===false){
    throw new Error('WhatsApp 当前处于登录二维码页面，已停止本次发送。');
  }
  if(state.loggedIn!==true){
    throw new Error('WhatsApp 聊天列表未就绪，已停止本次发送；请检查网络/代理或手动刷新该账号。');
  }

  normalizeEmbeddedViewSurface(item,true);
  return item;
}

async function recoverProfileView(id, reason='自动恢复'){
  const p=profiles.find(x=>x.id===id);if(!p)return null;
  const old=embeddedViews.get(id);if(old?.recovering)return old;
  if(old)old.recovering=true;
  if(activeChatId===id)setChatStatus('正在恢复账号页面…',`${p.name} · ${reason} · 保留原登录会话`,true);
  hibernateView(id);
  await new Promise(r=>setTimeout(r,220));
  const prep=await api.prepareEmbeddedProfile(id);
  const el=await createEmbeddedView(p,prep,activeChatId===id);
  try{await waitForWebviewReady(el,24000);}catch{}
  const item=embeddedViews.get(id);if(item)item.recovering=false;
  if(activeChatId===id)setTimeout(()=>setChatStatus('', '', false),500);
  return item;
}

async function ensureEmbeddedView(profile, visible=false){
  let item=embeddedViews.get(profile.id);
  if(item&&item.el?.isConnected&&!item.broken){item.lastUsed=Date.now();item.el.style.display=visible?'flex':'none';return item;}
  if(item?.broken)return await recoverProfileView(profile.id,'渲染进程异常');
  const prep=await api.prepareEmbeddedProfile(profile.id);
  const el=await createEmbeddedView(profile,prep,visible);
  try{await waitForWebviewReady(el);}catch{}
  return embeddedViews.get(profile.id);
}

async function waitForWhatsAppState(wv, timeout=14000){
  const started=Date.now();
  while(Date.now()-started<timeout){
    try{
      const r=await wv.executeJavaScript(`(()=>({side:!!document.querySelector('#pane-side'),qr:/扫描二维码|二维码|scan.*qr|link.*device|使用手机.*二维码/i.test((document.body?.innerText||'').slice(0,1600)),text:(document.body?.innerText||'').slice(0,300)}))()`);
      if(r.side)return {loggedIn:true};if(r.qr)return {loggedIn:false};
    }catch{}
    await new Promise(r=>setTimeout(r,500));
  }
  return {loggedIn:null};
}

async function markOneAccountRead(p,index,totalAccounts){
  activeChatId=p.id;renderChatAccounts();hideAllEmbedded();
  setChatStatus('正在执行全部已读…',`${index} / ${totalAccounts} · ${p.name} · WhatsApp Adapter`,true);
  const item=await ensureEmbeddedView(p,true);if(!item)throw new Error('账号页面无法创建');
  item.el.style.display='flex';try{item.el.focus()}catch{}
  const adapter=adapterByProfile.get(p.id);if(!adapter)throw new Error('WhatsApp Adapter 未初始化');
  const state=await adapter.command('status',{},10000);
  if(!state?.loggedIn)return {status:'skip',detail:'账号未登录或聊天列表未就绪'};
  const r=await adapter.command('markAllRead',{},15000);
  return {status:'ok',method:r?.method||'三点菜单 → 全标为已读',verified:!!r?.verified,before:r?.before,after:r?.after};
}

async function markAllReadAcrossAccounts(){
  const wa=profiles.filter(p=>p.service==='whatsapp');
  if(!wa.length){setChatStatus('没有 WhatsApp 账号','请先添加并登录 WhatsApp。',true);setTimeout(()=>setChatStatus('', '', false),2200);return;}
  const old=activeChatId,details=[];let ok=0,failed=0;
  const btn=$('markAllRead'); if(btn){btn.disabled=true;btn.dataset.oldText=btn.textContent;btn.textContent='处理中…';}
  try{
    for(let i=0;i<wa.length;i++){
      const p=wa[i];
      try{
        const r=await markOneAccountRead(p,i+1,wa.length);
        if(r.status==='ok'){ok++;details.push(`${p.name}: ${r.verified?'已完成':'已执行'}`);}else{failed++;details.push(`${p.name}: ${r.detail}`);}
      }catch(e){failed++;details.push(`${p.name}: ${String(e.message||e).slice(0,160)}`);}
    }
  }finally{
    hideAllEmbedded();
    if(old&&profiles.some(p=>p.id===old)){
      activeChatId=old;
      try{const p=profiles.find(x=>x.id===old),item=await ensureEmbeddedView(p,true);if(item)item.el.style.display='flex';}catch{}
    }
    renderChatAccounts();
    if(btn){btn.disabled=false;btn.textContent=btn.dataset.oldText||'✓ 全部已读';}
  }
  const title=failed?`全部已读完成：成功 ${ok}，失败 ${failed}`:`全部已读完成：${ok} 个账号`;
  setChatStatus(title,details.join(' · '),true);
  setTimeout(()=>setChatStatus('', '', false), failed?6500:2500);
}

/* Hello Mike Scheduled Send - Stage 2 */
let scheduledContactsCache=[];
let scheduledSelected=new Set();
let scheduledProfileId='';
let scheduledHiddenViews=[];
let scheduledImages=[];
let scheduledTasksCache=[];
let scheduledEditingTask=null;

let scheduledSchedulerBusy=false;
let scheduledCountdownTask=null;
let scheduledCountdownTimer=null;
let scheduledSending=false;
let scheduledSendingTaskId='';

function scheduledDateValue(d){
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function scheduledTimeValue(d){
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function scheduledDueMs(task){
  return new Date(`${task.date}T${task.time}:00`).getTime();
}
function updateScheduledLocalClock(){
  const el=$('scheduledLocalClock');
  if(el)el.textContent=new Date().toLocaleString();
}
setInterval(updateScheduledLocalClock,1000);

function hideViewsForScheduled(){
  scheduledHiddenViews=[];
  for(const [id,item] of embeddedViews){
    const el=item?.el;
    if(!el)continue;
    scheduledHiddenViews.push([
      el,
      el.style.display,
      el.style.visibility,
      el.style.pointerEvents
    ]);
    el.style.visibility='hidden';
    el.style.pointerEvents='none';
  }
}
function restoreViewsAfterScheduled(){
  for(const [el,display,visibility,pointerEvents] of scheduledHiddenViews){
    if(!el?.isConnected)continue;
    el.style.display=display;
    el.style.visibility=visibility;
    el.style.pointerEvents=pointerEvents;
  }
  scheduledHiddenViews=[];
  for(const [id,item] of embeddedViews){
    if(!item?.el)continue;
    normalizeEmbeddedViewSurface(item,id===activeChatId);
  }
}
function normalizedScheduledItems(){
  return scheduledContactsCache
    .map(x=>typeof x==='string'?{name:x,type:'contact'}:x)
    .filter(x=>x?.name);
}
function renderScheduledContacts(){
  const host=$('scheduledContactList');
  if(!host)return;

  const q=String($('scheduledSearch')?.value||'').trim().toLowerCase();

  const items=normalizedScheduledItems().filter(x=>
    !q||String(x.name||'').toLowerCase().includes(q)
  );

  host.innerHTML=items.length?items.map(x=>{
    const name=String(x.name||'');
    const blocked=x.canSend===false;

    return `<label class="contactPick${blocked?' blocked':''}">
      <input
        class="scheduledTargetCheck"
        type="checkbox"
        value="${esc(name)}"
        ${scheduledSelected.has(name)?'checked':''}
        ${blocked?'disabled':''}
      >
      <span>${esc(name)}</span>
      <span class="typeTag">${x.type==='group'?'群组':'好友'}</span>
    </label>`;
  }).join(''):'<div class="contactPickerEmpty">没有匹配的好友或群组。</div>';

  host.querySelectorAll('.scheduledTargetCheck').forEach(cb=>{
    cb.onchange=()=>{
      if(cb.checked)scheduledSelected.add(cb.value);
      else scheduledSelected.delete(cb.value);
      updateScheduledSelectedCount();
    };
  });

  updateScheduledSelectedCount();
}
function updateScheduledSelectedCount(){
  if($('scheduledSelectedCount')){
    $('scheduledSelectedCount').textContent=
      `已选择 ${scheduledSelected.size} 个聊天`;
  }
}
async function refreshScheduledContacts(){
  const p=profiles.find(x=>x.id===scheduledProfileId);
  if(!p)return;

  const oldId=activeChatId;
  const status=$('scheduledStatus');

  if(status)status.textContent='正在读取当前 WhatsApp 账号的好友与群组…';

  try{
    activeChatId=p.id;
    scheduledContactsCache=await collectExistingChats();
    broadcastCacheByProfile.set(p.id,scheduledContactsCache);

    renderScheduledContacts();

    const groups=normalizedScheduledItems().filter(x=>x.type==='group').length;

    if(status){
      status.textContent=
        `已读取 ${scheduledContactsCache.length} 个聊天：好友 ${scheduledContactsCache.length-groups}，群组 ${groups}。`;
    }
  }catch(e){
    if(status)status.textContent='读取失败：'+String(e?.message||e);
  }finally{
    activeChatId=oldId||p.id;
  }
}
function renderScheduledImages(){
  const el=$('scheduledImagesName');
  if(!el)return;

  if(!scheduledImages.length){
    el.textContent='未选择图片';
    return;
  }

  el.textContent=`已选择 ${scheduledImages.length} 张：`+
    scheduledImages.slice(0,3).map(x=>x.name).join('、')+
    (scheduledImages.length>3?'…':'');
}
async function pickScheduledImages(){
  try{
    scheduledImages=await api.pickScheduledImages();
    renderScheduledImages();
  }catch(e){
    alert('选择图片失败：'+String(e?.message||e));
  }
}
function clearScheduledImages(){
  scheduledImages=[];
  renderScheduledImages();
}
async function loadScheduledTasks(){
  try{
    scheduledTasksCache=await api.listScheduledTasks();
  }catch{
    scheduledTasksCache=[];
  }

  renderScheduledTaskList();
  updateScheduledButtonBadge();
  return scheduledTasksCache;
}
function scheduledStatusLabel(t){
  if(t.status==='missed')return '已错过';
  if(t.status==='sending')return '发送中';
  return '等待中';
}
function renderScheduledTaskList(){
  const host=$('scheduledTaskList');
  if(!host)return;

  const list=scheduledTasksCache.filter(t=>
    String(t.profileId||'')===String(scheduledProfileId||'')
  );

  if(!list.length){
    host.innerHTML='<div class="contactPickerEmpty">当前账号没有定时任务。</div>';
    return;
  }

  host.innerHTML=list.map(t=>{
    const images=Array.isArray(t.images)?t.images.length:0;
    const targets=Array.isArray(t.targets)?t.targets.length:0;
    const msg=String(t.message||'').replace(/\s+/g,' ').slice(0,42);

    return `<div class="scheduledTaskRow ${t.status==='missed'?'missed':''}">
      <div class="scheduledTaskMain">
        <b>${esc(t.date)} ${esc(t.time)}</b>
        <span>${targets} 个目标${images?` · ${images} 张图片`:''}${msg?` · ${esc(msg)}`:''}</span>
      </div>

      <div class="scheduledTaskState">${scheduledStatusLabel(t)}</div>

      <div class="scheduledTaskActions">
        ${t.status!=='sending'?`<button class="secondary miniBtn" data-edit-scheduled="${esc(t.id)}">编辑</button>`:''}
        ${t.status==='missed'?`<button class="secondary miniBtn" data-run-scheduled="${esc(t.id)}">立即发送</button>`:''}
        ${t.status!=='sending'?`<button class="secondary dangerSoft miniBtn" data-cancel-scheduled="${esc(t.id)}">取消</button>`:''}
      </div>
    </div>`;
  }).join('');

  host.querySelectorAll('[data-cancel-scheduled]').forEach(b=>{
    b.onclick=()=>cancelScheduledTaskById(b.dataset.cancelScheduled);
  });

  host.querySelectorAll('[data-run-scheduled]').forEach(b=>{
    b.onclick=()=>{
      const t=scheduledTasksCache.find(x=>x.id===b.dataset.runScheduled);
      if(t)executeScheduledTask(t,true);
    };
  });

  host.querySelectorAll('[data-edit-scheduled]').forEach(b=>{
    b.onclick=()=>{
      const t=scheduledTasksCache.find(x=>x.id===b.dataset.editScheduled);
      if(t)editScheduledTask(t);
    };
  });
}
function updateScheduledButtonBadge(){
  const b=$('scheduledSendBtn');
  if(!b)return;

  const n=scheduledTasksCache.filter(t=>
    String(t.profileId||'')===String(activeChatId||'') &&
    ['pending','missed','sending'].includes(t.status||'pending')
  ).length;

  b.textContent=n?`⏰ 定时发送 ${n}`:'⏰ 定时发送';
}
async function cancelScheduledTaskById(id){
  await api.deleteScheduledTask(id);
  if(scheduledEditingTask?.id===id)scheduledEditingTask=null;
  await loadScheduledTasks();
}
function editScheduledTask(task){
  scheduledEditingTask=task;

  $('scheduledDate').value=task.date||'';
  $('scheduledTime').value=task.time||'';
  $('scheduledMessage').value=task.message||'';

  scheduledSelected=new Set(
    Array.isArray(task.targets)?task.targets.map(x=>x.name):[]
  );

  scheduledImages=Array.isArray(task.images)?task.images.map(x=>({...x})):[];
  renderScheduledImages();
  renderScheduledContacts();

  $('createScheduledTask').textContent='保存修改';
  $('scheduledStatus').textContent='正在编辑现有任务；保存后旧任务会被新任务替换。';
}
async function openScheduledSendDialog(){
  const p=profiles.find(x=>x.id===activeChatId);

  if(!p||p.service!=='whatsapp'){
    return alert('请先在左侧打开一个 WhatsApp 账号。');
  }

  scheduledProfileId=p.id;
  scheduledSelected=new Set();
  scheduledImages=[];
  scheduledEditingTask=null;

  scheduledContactsCache=broadcastCacheByProfile.get(p.id)||[];

  $('scheduledAccountName').textContent=p.name;
  $('scheduledSearch').value='';
  $('scheduledMessage').value='';
  $('createScheduledTask').textContent='定时发送';

  const d=new Date(Date.now()+5*60*1000);
  $('scheduledDate').value=scheduledDateValue(d);
  $('scheduledTime').value=scheduledTimeValue(d);

  updateScheduledLocalClock();
  renderScheduledImages();
  renderScheduledContacts();
  await loadScheduledTasks();

  $('scheduledStatus').textContent=scheduledContactsCache.length
    ?`已使用当前账号缓存的 ${scheduledContactsCache.length} 个聊天；需要时可刷新。`
    :'点击“刷新列表”读取当前账号好友与群组。';

  $('scheduledSendDlg').classList.add('open');
  $('scheduledSendDlg').setAttribute('aria-hidden','false');
  hideViewsForScheduled();
}
function closeScheduledSendDialog(){
  $('scheduledSendDlg').classList.remove('open');
  $('scheduledSendDlg').setAttribute('aria-hidden','true');
  restoreViewsAfterScheduled();
}
async function createScheduledTask(){
  const p=profiles.find(x=>x.id===scheduledProfileId);
  if(!p)return;

  const date=String($('scheduledDate')?.value||'');
  const time=String($('scheduledTime')?.value||'');
  const when=new Date(`${date}T${time}:00`);

  if(!date||!time||Number.isNaN(when.getTime())){
    return alert('请选择正确的发送日期和时间。');
  }
  if(when.getTime()<=Date.now()){
    return alert('发送时间必须晚于电脑当前本地时间。');
  }
  if(!scheduledSelected.size){
    return alert('请至少选择 1 个好友或群组。');
  }
  if(scheduledSelected.size>50){
    return alert('单个任务最多选择 50 个聊天。');
  }

  const message=String($('scheduledMessage')?.value||'')
    .replace(/^\s+|\s+$/g,'');

  if(!message&&!scheduledImages.length){
    return alert('请填写文字或选择图片。');
  }

  if(
    message &&
    p.guard?.blockChinese &&
    /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(message)
  ){
    return alert('当前账号已开启“禁止中文”，内容中包含中文，已阻止创建任务。');
  }

  const byName=new Map(
    normalizedScheduledItems().map(x=>[x.name,x])
  );

  const oldTargets=new Map(
    (scheduledEditingTask?.targets||[]).map(x=>[x.name,x])
  );

  const targets=[...scheduledSelected].map(name=>({
    name,
    type:byName.get(name)?.type||oldTargets.get(name)?.type||'contact'
  }));

  const oldId=scheduledEditingTask?.id||'';

  try{
    await api.createScheduledTask({
      profileId:p.id,
      profileName:p.name,
      date,
      time,
      targets,
      message,
      images:scheduledImages,
      intervalMin:10,
      intervalMax:20
    });

    if(oldId){
      await api.deleteScheduledTask(oldId);
    }

    closeScheduledSendDialog();
    scheduledEditingTask=null;
    await loadScheduledTasks();

    setChatStatus(
      '定时任务已建立',
      `${p.name} · ${when.toLocaleString()} · ${targets.length} 个目标`,
      true
    );
    setTimeout(()=>setChatStatus('','',false),2500);

  }catch(e){
    alert('建立定时任务失败：'+String(e?.message||e));
  }
}
function closeScheduledCountdown(restore=true){
  if(scheduledCountdownTimer){
    clearInterval(scheduledCountdownTimer);
    scheduledCountdownTimer=null;
  }

  $('scheduledCountdownDlg')?.classList.remove('open');
  $('scheduledCountdownDlg')?.setAttribute('aria-hidden','true');

  scheduledCountdownTask=null;

  if(restore)restoreViewsAfterScheduled();
}
async function startScheduledCountdown(task){
  if(scheduledCountdownTask||scheduledSending)return;

  // Do not stack countdown/result or countdown/broadcast visibility snapshots.
  // A stacked snapshot can restore `visibility:hidden` and make the next send look white.
  if($('scheduledResultDlg')?.classList.contains('open')){
    closeScheduledResult();
  }
  if($('scheduledFromBroadcastLiteDlg')?.classList.contains('open')){
    closeScheduledFromBroadcastLite();
  }
  if($('broadcastDlg')?.classList.contains('open')){
    closeBroadcastDialog();
  }
  if($('scheduledSendDlg')?.classList.contains('open')){
    closeScheduledSendDialog();
  }

  scheduledCountdownTask=task;

  await api.showScheduledWindow().catch(()=>{});

  $('scheduledCountdownAccount').textContent=task.profileName||'';
  $('scheduledCountdownTargets').textContent=
    `${Array.isArray(task.targets)?task.targets.length:0} 个好友 / 群组`;

  $('scheduledCountdownDlg').classList.add('open');
  $('scheduledCountdownDlg').setAttribute('aria-hidden','false');

  hideViewsForScheduled();

  const paint=()=>{
    if(!scheduledCountdownTask)return;

    const left=Math.max(
      0,
      Math.ceil((scheduledDueMs(scheduledCountdownTask)-Date.now())/1000)
    );

    $('scheduledCountdownNumber').textContent=String(left);

    if(left<=0){
      const t=scheduledCountdownTask;
      closeScheduledCountdown(true);
      executeScheduledTask(t,false);
    }
  };

  paint();
  scheduledCountdownTimer=setInterval(paint,200);
}
async function cancelScheduledCountdown(){
  const t=scheduledCountdownTask;
  if(!t)return;

  await api.deleteScheduledTask(t.id).catch(()=>{});
  closeScheduledCountdown(true);
  await loadScheduledTasks();
}
function closeScheduledResult(){