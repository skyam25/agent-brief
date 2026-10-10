# Agent Brief icons

## Concept

A hand-drawn ink stroke runs into a teal speech bubble on a paper tile. The stroke is your pen on the board, and the bubble is the voice and the agent answering in the same space.

## Files

| File | Purpose |
| --- | --- |
| `icon.svg` | Master, light tile |
| `icon-dark.svg` | Master, dark tile |
| `icon-small.svg`, `icon-dark-small.svg` | Masters for 32 px and below (no gap, no shadows, thicker stroke) |
| `tray.svg` | Menu bar mark, black on transparent |
| `icon-1024.png`, `icon-dark-1024.png` | 1024 px renders |
| `icon.iconset/` | Standard iconset, 16 to 512@2x |
| `icon.icns` | Built from `icon.iconset` with `iconutil` |
| `trayTemplate.png`, `trayTemplate@2x.png` | Menu bar template image, 18 and 36 px |
| `preview.png` | Contact sheet on light and dark backgrounds |
| `render.mjs` | Renders everything above from the SVGs |

## Palette

| Role | Light | Dark |
| --- | --- | --- |
| Tile | `#FFFDF8` to `#F1EBDF` | `#2B2F3A` to `#191C24` |
| Ink stroke | `#1F2540` | `#F3EEE3` |
| Bubble | `#1BB5A7` to `#0A9185` | `#2CC8BA` to `#14A396` |

## Regenerate

```sh
cd companion
node build/icons/render.mjs
```

The script needs `@playwright/test` and macOS `iconutil`. It uses Playwright's pinned headless Chromium and falls back to the newest cached `chromium_headless_shell-*` in `~/Library/Caches/ms-playwright`.

## Using the files

- Electron Builder: point `mac.icon` at `build/icons/icon.icns`.
- Tray: `new Tray(nativeImage.createFromPath('…/trayTemplate.png'))`. The `Template` suffix lets macOS tint it for light and dark menu bars, and the `@2x` file is picked up automatically.
