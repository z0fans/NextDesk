import base64
import json
import re
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlparse, parse_qs, unquote

import requests


@dataclass
class SubscriptionResult:
    success: bool
    proxies: list
    proxy_groups: list = field(default_factory=list)
    rules: list = field(default_factory=list)
    raw_config: dict = field(default_factory=dict)
    error: Optional[str] = None


class SubscriptionLoader:
    def load(self, url: str) -> SubscriptionResult:
        if not url or not url.strip():
            return SubscriptionResult(success=False, proxies=[], error="URL is empty")

        try:
            response = requests.get(
                url.strip(),
                timeout=15,
                headers={"User-Agent": "clash-verge/v1.7.7"},
            )
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

        result = self._parse(response.text)
        if result.error:
            return result

        if not result.proxies:
            return SubscriptionResult(
                success=False, proxies=[], error="No proxies found"
            )

        return result

    def _parse(self, content: str) -> SubscriptionResult:
        content = content.strip()

        decoded_content = None
        try:
            decoded_content = base64.b64decode(content).decode("utf-8").strip()
        except Exception:
            pass

        for text in [decoded_content, content]:
            if not text:
                continue

            if text.startswith("{") or text.startswith("["):
                result = self._parse_json(text)
                if result.proxies:
                    return result

            if "proxies:" in text or text.startswith("port:"):
                result = self._parse_clash_yaml(text)
                if result.proxies:
                    return result

            if any(
                scheme in text
                for scheme in ["ss://", "vmess://", "trojan://", "vless://", "ssr://"]
            ):
                proxies = self._parse_uri_list(text)
                if proxies:
                    return SubscriptionResult(success=True, proxies=proxies)

        return SubscriptionResult(
            success=False, proxies=[], error="Unsupported subscription format"
        )

    def _parse_clash_yaml(self, content: str) -> SubscriptionResult:
        import yaml

        try:
            data = yaml.safe_load(content)
            if not isinstance(data, dict):
                return SubscriptionResult(
                    success=False, proxies=[], error="Invalid YAML format"
                )

            proxies = data.get("proxies", [])
            if not isinstance(proxies, list):
                return SubscriptionResult(
                    success=False, proxies=[], error="Invalid proxies format"
                )

            proxy_groups = data.get("proxy-groups", [])
            rules = data.get("rules", [])

            return SubscriptionResult(
                success=True,
                proxies=proxies,
                proxy_groups=proxy_groups,
                rules=rules,
                raw_config=data,
            )
        except Exception as e:
            return SubscriptionResult(
                success=False, proxies=[], error=f"YAML error: {str(e)[:50]}"
            )

    def _parse_json(self, content: str) -> SubscriptionResult:
        try:
            data = json.loads(content)
            if isinstance(data, list):
                return SubscriptionResult(success=True, proxies=data)
            if isinstance(data, dict):
                proxies = data.get("proxies", data.get("outbounds", []))
                proxy_groups = data.get("proxy-groups", [])
                rules = data.get("rules", [])
                return SubscriptionResult(
                    success=True,
                    proxies=proxies,
                    proxy_groups=proxy_groups,
                    rules=rules,
                    raw_config=data,
                )
        except Exception:
            pass
        return SubscriptionResult(
            success=False, proxies=[], error="Invalid JSON format"
        )

    def _parse_uri_list(self, content: str) -> list:
        proxies = []
        lines = content.strip().split("\n")

        for line in lines:
            line = line.strip()
            if not line:
                continue

            proxy = None
            if line.startswith("ss://"):
                proxy = self._parse_ss_uri(line)
            elif line.startswith("vmess://"):
                proxy = self._parse_vmess_uri(line)
            elif line.startswith("trojan://"):
                proxy = self._parse_trojan_uri(line)
            elif line.startswith("vless://"):
                proxy = self._parse_vless_uri(line)

            if proxy:
                proxies.append(proxy)

        return proxies

    def _parse_ss_uri(self, uri: str) -> Optional[dict]:
        try:
            uri = uri[5:]
            if "#" in uri:
                uri, name = uri.rsplit("#", 1)
                name = unquote(name)
            else:
                name = "SS Server"

            if "@" in uri:
                method_pass, server_port = uri.rsplit("@", 1)
                try:
                    decoded = base64.b64decode(method_pass + "==").decode("utf-8")
                    method, password = decoded.split(":", 1)
                except Exception:
                    method, password = method_pass.split(":", 1)
                server, port = server_port.split(":")
            else:
                decoded = base64.b64decode(uri + "==").decode("utf-8")
                method_pass, server_port = decoded.rsplit("@", 1)
                method, password = method_pass.split(":", 1)
                server, port = server_port.split(":")

            return {
                "name": name,
                "type": "ss",
                "server": server,
                "port": int(port),
                "cipher": method,
                "password": password,
            }
        except Exception:
            return None

    def _parse_vmess_uri(self, uri: str) -> Optional[dict]:
        try:
            encoded = uri[8:]
            decoded = base64.b64decode(encoded + "==").decode("utf-8")
            data = json.loads(decoded)

            return {
                "name": data.get("ps", "VMess Server"),
                "type": "vmess",
                "server": data.get("add", ""),
                "port": int(data.get("port", 443)),
                "uuid": data.get("id", ""),
                "alterId": int(data.get("aid", 0)),
                "cipher": data.get("scy", "auto"),
                "network": data.get("net", "tcp"),
                "tls": data.get("tls", "") == "tls",
            }
        except Exception:
            return None

    def _parse_trojan_uri(self, uri: str) -> Optional[dict]:
        try:
            parsed = urlparse(uri)
            name = unquote(parsed.fragment) if parsed.fragment else "Trojan Server"

            return {
                "name": name,
                "type": "trojan",
                "server": parsed.hostname or "",
                "port": parsed.port or 443,
                "password": parsed.username or "",
                "sni": parse_qs(parsed.query).get("sni", [""])[0],
            }
        except Exception:
            return None

    def _parse_vless_uri(self, uri: str) -> Optional[dict]:
        try:
            parsed = urlparse(uri)
            name = unquote(parsed.fragment) if parsed.fragment else "VLESS Server"
            params = parse_qs(parsed.query)

            return {
                "name": name,
                "type": "vless",
                "server": parsed.hostname or "",
                "port": parsed.port or 443,
                "uuid": parsed.username or "",
                "network": params.get("type", ["tcp"])[0],
                "tls": params.get("security", [""])[0] in ["tls", "reality"],
            }
        except Exception:
            return None
