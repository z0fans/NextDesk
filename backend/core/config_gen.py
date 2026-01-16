from pathlib import Path
import yaml


class ConfigGenerator:
    def __init__(self):
        self._config_dir = Path(__file__).parent.parent

    def generate_clash_config(self, proxies: list) -> Path:
        config = {
            "port": 7890,
            "socks-port": 7897,
            "allow-lan": False,
            "mode": "rule",
            "proxies": proxies,
        }
        config_path = self._config_dir / "runtime_clash.yaml"
        with open(config_path, "w", encoding="utf-8") as f:
            yaml.dump(config, f, allow_unicode=True)
        return config_path

    def generate_multidesk_xml(self, servers: list) -> Path:
        xml_path = self._config_dir / "MultiDesk.multidesk"
        xml_content = self._build_xml(servers)
        with open(xml_path, "w", encoding="utf-8") as f:
            f.write(xml_content)
        return xml_path

    def _build_xml(self, servers: list) -> str:
        items = []
        for server in servers:
            items.append(f"""    <Connection>
      <Name>{server.get("name", "Server")}</Name>
      <Host>{server.get("host", "")}</Host>
      <Port>{server.get("port", 3389)}</Port>
      <ProxyType>Socks5</ProxyType>
      <ProxyHost>127.0.0.1</ProxyHost>
      <ProxyPort>7897</ProxyPort>
    </Connection>""")
        return f"""<?xml version="1.0" encoding="utf-8"?>
<MultiDesk>
  <Connections>
{chr(10).join(items)}
  </Connections>
</MultiDesk>"""
