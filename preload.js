const { contextBridge } = require('electron');

// Reserved for future native integrations (e.g. tray, notifications).
contextBridge.exposeInMainWorld('appInfo', {
  platform: process.platform
});
