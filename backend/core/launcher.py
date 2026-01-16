import subprocess
import sys
import os
from pathlib import Path

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
        self._clash_proc = None
        self._multidesk_proc = None

    def start(self) -> bool:
        try:
            self._start_clash()
            self._start_multidesk()
            return True
        except Exception as e:
            print(f"Start error: {e}")
            return False

    def stop(self) -> bool:
        try:
            if self._clash_proc:
                self._clash_proc.terminate()
                self._clash_proc = None
            if self._multidesk_proc:
                self._multidesk_proc.terminate()
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
        network_path = self._bin_dir / "network.dat"
        if network_path.exists():
            config_path = self._bin_dir.parent / "runtime_clash.yaml"
            args = [str(network_path)]
            if config_path.exists():
                args.extend(["-f", str(config_path)])
            self._clash_proc = subprocess.Popen(
                args,
                creationflags=CREATION_FLAGS,
                cwd=str(self._bin_dir),
            )

    def _start_multidesk(self):
        core_path = self._bin_dir / "core.dat"
        if core_path.exists():
            env = os.environ.copy()
            self._multidesk_proc = subprocess.Popen(
                [str(core_path)],
                creationflags=0 if sys.platform == "win32" else 0,
                cwd=str(self._bin_dir),
                env=env,
            )
