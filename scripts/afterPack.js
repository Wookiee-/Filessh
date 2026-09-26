// electron-builder afterPack: prune dead weight from the bundled Electron.
// Safe for Filessh (terminal-only UI, no media/WebGL/Vulkan, English-only):
//   - locales: keep en-US only (~38MB saved)
//   - Vulkan software rasterizer (xterm.js needs no Vulkan)
//   - bundled ffmpeg (no <video>/<audio> anywhere in the app)
// Kept deliberately: libEGL/libGLESv2 (GPU compositing), icudtl, sandbox.
const fs = require('fs');
const path = require('path');

exports.default = async (context) => {
  const dir = context.appOutDir;
  const rm = (p) => {
    try {
      const full = path.join(dir, p);
      if (fs.existsSync(full)) {
        fs.rmSync(full, { recursive: true, force: true });
        console.log(`  [prune] ${p}`);
      }
    } catch (err) {
      console.warn(`  [prune-skip] ${p}: ${err.message}`);
    }
  };

  const locales = path.join(dir, 'locales');
  if (fs.existsSync(locales)) {
    for (const f of fs.readdirSync(locales)) {
      if (f !== 'en-US.pak')
        rm(path.join('locales', f));
    }
  }
  rm('libvk_swiftshader.so');
  rm('vk_swiftshader_icd.json');
  rm('libffmpeg.so');
};
