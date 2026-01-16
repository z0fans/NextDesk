from pathlib import Path

from core.launcher import Launcher
from core.config_gen import ConfigGenerator
from core.sub_loader import SubscriptionLoader


class Api:
    def __init__(self):
        self._launcher = Launcher()
        self._config_gen = ConfigGenerator()
        self._sub_loader = SubscriptionLoader()
        self._servers: list[dict] = []
        self._subscription_url: str = ""

    def start_engine(self) -> bool:
        return self._launcher.start()

    def stop_engine(self) -> bool:
        return self._launcher.stop()

    def get_status(self) -> dict:
        return self._launcher.get_status()

    def get_servers(self) -> list[dict]:
        return self._servers

    def save_config(self, config: dict) -> bool:
        return True

    def load_subscription(self, url: str) -> bool:
        try:
            self._subscription_url = url
            proxies = self._sub_loader.load(url)
            self._servers = self._transform_proxies_to_servers(proxies)
            self._config_gen.generate_clash_config(proxies)
            self._config_gen.generate_multidesk_xml(self._servers)
            return True
        except Exception:
            return False

    def _transform_proxies_to_servers(self, proxies: list) -> list[dict]:
        servers = []
        for i, proxy in enumerate(proxies):
            servers.append(
                {
                    "id": str(i + 1),
                    "name": proxy.get("name", f"Server-{i + 1}"),
                    "host": proxy.get("server", ""),
                    "port": proxy.get("port", 3389),
                    "status": "unknown",
                }
            )
        return servers
