import json
import locale
import socket
import sys
import threading
import requests
from urllib.parse import quote as url_quote
from typing import Optional

from core.launcher import Launcher
from core.config_gen import ConfigGenerator, get_user_config_dir, get_log_dir
from core.sub_loader import SubscriptionLoader

from core.updater import Updater

RDP_GROUP_KEYWORDS = ["server-", "auto-"]
CLASH_API_PORTS = [9090, 9097, 7891, 7890]
DEFAULT_CLASH_API = "http://127.0.0.1:17891"


def detect_external_clash() -> Optional[tuple[str, int]]:
    for port in CLASH_API_PORTS:
        try:
            resp = requests.get(f"http://127.0.0.1:{port}/version", timeout=1)
            if resp.status_code == 200:
                return ("127.0.0.1", port)
        except Exception:
            pass
    return None


def get_clash_proxy_port(api_host: str, api_port: int) -> int:
    try:
        resp = requests.get(f"http://{api_host}:{api_port}/configs", timeout=2)
        if resp.status_code == 200:
            config = resp.json()
            return config.get("mixed-port") or config.get("socks-port") or 7897
    except Exception:
        pass
    return 7897


def trigger_geodata_update(api_base: str) -> bool:
    try:
        resp = requests.post(f"{api_base}/configs/geo", timeout=30)
        return resp.status_code in (200, 204)
    except Exception:
        return False


