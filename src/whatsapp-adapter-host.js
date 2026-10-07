(() => {
  class WhatsAppAdapterHost {
    constructor(webview, profileId, helpers = {}) {
      this.webview = webview;
      this.profileId = profileId;
      this.helpers = helpers;
      this.pending = new Map();
      this.seq = 0;
      this.onIpc = this.onIpc.bind(this);
      webview.addEventListener('ipc-message', this.onIpc);
    }

    dispose() {
      try { this.webview.removeEventListener('ipc-message', this.onIpc); } catch {}
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('WhatsApp Adapter 已关闭'));
      }
      this.pending.clear();
    }

    async onIpc(event) {
      if (event.channel !== 'hm-adapter-event') return;
      const msg = event.args?.[0] || {};
      if (msg.type === 'result' && msg.requestId) {
        const p = this.pending.get(msg.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.requestId);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error || 'WhatsApp Adapter 执行失败'));
        return;
      }
      if (msg.type === 'native' && msg.requestId && msg.nativeId) {
        let ok = false, error = '';
        try {
          const action = msg.action;
          const payload = msg.payload || {};
          if (action === 'click') ok = !!this.helpers.nativeClick?.(this.webview, payload.rect, payload.button || 'left');
          else if (action === 'key') ok = !!this.helpers.nativeKey?.(this.webview, payload.keyCode, payload.modifiers || []);
          else if (action === 'paste') { await this.helpers.nativePaste?.(this.webview, payload.text || ''); ok = true; }
          else if (action === 'pasteImage') { await this.helpers.nativePasteImage?.(this.webview, payload.path || ''); ok = true; }
          else if (action === 'clear') { await this.helpers.clearFocusedField?.(this.webview); ok = true; }
          else throw new Error(`未知原生动作: ${action}`);
        } catch (e) { error = String(e?.message || e); }
        try { this.webview.send('hm-adapter-native-ack', { requestId: msg.requestId, nativeId: msg.nativeId, ok, error }); } catch {}
        return;
      }
      if (msg.type === 'broadcast-progress') {
        try { this.helpers.broadcastProgress?.(this.profileId, msg); } catch {}
        return;
      }
      if (msg.type === 'note-edit') {
        const chatName = String(msg.chatName || '').trim();
        if (chatName) this.helpers.openNoteEditor?.(this.profileId, chatName, this.webview);
        return;
      }
      if (msg.type === 'notes-request') {
        try {
          const notes = await this.helpers.getNotes?.(this.profileId) || {};
          this.webview.send('hm-adapter-notes', { notes });
        } catch {}
        return;
      }
      if (msg.type === 'translate-request') {
        const key = String(msg.key || '');
        const text = String(msg.text || '').trim();
        if (!key || !text) return;
        try {
          const translated = await this.helpers.translateText?.(this.profileId, text, msg.target || 'ZH', msg.direction || 'incoming', Array.isArray(msg.context)?msg.context:[]);
          this.webview.send('hm-inline-translation-result', { key, text: translated || '' });
        } catch (e) {
          this.webview.send('hm-inline-translation-result', { key, text: '', error: String(e?.message || e) });
          console.warn('[HelloMike translation]', this.profileId, String(e?.message || e));
        }
        return;
      }
      if (msg.type === 'log') this.helpers.log?.(this.profileId, msg.message || '');
    }

    command(action, payload = {}, timeout = 20000) {
      const requestId = `${this.profileId}:${Date.now()}:${++this.seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`${action} 超时`));
        }, timeout);
        this.pending.set(requestId, { resolve, reject, timer, action });
        try { this.webview.send('hm-adapter-command', { requestId, action, payload }); }
        catch (e) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(e);
        }
      });
    }

    async syncNotes(notes) {
      try { this.webview.send('hm-adapter-notes', { notes: notes || {} }); } catch {}
    }
  }

  window.WhatsAppAdapterHost = WhatsAppAdapterHost;
})();