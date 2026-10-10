// Excalidraw loads its fonts from here instead of a CDN. It reads this at import time, so this module loads first.
Object.assign(window, { EXCALIDRAW_ASSET_PATH: new URL('./', location.href).href });
