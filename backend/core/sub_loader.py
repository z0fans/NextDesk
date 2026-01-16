import base64

import requests


class SubscriptionLoader:
    def load(self, url: str) -> list:
        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            return self._parse(response.text)
        except Exception:
            return []

    def _parse(self, content: str) -> list:
        try:
            decoded = base64.b64decode(content).decode("utf-8")
            return self._parse_clash_yaml(decoded)
        except Exception:
            return self._parse_clash_yaml(content)

    def _parse_clash_yaml(self, content: str) -> list:
        import yaml

        try:
            data = yaml.safe_load(content)
            return data.get("proxies", [])
        except Exception:
            return []
