import argparse
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import websocket

# ============================================================
# PHONE REMOTE CONFIGURATION
# Change these values, then rebuild the EXE if your setup changes.
# Environment variables with the same names can also override them.
# ============================================================
SERVER_URL = os.getenv("REMOTE_SERVER", "https://phone-control-marian.onrender.com")
DEVICE_ID = os.getenv("DEVICE_ID", "my-laptop")
REMOTE_TOKEN = os.getenv("REMOTE_TOKEN", "1234")
# Used only for Disconnect / Restart / Shutdown confirmations from the phone UI.
# This is intentionally separate from the relay token.
ACTION_PASSWORD = os.getenv("ACTION_PASSWORD", "1234")

RECONNECT_DELAY_SECONDS = 3


def resource_path(filename: str) -> str:
    """Return a bundled resource path for normal Python and PyInstaller builds."""
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return str(Path(base) / filename)
    return str(Path(__file__).resolve().parent / filename)


def build_ws_url(server_url: str) -> str:
    """Convert the HTTP(S) Render URL into the WebSocket relay URL."""
    value = server_url.strip()
    if not value:
        raise ValueError("SERVER_URL is empty")

    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https", "ws", "wss"}:
        raise ValueError("SERVER_URL must start with http://, https://, ws://, or wss://")

    scheme = {
        "http": "ws",
        "https": "wss",
        "ws": "ws",
        "wss": "wss",
    }[parsed.scheme]

    path = parsed.path.rstrip("/")
    if not path.endswith("/ws"):
        path = f"{path}/ws" if path else "/ws"

    return urlunparse((scheme, parsed.netloc, path, "", "", ""))


