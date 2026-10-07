const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  securityStatus: () => ipcRenderer.invoke('security:status'),
  authState: () => ipcRenderer.invoke('auth:state'),
  getRememberedLogin: () => ipcRenderer.invoke('auth:remembered'),
  registerLocalUser: (p) => ipcRenderer.invoke('auth:register', p),
  createLocalUser: (p) => ipcRenderer.invoke('auth:create-user', p),
  loginLocalUser: (p) => ipcRenderer.invoke('auth:login', p),
  logoutLocalUser: () => ipcRenderer.invoke('auth:logout'),
  updateLocalCredentials: (p) => ipcRenderer.invoke('auth:update-credentials', p),
  changePasswordFromLogin: (p) => ipcRenderer.invoke('auth:change-password-public', p),
  resetPasswordWithRecovery: (p) => ipcRenderer.invoke('auth:reset-password', p),
  rotateRecoveryKey: (p) => ipcRenderer.invoke('auth:rotate-recovery', p),
  listLocalUsers: () => ipcRenderer.invoke('auth:list-users'),
  deleteLocalUser: (id) => ipcRenderer.invoke('auth:delete-user', id),
  runSecurityScan: () => ipcRenderer.invoke('security:scan'),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (p) => ipcRenderer.invoke('profiles:save', p),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  reorderProfiles: (ids) => ipcRenderer.invoke('profiles:reorder', ids),
  openProfile: (id) => ipcRenderer.invoke('profiles:open', id),
  prepareEmbeddedProfile: (id) => ipcRenderer.invoke('profile:prepare-embedded', id),
  recoverWhatsAppLogin: (id) => ipcRenderer.invoke('profile:recover-login', id),
  testProxy: (p) => ipcRenderer.invoke('proxy:test', p),
  checkProfileIp: (id) => ipcRenderer.invoke('profile:ip', id),
  checkProfileHealth: (id) => ipcRenderer.invoke('profile:health', id),
  getNoteBackup: (id) => ipcRenderer.invoke('notes:get-backup', id),
  saveNoteBackup: (id, notes) => ipcRenderer.invoke('notes:save-backup', id, notes),
  saveTranslationPreset: (id, t) => ipcRenderer.invoke('profiles:translation', id, t),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveOpenAIKey: (key) => ipcRenderer.invoke('settings:openai-key', key),
  saveTranslationModel: (model) => ipcRenderer.invoke('settings:translation-model', model),
  translate: (cfg) => ipcRenderer.invoke('translate', cfg),
  copy: (t) => ipcRenderer.invoke('clipboard:set-text', t),
  getClipboardText: () => ipcRenderer.invoke('clipboard:get-text'),
  setClipboardText: (t) => ipcRenderer.invoke('clipboard:set-text', t),
  setClipboardImagePath: (filePath) => ipcRenderer.invoke('clipboard:set-image-path', filePath),
  pickBroadcastImage: () => ipcRenderer.invoke('broadcast:pick-image'),
  onTranslatorFill: (cb) => ipcRenderer.on('translator-fill', (_e, t) => cb(t))
});

// Updater methods are exposed only by the local host preload, never the guest preload.
contextBridge.exposeInMainWorld('hmUpdates', {
  getState: () => ipcRenderer.invoke('hm-updates:get-state'),
  check: () => ipcRenderer.invoke('hm-updates:check'),
  download: () => ipcRenderer.invoke('hm-updates:download'),
  install: () => ipcRenderer.invoke('hm-updates:install'),
  onState: callback => {
    const listener=(_event,state)=>callback(state);
    ipcRenderer.on('hm-updates:state',listener);
    return ()=>ipcRenderer.removeListener('hm-updates:state',listener);
  },
  onPrepareInstall: callback => {
    const listener=async (_event,msg)=>{
      let response={ok:false,code:'UPDATE_UI_NOT_READY'};
      try { response=await callback(); } catch {}
      ipcRenderer.send('hm-updates:prepared',{token:msg?.token,ok:response?.ok===true,code:response?.code});
    };
    ipcRenderer.on('hm-updates:prepare-install',listener);
    return ()=>ipcRenderer.removeListener('hm-updates:prepare-install',listener);
  },
  onResume: callback => {
    const listener=()=>callback();
    ipcRenderer.on('hm-updates:resume',listener);
    return ()=>ipcRenderer.removeListener('hm-updates:resume',listener);
  }
});