import subprocess
import sys
from pathlib import Path

CREATION_FLAGS = (
    getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
)


class Launcher:
    def __init__(self):
        self._bin_dir = Path(__file__).parent.parent / "bin"
        self._clash_proc = None
        self._multidesk_proc = None

    def start(self) -> bool:
        try:
            self._start_clash()
            self._start_multidesk()
            return True
        except Exception:
            return False

    def stop(self) -> bool:
        try:
            if self._clash_proc:
                self._clash_proc.terminate()
            if self._multidesk_proc:
                self._multidesk_proc.terminate()
            return True
        except Exception:
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
            self._clash_proc = subprocess.Popen(
                [str(network_path)],
                creationflags=CREATION_FLAGS,
            )

    def _start_multidesk(self):
        core_path = self._bin_dir / "core.dat"
        if core_path.exists():
            self._multidesk_proc = subprocess.Popen(
                [str(core_path)],
                creationflags=CREATION_FLAGS,
            )
