# Laptop Remote - Web / Render side

This is the phone web interface and WebSocket relay.

## Current setup

- Device ID: `my-laptop`
- The phone login no longer asks for the relay token.
- `public/app.js` contains `REMOTE_TOKEN = '1234'`; it must match the Render `REMOTE_TOKEN` and the Windows agent.
- Sensitive actions (Disconnect / Restart / Shutdown) are verified by the Windows agent using `ACTION_PASSWORD`.

## New controls

- Default pointer sensitivity: 2.0x
- Left-click Hold / Release for text selection and dragging
- Esc and Search (Ctrl+L) buttons
- Search also jumps to the keyboard section
- Quick Keyboard / Mouse section jump buttons
- Send text and Send + Enter
- Tab shortcut
- Bring mouse to screen center
- Password-protected Disconnect / Restart / Shutdown at the bottom

## Render settings

- Language: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Environment variable: `REMOTE_TOKEN=1234` (or change all matching copies together)

The service listens on Render's `PORT` automatically.


## Website shortcuts
Edit `public/shortcuts.csv`. Keep the first line `name,url`, then add one site per line.

```csv
name,url
YouTube,https://www.youtube.com/
Netflix,https://www.netflix.com/
Disney+,https://www.disneyplus.com/
```

The phone UI creates the buttons automatically and loads a favicon for each domain. Clicking a shortcut sends Ctrl+L, the URL and Enter to the currently focused browser on the Windows PC.

The controller opens directly and auto-connects to device `my-laptop`; there is no Device ID / Connect screen.


## V3 connection note

- The phone UI and Windows agent now use relay token `1234` by default.
- The relay also accepts an older `REMOTE_TOKEN` already saved on Render during migration, so an old Render environment value will not cause the generic credentials/device-ID failure.
- Protected Disconnect / Restart / Shutdown password is `1234` by default.

## V4 additions
- 13 example website shortcuts are included in `public/shortcuts.csv` (remove/edit freely).
- Left / Hold / Right are forced into one row on narrow phones.
- Added laptop volume slider and Mute / Unmute button.
- Mouse jump returns to the very top; Keyboard jump includes sticky-header clearance.

## v5 audio
The audio row now sits directly below Escape/Search. Mute/Unmute occupies 1/4 of the row and the slider occupies 3/4. The Windows agent uses Windows Core Audio (pycaw/comtypes) to control the actual master playback volume.


## Shortcut CSVs (v6)
- `public/shortcuts.csv` controls website shortcuts: `name,url`.
- `public/pc-shortcuts.csv` controls Windows app shortcuts: `name,app,icon_url`.
- `app` must be an executable basename such as `chrome.exe` or `brave.exe`; arbitrary command-line arguments are intentionally not supported.
- `icon_url` is optional.

## v7 fixes
- Relay now accepts `launch_app`, `volume_set`, and `volume_mute_toggle` commands. This fixes PC shortcuts and volume commands being dropped before they reached the Windows agent.
- Header typography and spacing reduced for narrow phones.
- Mouse/Keyboard jump buttons now include recognizable icons.
