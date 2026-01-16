import os
import sys
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Optional, Callable
import requests

CURRENT_VERSION = "1.0.17"
GITHUB_REPO = "z0fans/NextDesk"
GITHUB_API_URL = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"


class Updater:
    def __init__(self):
        self._download_progress: float = 0
        self._download_status: str = "idle"
        self._latest_version: Optional[str] = None
        self._download_url: Optional[str] = None
        self._download_thread: Optional[threading.Thread] = None

    def get_current_version(self) -> str:
        return CURRENT_VERSION

    def check_for_update(self) -> dict:
        try:
            resp = requests.get(GITHUB_API_URL, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            tag = data.get("tag_name", "")
            latest = tag.lstrip("v")
            self._latest_version = latest

            assets = data.get("assets", [])
            exe_asset = next((a for a in assets if a["name"].endswith(".exe")), None)
            if exe_asset:
                self._download_url = exe_asset["browser_download_url"]

            has_update = self._compare_versions(latest, CURRENT_VERSION) > 0

            return {
                "has_update": has_update,
                "current_version": CURRENT_VERSION,
                "latest_version": latest,
                "download_url": self._download_url,
            }
        except Exception as e:
            return {
                "has_update": False,
                "current_version": CURRENT_VERSION,
                "latest_version": None,
                "error": str(e),
            }

    def get_download_status(self) -> dict:
        return {
            "status": self._download_status,
            "progress": self._download_progress,
        }

    def start_download(self) -> bool:
        if not self._download_url:
            return False
        if self._download_status == "downloading":
            return False

        self._download_status = "downloading"
        self._download_progress = 0
        self._download_thread = threading.Thread(
            target=self._download_update, daemon=True
        )
        self._download_thread.start()
        return True

    def _download_update(self):
        try:
            resp = requests.get(self._download_url, stream=True, timeout=300)
            resp.raise_for_status()

            total_size = int(resp.headers.get("content-length", 0))
            downloaded = 0

            temp_dir = tempfile.gettempdir()
            installer_path = Path(temp_dir) / "NextDesk_Update.exe"

            with open(installer_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total_size > 0:
                            self._download_progress = (downloaded / total_size) * 100

            self._download_status = "ready"
            self._download_progress = 100

        except Exception as e:
            self._download_status = f"error: {str(e)}"
            self._download_progress = 0

    def install_update(self) -> bool:
        if self._download_status != "ready":
            return False

        temp_dir = tempfile.gettempdir()
        installer_path = Path(temp_dir) / "NextDesk_Update.exe"

        if not installer_path.exists():
            return False

        try:
            if sys.platform == "win32":
                subprocess.Popen(
                    [str(installer_path), "/SILENT"],
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            return True
        except Exception:
            return False

    def _compare_versions(self, v1: str, v2: str) -> int:
        def parse(v):
            return [int(x) for x in v.split(".") if x.isdigit()]

        p1, p2 = parse(v1), parse(v2)
        for a, b in zip(p1, p2):
            if a > b:
                return 1
            if a < b:
                return -1
        return len(p1) - len(p2)
