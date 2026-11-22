# Nyra design

Design sources and reference shots for every Nyra surface.

| Folder | What's inside |
| --- | --- |
| `mocks/` | Rendered design mocks: Android, iOS, Mac, Windows |
| `source/` | HTML/CSS sources for the mocks plus render scripts (`kit.py` holds the LIGHT/DARK tokens, `desktop.py` / `mobile.py` the layouts) |
| `terminal/` | Terminal UI (gradient wordmark, mode badges, status bar), English and Chinese |
| `desktop/` | Desktop UI (`nyra ui` at `/`) as implemented at 1440×900: light, dark and Chinese shots; `d2-vs-design.png` (Mac / Windows mocks vs implementation), `d2-splash-vs-video.png` (splash in the desktop shell vs the original video), and liquid glass before/after (`d2-glass-cmp-light.png`, `d2-glass-cmp-dark.png`) |
| `mobile/` | Phone page `/m` as implemented, Android and iOS, plus side-by-side comparisons with the mocks and the splash; liquid glass before/after in `m3-glass-cmp-light.png` / `m3-glass-cmp-dark.png` |
| `splash/` | Opening animation: source, final frame, video |
| `logo/` | Logo explorations and marks |
| `bot/` | Nyra's bot: the purple blob agent avatar. 8 avatars (Nyra plus 7 sample companion agents) × 5 states as SVG (64px and 18px) and 256px PNG, the overview sheet `avatars.png`, in-product shots in `screens/`; colour tokens, sizes and usage (live status line, approval card, thread list) in `README.md` |
| `icon/` | Final app icon C (the blob as a rounded square): masters for iOS, macOS, Windows, Android adaptive and favicon in `C/`, per-platform preview `board.png`, applied result `applied.png`; sizes per platform in `README.md` |
| `video-call/` | Video call panel (design only, built by Muse): friends (a person + their agent), incoming / outgoing / offline, in-call with people and agent tiles paired by owner plus the shared-work panel and approval card, data vs tokens, first-collaboration permissions, recording consent, weak network, call summary. Desktop 1440×900 and phone 390×844, light and dark; boards `call-*.png`, single screens in `single/`, overview `call-overview.png`, sources in `source/`, spec in `SPEC.md`. All numbers are illustrative |
| `v8/` | Design-only v8 (Chinese UI, dark, v6.2 purple blob logo and avatars unchanged): conversation stays on the left with a right-hand drawer whose segmented control switches Overview / Changes / Plan / Evidence / Terminal (pc-34/35/36); one-line live status, collapsed "show steps", per-turn wrap-up, time and tokens per reply, approval-mode pill in the top bar with Full access in the warning colour (pc-33, pc-33b); approval card = one sentence + "what this step can touch" box, primary Allow once, secondary Deny with feedback, the rest under More (pc-33, m-16, m-20a); skill and automation confirmation cards marked as a design proposal (pc-39); project memory as a file list with sources (pc-03); phone empty state, model and mode pills, status-result subtitles (m-16, m-16e, m-17). Overview `overview.png`, per-screen notes in `README.md`, sources in `source/`. Sample data only |

## Liquid glass

Desktop and phone keep the black-and-white palette and the mock layouts; only the floating layers are glass. Desktop: sidebar, top bar, status bar, composer, approval card, review panel (Diff / Plan / Evidence / Terminal), dialogs, menus and toasts. Phone: tab bar, top bar once scrolled, approval sheet, New thread button, menus, toasts and composer. Glass is a translucent fill with `backdrop-filter` blur and saturation, a 1px top highlight and a soft inner glow, in plain CSS. On the desktop the top bar, status bar and composer float over the thread, so messages scroll underneath them. With `prefers-reduced-transparency` or no `backdrop-filter` support, every layer falls back to solid colour.

Secondary and tertiary text on glass uses darker tokens in light mode and lighter ones in dark mode. Contrast was measured on screenshots, sampling the pixels behind each text element, and every text element on desktop glass is at least 4.5:1 (WCAG AA).
