PHONE REMOTE - WINDOWS AGENT
============================

BUILD THE EXE
-------------
Double-click:
    BUILD EXE.bat

It creates:
    dist\Phone Remote.exe

The finished EXE can run on a Windows PC without Python or PyCharm installed.

CURRENT CONFIGURATION
---------------------
SERVER_URL:
    https://phone-control-marian.onrender.com

DEVICE_ID:
    my-laptop

REMOTE_TOKEN:
    1234

ACTION_PASSWORD:
    Defaults to 1234 unless ACTION_PASSWORD is set.
    This password is requested only for Disconnect / Restart / Shutdown.

You can change ACTION_PASSWORD separately with the ACTION_PASSWORD environment variable before building/running if you want a different protected-action password.

NEW COMMANDS
------------
- Mouse Hold / Release (left button down/up)
- Center mouse on the primary screen
- Send text + Enter
- Restart Windows
- Shut down Windows
- Password verification for protected actions

SAFETY / RELIABILITY
--------------------
- Any held mouse button is automatically released if the WebSocket connection closes or the agent stops.
- The Center Mouse recovery uses the Windows cursor API, so it can recover the pointer even from a PyAutoGUI fail-safe corner.
- PyAutoGUI's normal emergency fail-safe remains enabled for regular mouse/keyboard commands.
- Closing the Phone Remote window stops remote access.


V3 defaults:
- Device ID: my-laptop
- Relay token: 1234
- Protected action password: 1234

V4: Added volume slider support and Mute / Unmute media-key support.

V5 AUDIO:
The phone volume slider now controls the actual Windows master output volume through Windows Core Audio. BUILD EXE.bat installs and bundles pycaw/comtypes automatically.


V6 PC SHORTCUTS
The web remote can send a launch_app command containing an executable basename (for example chrome.exe or brave.exe). The agent resolves it using Windows App Paths / PATH and common browser install folders. Command-line arguments and shell commands are not accepted.

V7 NOTES
- Windows master volume uses Core Audio first, with Windows media-key fallback.
- Chrome and Brave shortcuts resolve PATH, Windows App Paths registry entries, and common install locations.