class Api:
    def __init__(self):
        self._launcher = Launcher()
        self._config_gen = ConfigGenerator()
        self._sub_loader = SubscriptionLoader()
        self._updater = Updater()
        self._servers: list[dict] = []
        self._proxy_groups: list[dict] = []
        self._subscription_url: str = ""
        self._user_config_dir = get_user_config_dir()
        self._log_dir = get_log_dir()
        self._config_file = self._user_config_dir / "config.json"

        self._external_clash: Optional[tuple[str, int]] = None
        self._clash_api_base: str = DEFAULT_CLASH_API
        self._proxy_port: int = 17897
        self._reuse_mode: bool = False

        self._detect_and_configure_clash()
        self._load_saved_config()
        self._ensure_default_configs()

    def _detect_and_configure_clash(self):
        external = detect_external_clash()
        if external:
            self._external_clash = external
            self._clash_api_base = f"http://{external[0]}:{external[1]}"
            self._proxy_port = get_clash_proxy_port(external[0], external[1])
            self._reuse_mode = True
            self._config_gen.set_proxy_port(self._proxy_port)
            self._config_gen.update_multidesk_proxy_port(self._proxy_port)
            self._launcher.set_reuse_mode(True)
            threading.Thread(
                target=trigger_geodata_update,
                args=(self._clash_api_base,),
                daemon=True,
            ).start()
        else:
            self._clash_api_base = DEFAULT_CLASH_API
            self._proxy_port = 17897
            self._reuse_mode = False
            self._launcher.set_reuse_mode(False)

    def get_run_mode(self) -> dict:
        return {
            "reuse_mode": self._reuse_mode,
            "clash_api": self._clash_api_base,
            "proxy_port": self._proxy_port,
        }

    def _ensure_default_configs(self):
        multidesk_path = self._user_config_dir / "MultiDesk.multidesk"
        if not multidesk_path.exists():
            self._config_gen.generate_multidesk_xml()

        clash_path = self._user_config_dir / "runtime_clash.yaml"
        if not clash_path.exists():
            self._config_gen.generate_clash_config([])

    def _load_saved_config(self):
        if self._config_file.exists():
            try:
                data = json.loads(self._config_file.read_text(encoding="utf-8"))
                self._subscription_url = data.get("subscription_url", "")
                self._servers = data.get("servers", [])
                self._proxy_groups = data.get("proxy_groups", [])
            except Exception:
                pass

    def _save_config(self):
        try:
            data = {
                "subscription_url": self._subscription_url,
                "servers": self._servers,
                "proxy_groups": self._proxy_groups,
            }
            self._config_file.write_text(
                json.dumps(data, ensure_ascii=False), encoding="utf-8"
            )
        except Exception:
            pass

    def start_engine(self) -> bool:
        self._detect_and_configure_clash()
        return self._launcher.start()

    def stop_engine(self) -> bool:
        return self._launcher.stop()

    def get_status(self) -> dict:
        return self._launcher.get_status()

    def get_servers(self) -> list[dict]:
        return self._servers

    def get_subscription_url(self) -> str:
        return self._subscription_url

    def save_config(self, config: dict) -> bool:
        return True

    def load_subscription(self, url: str) -> dict:
        result = self._sub_loader.load(url)

        if not result.success:
            return {
                "success": False,
                "error": result.error,
                "server_count": 0,
                "proxy_groups": [],
            }

        self._subscription_url = url
        self._servers = self._transform_proxies_to_servers(result.proxies)
        self._proxy_groups = result.proxy_groups
        self._save_config()

        if result.raw_config:
            self._config_gen.generate_clash_config_from_subscription(result.raw_config)
        else:
            self._config_gen.generate_clash_config(result.proxies)

        return {
            "success": True,
            "error": None,
            "server_count": len(self._servers),
            "proxy_groups": self._transform_proxy_groups(result.proxy_groups),
        }

    def get_proxy_groups(self) -> list[dict]:
        if self._reuse_mode:
            return self._fetch_external_proxy_groups()
        return self._transform_proxy_groups(self._proxy_groups)

    def _fetch_external_proxy_groups(self) -> list[dict]:
        try:
            resp = requests.get(f"{self._clash_api_base}/proxies", timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                proxies = data.get("proxies", {})
                groups = []
                for name, info in proxies.items():
                    if info.get("type") == "Selector":
                        if any(kw in name.lower() for kw in RDP_GROUP_KEYWORDS):
                            groups.append(
                                {
                                    "name": name,
                                    "type": "select",
                                    "proxies": info.get("all", []),
                                    "now": info.get("now"),
                                }
                            )
                return groups
        except Exception:
            pass
        return []

    def _get_active_proxy(self, group_name: str) -> str | None:
        try:
            resp = requests.get(
                f"{self._clash_api_base}/proxies/{url_quote(group_name)}", timeout=2
            )
            if resp.status_code == 200:
                return resp.json().get("now")
        except Exception:
            pass
        return None

    def _transform_proxy_groups(self, groups: list) -> list[dict]:
        transformed = []
        for group in groups:
            if isinstance(group, dict):
                name = group.get("name", "")
                if any(kw in name.lower() for kw in RDP_GROUP_KEYWORDS):
                    now = self._get_active_proxy(name)
                    transformed.append(
                        {
                            "name": name,
                            "type": group.get("type", "select"),
                            "proxies": group.get("proxies", []),
                            "now": now,
                        }
                    )
        return transformed

    def check_for_update(self) -> dict:
        return self._updater.check_for_update()

    def get_download_status(self) -> dict:
        return self._updater.get_download_status()

    def start_download_update(self) -> bool:
        return self._updater.start_download()

    def install_update(self) -> bool:
        return self._updater.install_update()

    def get_current_version(self) -> str:
        return self._updater.get_current_version()

    def get_clash_log(self) -> str:
        log_path = self._log_dir / "clash.log"
        if log_path.exists():
            try:
                return log_path.read_text(encoding="utf-8")[-5000:]
            except Exception:
                return ""
        return ""

    def test_servers_connectivity(self) -> list[dict]:
        def test_single(server: dict) -> dict:
            host = server.get("host", "")
            port = server.get("port", 3389)
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(3)
                start = __import__("time").time()
                sock.connect((host, port))
                latency = int((__import__("time").time() - start) * 1000)
                sock.close()
                return {"id": server["id"], "status": "online", "latency": latency}
            except Exception:
                return {"id": server["id"], "status": "offline", "latency": None}

        results = []
        threads = []

        for server in self._servers:
            t = threading.Thread(target=lambda s=server: results.append(test_single(s)))
            threads.append(t)
            t.start()

        for t in threads:
            t.join(timeout=5)

        for result in results:
            for server in self._servers:
                if server["id"] == result["id"]:
                    server["status"] = result["status"]
                    server["latency"] = result["latency"]
                    break

        return self._servers

    def _transform_proxies_to_servers(self, proxies: list) -> list[dict]:
        servers = []
        for i, proxy in enumerate(proxies):
            servers.append(
                {
                    "id": str(i + 1),
                    "name": proxy.get("name", f"Server-{i + 1}"),
                    "host": proxy.get("server", ""),
                    "port": 3389,
                    "status": "unknown",
                }
            )
        return servers

    def test_group_delays(self, group_name: str) -> dict:
        result = {}
        proxies = []

        if self._reuse_mode:
            try:
                resp = requests.get(
                    f"{self._clash_api_base}/proxies/{url_quote(group_name)}", timeout=5
                )
                if resp.status_code == 200:
                    data = resp.json()
                    proxies = data.get("all", [])
            except Exception:
                pass
        else:
            group = None
            for g in self._proxy_groups:
                if isinstance(g, dict) and g.get("name") == group_name:
                    group = g
                    break
            if group:
                proxies = group.get("proxies", [])

        if not proxies:
            return result

        api_base = self._clash_api_base

        def test_single(proxy_name: str):
            try:
                url = f"{api_base}/proxies/{url_quote(proxy_name)}/delay"
                resp = requests.get(
                    url,
                    params={
                        "url": "http://www.gstatic.com/generate_204",
                        "timeout": 5000,
                        "unified": "true",
                    },
                    timeout=10,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    result[proxy_name] = data.get("delay", -1)
                else:
                    result[proxy_name] = -1
            except Exception:
                result[proxy_name] = -1

        threads = []
        for proxy in proxies:
            t = threading.Thread(target=test_single, args=(proxy,))
            threads.append(t)
            t.start()

        for t in threads:
            t.join(timeout=10)

        return result

    def get_connections(self) -> dict:
        try:
            resp = requests.get(f"{self._clash_api_base}/connections", timeout=5)
            if resp.status_code == 200:
                return resp.json()
        except Exception:
            pass
        return {"connections": [], "downloadTotal": 0, "uploadTotal": 0}

    def switch_proxy(self, group_name: str, proxy_name: str) -> bool:
        try:
            resp = requests.put(
                f"{self._clash_api_base}/proxies/{url_quote(group_name)}",
                json={"name": proxy_name},
                timeout=5,
            )
            return resp.status_code == 204
        except Exception:
            return False

    def get_system_language(self) -> str:
        try:
            if sys.platform == "win32":
                import ctypes

                lcid = ctypes.windll.kernel32.GetUserDefaultUILanguage()
                if lcid in (0x0804, 0x0404, 0x0C04, 0x1004, 0x1404):
                    return "zh-CN"
            else:
                lang = locale.getdefaultlocale()[0] or ""
                if lang.startswith("zh"):
                    return "zh-CN"
        except Exception:
            pass
        return "en-US"
