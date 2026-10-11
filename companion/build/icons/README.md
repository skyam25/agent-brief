# Agent Brief icons

## Concept

A paper plane, folded from the brief, leaves a short dotted trail on a paper tile. The brief you sketched and wrote is on its way to the agent.

## Files

| File | Purpose |
| --- | --- |
| `icon.svg` | Master, light tile |
| `icon-dark.svg` | Master, dark tile |
| `icon-small.svg`, `icon-dark-small.svg` | Masters for 32 px and below (no trail, no shadows, a larger plane, a tinted wing on the light tile) |
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
| Wing | `#FFFFFF` (`#B9E3DD` at small sizes) | `#F3EEE3` |
| Fold and trail | `#1BB5A7` to `#0A9185` | `#2CC8BA` to `#14A396` |
| Keel | `#0A7A70` | `#0E7F75` |

## Regenerate

```sh
cd companion
node build/icons/render.mjs
```

The script needs `@playwright/test` and macOS `iconutil`. It uses Playwright's pinned headless Chromium and falls back to the newest cached `chromium_headless_shell-*` in `~/Library/Caches/ms-playwright`.

## Using the files

- Electron Builder: point `mac.icon` at `build/icons/icon.icns`.
- Tray: `new Tray(nativeImage.createFromPath('…/trayTemplate.png'))`. The `Template` suffix lets macOS tint it for light and dark menu bars, and the `@2x` file is picked up automatically.
