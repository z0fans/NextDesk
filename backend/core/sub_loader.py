import base64
from dataclasses import dataclass
from typing import Optional

import requests


@dataclass
class SubscriptionResult:
    success: bool
    proxies: list
    error: Optional[str] = None


class SubscriptionLoader:
    def load(self, url: str) -> SubscriptionResult:
        if not url or not url.strip():
            return SubscriptionResult(success=False, proxies=[], error="URL is empty")

        try:
            response = requests.get(url.strip(), timeout=15)
            response.raise_for_status()
        except requests.exceptions.Timeout:
            return SubscriptionResult(
                success=False, proxies=[], error="Request timeout"
            )
        except requests.exceptions.ConnectionError:
            return SubscriptionResult(
                success=False, proxies=[], error="Connection failed"
            )
        except requests.exceptions.HTTPError as e:
            return SubscriptionResult(
                success=False, proxies=[], error=f"HTTP {e.response.status_code}"
            )
        except Exception as e:
            return SubscriptionResult(success=False, proxies=[], error=str(e))

        proxies, parse_error = self._parse(response.text)
        if parse_error:
            return SubscriptionResult(success=False, proxies=[], error=parse_error)

        if not proxies:
            return SubscriptionResult(
                success=False, proxies=[], error="No proxies found"
            )

        return SubscriptionResult(success=True, proxies=proxies)

    def _parse(self, content: str) -> tuple[list, Optional[str]]:
        try:
            decoded = base64.b64decode(content).decode("utf-8")
            proxies, err = self._parse_clash_yaml(decoded)
            if proxies:
                return proxies, None
        except Exception:
            pass

        return self._parse_clash_yaml(content)

    def _parse_clash_yaml(self, content: str) -> tuple[list, Optional[str]]:
        import yaml

        try:
            data = yaml.safe_load(content)
            if not isinstance(data, dict):
                return [], "Invalid YAML format"
            proxies = data.get("proxies", [])
            if not isinstance(proxies, list):
                return [], "Invalid proxies format"
            return proxies, None
        except yaml.YAMLError as e:
            return [], f"YAML parse error: {str(e)[:50]}"
        except Exception as e:
            return [], str(e)