class InputController:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self._pyautogui = None
        self._pyperclip = None
        self._held_buttons = set()

        if not dry_run:
            import pyautogui
            import pyperclip

            pyautogui.FAILSAFE = True
            pyautogui.PAUSE = 0.01

            self._pyautogui = pyautogui
            self._pyperclip = pyperclip

    @staticmethod
    def normalize_key(key: str) -> str:
        aliases = {
            "escape": "esc",
            "return": "enter",
            "control": "ctrl",
            "option": "alt",
            "cmd": "win",
            "command": "win",
        }
        key = str(key).strip().lower()
        return aliases.get(key, key)

    def move(self, dx, dy):
        if not self.dry_run:
            self._pyautogui.moveRel(float(dx), float(dy), duration=0)

    def click(self, button):
        if not self.dry_run:
            self._pyautogui.click(button=str(button).lower())

    def mouse_down(self, button):
        button = str(button).lower()
        if self.dry_run:
            self._held_buttons.add(button)
            return
        self._pyautogui.mouseDown(button=button)
        self._held_buttons.add(button)

    def mouse_up(self, button):
        button = str(button).lower()
        if not self.dry_run:
            old_failsafe = self._pyautogui.FAILSAFE
            try:
                # Releasing a held button must always work, even if the cursor
                # happens to be sitting on PyAutoGUI's fail-safe corner.
                self._pyautogui.FAILSAFE = False
                self._pyautogui.mouseUp(button=button)
            finally:
                self._pyautogui.FAILSAFE = old_failsafe
        self._held_buttons.discard(button)

    def release_all(self):
        buttons = list(self._held_buttons)
        for button in buttons:
            try:
                self.mouse_up(button)
            except Exception:
                self._held_buttons.discard(button)

    def center_mouse(self):
        if self.dry_run:
            return

        # Use the Windows cursor API for this recovery command. It still works even
        # if PyAutoGUI's emergency fail-safe position has been reached.
        if sys.platform == "win32":
            import ctypes
            user32 = ctypes.windll.user32
            width = user32.GetSystemMetrics(0)
            height = user32.GetSystemMetrics(1)
            user32.SetCursorPos(max(0, width // 2), max(0, height // 2))
            return

        width, height = self._pyautogui.size()
        self._pyautogui.moveTo(width // 2, height // 2, duration=0)

    def scroll(self, dy):
        amount = int(round(float(dy)))
        if amount == 0:
            amount = 1 if float(dy) > 0 else -1
        if not self.dry_run:
            self._pyautogui.scroll(amount)

    def type_text(self, text, press_enter=False):
        if self.dry_run:
            return

        text = str(text)
        old_clipboard = None
        try:
            old_clipboard = self._pyperclip.paste()
        except Exception:
            pass

        self._pyperclip.copy(text)
        self._pyautogui.hotkey("ctrl", "v")
        time.sleep(0.08)

        if old_clipboard is not None:
            try:
                self._pyperclip.copy(old_clipboard)
            except Exception:
                pass

        if press_enter:
            self._pyautogui.press("enter")

    def navigate_url(self, url):
        """Navigate the currently focused browser tab to an HTTP(S) URL."""
        value = str(url).strip()
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Shortcut URL must be a valid http:// or https:// address.")
        if self.dry_run:
            return
        # Works in Chrome, Brave, Edge, Firefox and most desktop browsers.
        self._pyautogui.hotkey("ctrl", "l")
        time.sleep(0.05)
        self.type_text(value, press_enter=True)

    def launch_app(self, executable):
        """Launch a Windows app by safe executable basename, e.g. chrome.exe."""
        name = str(executable).strip()
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.exe", name):
            raise ValueError("PC shortcuts may contain executable names only, for example chrome.exe.")
        if self.dry_run:
            return
        if sys.platform != "win32":
            raise RuntimeError("PC app shortcuts are supported only on Windows.")

        candidates = []
        found = shutil.which(name)
        if found:
            candidates.append(found)

        # Most desktop apps register themselves under Windows App Paths.
        try:
            import winreg
            registry_paths = [
                rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{name}",
                rf"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\{name}",
            ]
            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                for key_path in registry_paths:
                    try:
                        with winreg.OpenKey(hive, key_path) as key:
                            value, _ = winreg.QueryValueEx(key, None)
                            if value:
                                candidates.append(value)
                    except OSError:
                        pass
        except Exception:
            pass

        # Common browser install locations cover Chrome/Brave even if App Paths
        # is unavailable on a particular installation.
        local = os.getenv("LOCALAPPDATA", "")
        pf = os.getenv("PROGRAMFILES", "")
        pfx86 = os.getenv("PROGRAMFILES(X86)", "")
        common = {
            "chrome.exe": [
                os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
                os.path.join(pfx86, "Google", "Chrome", "Application", "chrome.exe"),
                os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
            ],
            "brave.exe": [
                os.path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                os.path.join(pfx86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                os.path.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            ],
        }
        candidates.extend(common.get(name.lower(), []))

        for path in candidates:
            if path and os.path.isfile(path):
                subprocess.Popen([path], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                return

        raise FileNotFoundError(f"Windows could not find {name}. Install it or use its registered .exe name in pc-shortcuts.csv.")

    def key(self, key):
        if not self.dry_run:
            self._pyautogui.press(self.normalize_key(key))

    def hotkey(self, keys):
        normalized = [self.normalize_key(key) for key in keys]
        if not self.dry_run:
            self._pyautogui.hotkey(*normalized)

    def _windows_endpoint_volume(self):
        """Return the Windows default playback device master-volume interface."""
        if sys.platform != "win32":
            raise RuntimeError("Master-volume control is supported only on Windows.")

        # WebSocket commands run on the agent worker thread. COM must be
        # initialized on that same thread before Core Audio can be used.
        import comtypes
        comtypes.CoInitialize()

        from ctypes import POINTER, cast
        from comtypes import CLSCTX_ALL
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume

        speakers = AudioUtilities.GetSpeakers()
        interface = speakers.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
        return cast(interface, POINTER(IAudioEndpointVolume))

    def set_volume(self, value):
        """Set the actual Windows master output volume to 0-100%."""
        value = max(0.0, min(100.0, float(value)))
        if self.dry_run:
            return
        try:
            endpoint = self._windows_endpoint_volume()
            endpoint.SetMasterVolumeLevelScalar(value / 100.0, None)
            return
        except Exception as exc:
            # Compatibility fallback: Windows media keys still change the system
            # master volume if Core Audio is unavailable on an unusual setup.
            # Reset to 0, then raise in 2%% steps to approximately the requested value.
            old_failsafe = self._pyautogui.FAILSAFE
            try:
                self._pyautogui.FAILSAFE = False
                self._pyautogui.press('volumedown', presses=60, interval=0.002)
                steps = int(round(value / 2.0))
                if steps:
                    self._pyautogui.press('volumeup', presses=steps, interval=0.002)
                return
            except Exception:
                raise RuntimeError(f"Windows volume control failed: {exc}") from exc
            finally:
                self._pyautogui.FAILSAFE = old_failsafe

    def toggle_mute(self):
        """Toggle the actual Windows master mute state."""
        if self.dry_run:
            return
        try:
            endpoint = self._windows_endpoint_volume()
            endpoint.SetMute(0 if endpoint.GetMute() else 1, None)
            return
        except Exception as exc:
            try:
                self._pyautogui.press('volumemute')
                return
            except Exception:
                raise RuntimeError(f"Windows mute control failed: {exc}") from exc

    def execute(self, command: dict):
        command_type = command.get("type")

        if command_type == "move":
            self.move(command["dx"], command["dy"])
        elif command_type == "click":
            self.click(command["button"])
        elif command_type == "mouse_down":
            self.mouse_down(command["button"])
        elif command_type == "mouse_up":
            self.mouse_up(command["button"])
        elif command_type == "center_mouse":
            self.center_mouse()
        elif command_type == "scroll":
            self.scroll(command["dy"])
        elif command_type == "type":
            self.type_text(command["text"], bool(command.get("enter")))
        elif command_type == "navigate_url":
            self.navigate_url(command["url"])
        elif command_type == "launch_app":
            self.launch_app(command["app"])
        elif command_type == "key":
            self.key(command["key"])
        elif command_type == "hotkey":
            self.hotkey(command["keys"])
        elif command_type == "volume_set":
            self.set_volume(command.get("value", 50))
        elif command_type == "volume_mute_toggle":
            self.toggle_mute()
        elif command_type == "verify_password":
            supplied = str(command.get("password", ""))
            if not hmac.compare_digest(supplied, ACTION_PASSWORD):
                raise PermissionError("Incorrect password.")
        elif command_type == "system_action":
            supplied = str(command.get("password", ""))
            if not hmac.compare_digest(supplied, ACTION_PASSWORD):
                raise PermissionError("Incorrect password.")
            action = command.get("action")
            self.release_all()
            if self.dry_run:
                return
            if sys.platform != "win32":
                raise RuntimeError("Restart and shutdown are supported only on Windows.")
            if action == "shutdown":
                subprocess.Popen(["shutdown", "/s", "/t", "0"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            elif action == "restart":
                subprocess.Popen(["shutdown", "/r", "/t", "0"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                raise ValueError("Unsupported system action.")
        elif command_type == "ping":
            return
        else:
            raise ValueError(f"Unsupported command type: {command_type!r}")


class RemoteAgent:
    def __init__(
        self,
        server_url: str,
        device_id: str,
        token: str,
        dry_run: bool = False,
        status_callback=None,
    ):
        self.ws_url = build_ws_url(server_url)
        self.device_id = device_id.strip()
        self.token = token
        self.controller = InputController(dry_run=dry_run)
        self.dry_run = dry_run
        self.status_callback = status_callback
        self.stop_event = threading.Event()
        self.ws_app = None
        self.authenticated = False

    def set_status(self, message: str, state: str = "neutral"):
        if self.status_callback:
            try:
                self.status_callback(message, state)
            except Exception:
                pass

    def send(self, payload: dict):
        ws_app = self.ws_app
        if ws_app and ws_app.sock and ws_app.sock.connected:
            try:
                ws_app.send(json.dumps(payload))
            except Exception:
                pass

    def on_open(self, ws):
        if self.stop_event.is_set():
            ws.close()
            return

        self.set_status("Authenticating...", "connecting")
        ws.send(json.dumps({
            "type": "auth",
            "role": "agent",
            "deviceId": self.device_id,
            "token": self.token,
        }))

    def on_message(self, ws, raw_message):
        if self.stop_event.is_set():
            return

        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            return

        message_type = message.get("type")

        if message_type == "auth_ok":
            self.authenticated = True
            self.set_status("Connected - phone control is ready", "online")
            self.send({"type": "status", "message": "Laptop online"})
            return

        if message_type == "auth_error":
            self.authenticated = False
            self.set_status("Authentication failed", "error")
            self.stop_event.set()
            ws.close()
            return

        if message_type == "replaced":
            self.authenticated = False
            self.set_status("Another Phone Remote replaced this connection", "error")
            return

        if message_type != "command":
            return

        command = message.get("command")
        if not isinstance(command, dict):
            return

        try:
            self.controller.execute(command)
            self.send({
                "type": "ack",
                "ok": True,
                "command": command.get("type"),
                "requestId": command.get("requestId"),
            })
        except Exception as exc:
            self.send({
                "type": "ack",
                "ok": False,
                "command": command.get("type"),
                "requestId": command.get("requestId"),
                "message": str(exc)[:200],
            })

    def on_error(self, _ws, _error):
        if not self.stop_event.is_set():
            self.set_status("Connection problem - retrying...", "error")

    def on_close(self, _ws, _status_code, _close_message):
        self.authenticated = False
        self.controller.release_all()
        if not self.stop_event.is_set():
            self.set_status("Disconnected - reconnecting...", "connecting")

    def stop(self):
        """Immediately stop reconnecting and close the active WebSocket."""
        self.stop_event.set()
        self.authenticated = False
        self.controller.release_all()

        ws_app = self.ws_app
        if ws_app:
            try:
                ws_app.close()
            except Exception:
                pass

    def run(self):
        self.set_status("Connecting...", "connecting")

        while not self.stop_event.is_set():
            self.ws_app = websocket.WebSocketApp(
                self.ws_url,
                on_open=self.on_open,
                on_message=self.on_message,
                on_error=self.on_error,
                on_close=self.on_close,
            )

            try:
                self.ws_app.run_forever()
            except Exception:
                if not self.stop_event.is_set():
                    self.set_status("Connection problem - retrying...", "error")

            if self.stop_event.is_set():
                break

            self.stop_event.wait(RECONNECT_DELAY_SECONDS)

        self.set_status("Stopped", "stopped")


def validate_config(server_url: str, device_id: str, token: str):
    problems = []
    if "YOUR-APP" in server_url or not server_url.strip():
        problems.append("SERVER_URL is not configured.")
    if not device_id.strip():
        problems.append("DEVICE_ID cannot be empty.")
    if not token or token == "PUT-YOUR-TOKEN-HERE":
        problems.append("REMOTE_TOKEN is not configured.")
    if problems:
        raise ValueError("\n".join(problems))


class PhoneRemoteWindow:
    BG = "#0c111b"
    PANEL = "#151c29"
    TEXT = "#f4f7fb"
    MUTED = "#8f9aab"
    GREEN = "#36d17c"
    AMBER = "#ffbd52"
    RED = "#ff5c6c"
    GRAY = "#6f7a8b"

    def __init__(self, root: tk.Tk, agent: RemoteAgent):
        self.root = root
        self.agent = agent
        self.worker = None
        self.closing = False

        self._configure_window()
        self._build_ui()

        self.agent.status_callback = self.set_status_threadsafe
        self.start_agent()

    def _configure_window(self):
        self.root.title("Phone Remote")
        self.root.configure(bg=self.BG)
        self.root.resizable(False, False)

        width = 390
        height = 250
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        x = max(0, (screen_w - width) // 2)
        y = max(0, (screen_h - height) // 3)
        self.root.geometry(f"{width}x{height}+{x}+{y}")
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        try:
            self.root.iconbitmap(resource_path("app.ico"))
        except Exception:
            pass

    def _build_ui(self):
        outer = tk.Frame(self.root, bg=self.BG, padx=22, pady=20)
        outer.pack(fill="both", expand=True)

        title_row = tk.Frame(outer, bg=self.BG)
        title_row.pack(fill="x")

        icon_box = tk.Canvas(
            title_row,
            width=44,
            height=44,
            bg=self.PANEL,
            highlightthickness=0,
        )
        icon_box.pack(side="left")
        icon_box.create_rectangle(14, 8, 30, 36, outline=self.GREEN, width=2)
        icon_box.create_oval(20, 30, 24, 34, fill=self.GREEN, outline="")

        title_text = tk.Frame(title_row, bg=self.BG)
        title_text.pack(side="left", padx=(12, 0), fill="x", expand=True)

        tk.Label(
            title_text,
            text="Phone Remote",
            bg=self.BG,
            fg=self.TEXT,
            font=("Segoe UI Semibold", 16),
            anchor="w",
        ).pack(fill="x")

        tk.Label(
            title_text,
            text="Laptop control agent",
            bg=self.BG,
            fg=self.MUTED,
            font=("Segoe UI", 9),
            anchor="w",
        ).pack(fill="x", pady=(1, 0))

        status_panel = tk.Frame(outer, bg=self.PANEL, padx=14, pady=13)
        status_panel.pack(fill="x", pady=(18, 14))

        status_row = tk.Frame(status_panel, bg=self.PANEL)
        status_row.pack(fill="x")

        self.status_dot = tk.Canvas(
            status_row,
            width=14,
            height=14,
            bg=self.PANEL,
            highlightthickness=0,
        )
        self.status_dot.pack(side="left", padx=(0, 9))
        self.dot_id = self.status_dot.create_oval(2, 2, 12, 12, fill=self.AMBER, outline="")

        self.status_label = tk.Label(
            status_row,
            text="Starting...",
            bg=self.PANEL,
            fg=self.TEXT,
            font=("Segoe UI Semibold", 10),
            anchor="w",
        )
        self.status_label.pack(side="left", fill="x", expand=True)

        tk.Label(
            status_panel,
            text=f"Device: {self.agent.device_id}  |  Keep this window open to use the remote.",
            bg=self.PANEL,
            fg=self.MUTED,
            font=("Segoe UI", 8),
            anchor="w",
        ).pack(fill="x", pady=(7, 0))

        controls = tk.Frame(outer, bg=self.BG)
        controls.pack(fill="x")

        minimize_btn = tk.Button(
            controls,
            text="Minimize",
            command=self.root.iconify,
            bg="#222c3d",
            fg=self.TEXT,
            activebackground="#2b374b",
            activeforeground=self.TEXT,
            relief="flat",
            bd=0,
            padx=18,
            pady=9,
            cursor="hand2",
            font=("Segoe UI Semibold", 9),
        )
        minimize_btn.pack(side="left")

        self.stop_btn = tk.Button(
            controls,
            text="Stop & Close",
            command=self.close,
            bg="#7a2632",
            fg="#ffffff",
            activebackground="#96313f",
            activeforeground="#ffffff",
            relief="flat",
            bd=0,
            padx=18,
            pady=9,
            cursor="hand2",
            font=("Segoe UI Semibold", 9),
        )
        self.stop_btn.pack(side="right")

    def start_agent(self):
        self.worker = threading.Thread(target=self.agent.run, name="PhoneRemoteAgent", daemon=True)
        self.worker.start()

    def set_status_threadsafe(self, message: str, state: str):
        try:
            self.root.after(0, self._set_status, message, state)
        except Exception:
            pass

    def _set_status(self, message: str, state: str):
        if self.closing:
            return

        colors = {
            "online": self.GREEN,
            "connecting": self.AMBER,
            "error": self.RED,
            "stopped": self.GRAY,
            "neutral": self.GRAY,
        }
        self.status_dot.itemconfigure(self.dot_id, fill=colors.get(state, self.GRAY))
        self.status_label.configure(text=message)

    def close(self):
        if self.closing:
            return

        self.closing = True
        self.stop_btn.configure(state="disabled", text="Stopping...")
        self.status_label.configure(text="Stopping Phone Remote...")
        self.status_dot.itemconfigure(self.dot_id, fill=self.GRAY)

        self.agent.stop()
        self._wait_for_stop()

    def _wait_for_stop(self):
        if self.worker and self.worker.is_alive():
            self.root.after(50, self._wait_for_stop)
            return
        self.root.destroy()


def enable_windows_dpi_awareness():
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description="Phone Remote Windows agent")
    parser.add_argument("--dry-run", action="store_true", help="Connect without controlling mouse/keyboard")
    parser.add_argument("--server", default=SERVER_URL)
    parser.add_argument("--device", default=DEVICE_ID)
    parser.add_argument("--token", default=REMOTE_TOKEN)
    args = parser.parse_args()

    enable_windows_dpi_awareness()

    try:
        validate_config(args.server, args.device, args.token)
        agent = RemoteAgent(
            server_url=args.server,
            device_id=args.device,
            token=args.token,
            dry_run=args.dry_run,
        )
    except Exception as exc:
        root = tk.Tk()
        root.withdraw()
        from tkinter import messagebox
        messagebox.showerror("Phone Remote", f"Phone Remote could not start:\n\n{exc}")
        root.destroy()
        return 2

    root = tk.Tk()
    PhoneRemoteWindow(root, agent)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
