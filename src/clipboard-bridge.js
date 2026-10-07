'use strict';
// Async, main-process-only clipboard compatibility for Electron 44.
// This is not a clipboard watcher/history feature. The only image MIME is PNG.
const { Blob: NodeBlob } = require('node:buffer');
function createClipboardBridge(electron, BlobType = NodeBlob) {
  const { clipboard, nativeImage, ClipboardItem } = electron;
  async function writeText(value) {
    await clipboard.writeText(String(value ?? ''));
    return true;
  }
  async function readText() {
    return await clipboard.readText();
  }
  async function writeImagePath(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('CLIPBOARD_IMAGE_PATH_REQUIRED');
    const image = nativeImage.createFromPath(value);
    if (image.isEmpty()) throw new Error('CLIPBOARD_IMAGE_INVALID');
    if (typeof ClipboardItem === 'function' && typeof clipboard.write === 'function') {
      const png = image.toPNG();
      if (!png || !png.length) throw new Error('CLIPBOARD_IMAGE_INVALID');
      // Never pass renderer-provided objects or MIME keys to ClipboardItem.
      const item = new ClipboardItem({ 'image/png': new BlobType([png], { type: 'image/png' }) });
      await clipboard.write([item]);
    } else if (typeof clipboard.writeImage === 'function') {
      // Compatibility path for the pre-upgrade Electron API.
      await clipboard.writeImage(image);
    } else {
      throw new Error('CLIPBOARD_API_UNSUPPORTED');
    }
    return true;
  }
  return { writeText, readText, writeImagePath };
}
module.exports = { createClipboardBridge };