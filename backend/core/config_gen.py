import os
from pathlib import Path
import yaml


SOCKS_PORT = 17897


def get_user_config_dir() -> Path:
    """Get user config directory: %APPDATA%/NextDesk on Windows, ~/.config/NextDesk on others"""
    if os.name == "nt":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
    else:
        base = os.path.expanduser("~/.config")
    config_dir = Path(base) / "NextDesk"
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir


class ConfigGenerator:
    def __init__(self):
        self._config_dir = get_user_config_dir()

    def generate_clash_config(self, proxies: list) -> Path:
        config = {
            "port": 17890,
            "socks-port": SOCKS_PORT,
            "allow-lan": False,
            "mode": "rule",
            "proxies": proxies,
        }
        config_path = self._config_dir / "runtime_clash.yaml"
        with open(config_path, "w", encoding="utf-8") as f:
            yaml.dump(config, f, allow_unicode=True)
        return config_path

    def generate_multidesk_xml(self, servers: list = None) -> Path:
        xml_path = self._config_dir / "MultiDesk.multidesk"
        xml_content = self._build_xml()
        with open(xml_path, "w", encoding="utf-8") as f:
            f.write(xml_content)
        return xml_path

    def _build_xml(self) -> str:
        return f"""<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<MultiDesk>
	<Servers>
		<Group>
			<Properties>
				<Name>LibrasService</Name>
				<Description/>
				<InheritGeneral>0</InheritGeneral>
				<InheritProxy>0</InheritProxy>
				<ProxyType>1</ProxyType>
				<SocksHostname>127.0.0.1</SocksHostname>
				<SocksPort>{SOCKS_PORT}</SocksPort>
				<SocksUserName/>
				<SocksPassword/>
				<InheritDisplay>0</InheritDisplay>
				<GroupCollapsed>0</GroupCollapsed>
				<UserName>Administrator</UserName>
				<Domain/>
				<Password/>
				<RDPPort>3389</RDPPort>
				<DesktopHeight>0</DesktopHeight>
				<DesktopWidth>0</DesktopWidth>
				<ZoomLevel>100</ZoomLevel>
				<DesktopScaleFactor>0</DesktopScaleFactor>
				<ColorDepth>24</ColorDepth>
				<FullScreen>0</FullScreen>
				<ConnectToServerConsole>0</ConnectToServerConsole>
				<SmartSizing>1</SmartSizing>
			</Properties>
		</Group>
		<Properties>
			<Name/>
			<Description/>
			<InheritGeneral>1</InheritGeneral>
			<InheritProxy>1</InheritProxy>
			<InheritDisplay>1</InheritDisplay>
			<GroupCollapsed>0</GroupCollapsed>
		</Properties>
	</Servers>
	<Settings/>
	<ExternalTools>
		<ExternalTool Title="P&amp;ing" Command="%comspec%" Arguments="/k ping -t %server%" StartPath=""/>
		<ExternalTool Title="&amp;Query User" Command="%comspec%" Arguments="/k query user /server:%server%" StartPath=""/>
		<ExternalTool Title="&amp;Query Session" Command="%comspec%" Arguments="/k query session /server:%server%" StartPath=""/>
	</ExternalTools>
</MultiDesk>"""
