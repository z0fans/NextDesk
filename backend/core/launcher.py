import subprocess
import sys
import os
import threading
import time
import locale
from pathlib import Path

from core.config_gen import get_user_config_dir, get_log_dir

CREATION_FLAGS = (
    getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
)


class Launcher:
    def __init__(self):
        if getattr(sys, "frozen", False):
            base_path = Path(sys._MEIPASS)
        else:
            base_path = Path(__file__).parent.parent
        self._bin_dir = base_path / "bin"
        self._config_dir = get_user_config_dir()
        self._clash_proc = None
        self._multidesk_proc = None
        self._title_hijack_thread = None
        self._stop_hijack = False
        self._clash_log_file = None
        self._log_dir = get_log_dir()
        self._reuse_mode = False

    def set_reuse_mode(self, enabled: bool):
        self._reuse_mode = enabled

    def start(self) -> bool:
        try:
            if not self._reuse_mode:
                self._start_clash()
                time.sleep(1)
            self._start_multidesk()
            return True
        except Exception as e:
            print(f"Start error: {e}")
            return False

    def stop(self) -> bool:
        try:
            self._stop_hijack = True
            if self._clash_proc:
                self._clash_proc.terminate()
                try:
                    self._clash_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._clash_proc.kill()
                    self._clash_proc.wait(timeout=2)
                self._clash_proc = None
            if self._clash_log_file:
                self._clash_log_file.close()
                self._clash_log_file = None
            if self._multidesk_proc:
                self._multidesk_proc.terminate()
                try:
                    self._multidesk_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._multidesk_proc.kill()
                    self._multidesk_proc.wait(timeout=2)
                self._multidesk_proc = None
            return True
        except Exception as e:
            print(f"Stop error: {e}")
            return False

    def get_status(self) -> dict:
        return {
            "clash": self._clash_proc is not None and self._clash_proc.poll() is None,
            "multidesk": self._multidesk_proc is not None
            and self._multidesk_proc.poll() is None,
        }

    def _start_clash(self):
        log_path = self._log_dir / "clash.log"

        network_path = self._bin_dir / "network.dat"
        if not network_path.exists():
            log_path.write_text(
                f"ERROR: Clash not found at {network_path}\nbin_dir: {self._bin_dir}",
                encoding="utf-8",
            )
            return

        config_path = self._config_dir / "runtime_clash.yaml"
        args = [str(network_path)]
        if config_path.exists():
            args.extend(["-f", str(config_path)])
        else:
            log_path.write_text(
                f"ERROR: Config not found at {config_path}", encoding="utf-8"
            )
            return

        log_file = open(log_path, "w", encoding="utf-8")
        log_file.write(f"Starting Clash: {' '.join(args)}\n")
        log_file.flush()

        self._clash_proc = subprocess.Popen(
            args,
            creationflags=CREATION_FLAGS,
            cwd=str(self._bin_dir),
            stdout=log_file,
            stderr=log_file,
        )
        self._clash_log_file = log_file

    def _is_chinese_locale(self) -> bool:
        try:
            if sys.platform == "win32":
                import ctypes

                lcid = ctypes.windll.kernel32.GetUserDefaultUILanguage()
                return lcid in (0x0804, 0x0404, 0x0C04, 0x1004, 0x1404)
            else:
                lang = locale.getdefaultlocale()[0] or ""
                return lang.startswith("zh")
        except Exception:
            return False

    def _start_multidesk(self):
        core_path = self._bin_dir / "core.dat"
        if not core_path.exists():
            print(f"MultiDesk not found: {core_path}")
            return

        chs_dll = self._bin_dir / "MultiDesk_chs.x64.dll"
        chs_dll_disabled = self._bin_dir / "MultiDesk_chs.x64.dll.disabled"

        if self._is_chinese_locale():
            if chs_dll_disabled.exists() and not chs_dll.exists():
                chs_dll_disabled.rename(chs_dll)
        else:
            if chs_dll.exists():
                chs_dll.rename(chs_dll_disabled)

        config_path = self._config_dir / "MultiDesk.multidesk"
        args = [str(core_path)]
        if config_path.exists():
            args.append(str(config_path))

        env = os.environ.copy()
        self._multidesk_proc = subprocess.Popen(
            args,
            creationflags=0,
            cwd=str(self._bin_dir),
            env=env,
        )

        if sys.platform == "win32":
            self._stop_hijack = False
            self._title_hijack_thread = threading.Thread(
                target=self._hijack_window_title, daemon=True
            )
            self._title_hijack_thread.start()

    def _hijack_window_title(self):
        try:
            import ctypes
            from ctypes import wintypes

            user32 = ctypes.windll.user32
            EnumWindows = user32.EnumWindows
            GetWindowTextW = user32.GetWindowTextW
            SetWindowTextW = user32.SetWindowTextW
            GetWindowThreadProcessId = user32.GetWindowThreadProcessId

            WNDENUMPROC = ctypes.WINFUNCTYPE(
                wintypes.BOOL, wintypes.HWND, wintypes.LPARAM
            )

            target_pid = self._multidesk_proc.pid if self._multidesk_proc else 0
            target_title = "NextDesk Workspace"

            def enum_callback(hwnd, lParam):
                pid = wintypes.DWORD()
                GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if pid.value == target_pid:
                    buf = ctypes.create_unicode_buffer(256)
                    GetWindowTextW(hwnd, buf, 256)
                    current_title = buf.value
                    if current_title and current_title != target_title:
                        if (
                            "multidesk" in current_title.lower()
                            or "syvik" in current_title.lower()
                        ):
                            SetWindowTextW(hwnd, target_title)
                return True

            callback = WNDENUMPROC(enum_callback)

            for _ in range(100):
                if self._stop_hijack:
                    break
                EnumWindows(callback, 0)
                time.sleep(0.5)
        except Exception as e:
            print(f"Title hijack error: {e}")
