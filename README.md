# Laptop Remote

A simple phone-to-PC remote control system.

It includes:

- **Web Remote** — mobile-friendly interface hosted on Render
- **Windows Agent** — Python/EXE application running on the PC
- Mouse control
- Left click / hold / right click
- Keyboard controls
- Text input and Send + Enter
- Windows master volume and mute
- Chrome / Brave shortcuts
- Website shortcuts
- Restart and shutdown controls

## Folder Structure

```text
laptop-remote/
├── Web-Render/
├── Windows-Agent/
└── README.md
```

## 1. Windows Agent

Open:

```text
Windows-Agent/
```

Run:

```text
BUILD EXE.bat
```

This installs the required Python packages and creates the Windows EXE.

Run the generated EXE before using the remote.

Default configuration:

```text
Device ID: my-laptop
Token: 1234
Protected actions password: 1234
```

The same Device ID and token must be used by the web/Render side.

## 2. Web Remote

Deploy the contents of:

```text
Web-Render/
```

to Render.

The phone remote automatically connects to the Windows agent.

## Website Shortcuts

Edit:

```text
Web-Render/public/shortcuts.csv
```

Example:

```csv
name,url
YouTube,https://www.youtube.com/
Netflix,https://www.netflix.com/
HBO Max,https://www.max.com/
Voyo,https://voyo.bg/
```

Website shortcuts open the URL in the active browser.

## PC Shortcuts

Edit:

```text
Web-Render/public/pc-shortcuts.csv
```

Example:

```csv
name,app,icon_url
Chrome,chrome.exe,https://cdn.simpleicons.org/googlechrome
Brave,brave.exe,https://cdn.simpleicons.org/brave
```

`app` should normally be the application's `.exe` name.

## Usage

1. Start the Windows Agent on the PC.
2. Open the deployed remote on your phone.
3. The remote connects automatically.
4. Use the mouse, keyboard, volume, shortcuts, or power controls.

Restart and Shutdown require the protected-actions password.

## Important

The PC must be online and the Windows Agent must be running for the remote to work.
