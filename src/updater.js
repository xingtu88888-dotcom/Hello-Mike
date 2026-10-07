'use strict';

function createUpdateController({ ipcMain }) {
  const state = {
    configured: false,
    enabled: false,
    status: 'disabled',
    code: 'UPDATE_DISABLED_FOR_INSTALL_TEST'
  };

  const handle = (channel, fn) => {
    try { ipcMain.removeHandler(channel); } catch {}
    ipcMain.handle(channel, fn);
  };

  handle('hm-updates:get-state', async () => state);
  handle('hm-updates:check', async () => state);
  handle('hm-updates:download', async () => state);
  handle('hm-updates:install', async () => state);

  return {
    getState: () => state,
    checkForUpdates: async () => state,
    downloadUpdate: async () => state,
    installUpdate: async () => state
  };
}

module.exports = { createUpdateController };
