import os
import sys
from pathlib import Path

import webview

from api import Api

DEV_MODE = os.environ.get("NEXTDESK_DEV", "0") == "1"


def get_url() -> str:
    if DEV_MODE:
        return "http://localhost:5173"

    if getattr(sys, "frozen", False):
        base_path = Path(sys._MEIPASS)
    else:
        base_path = Path(__file__).parent

    web_path = base_path / "web" / "index.html"
    return str(web_path)


def main():
    api = Api()
    window = webview.create_window(
        title="NextDesk",
        url=get_url(),
        js_api=api,
        width=1280,
        height=800,
        min_size=(800, 600),
    )
    webview.start(debug=DEV_MODE)


if __name__ == "__main__":
    main()
