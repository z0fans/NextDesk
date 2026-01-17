import os
from pathlib import Path
import yaml


SOCKS_PORT = 17897


def get_user_config_dir() -> Path:
    if os.name == "nt":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
    else:
        base = os.path.expanduser("~/.config")
    config_dir = Path(base) / "NextDesk"
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir


def get_log_dir() -> Path:
    log_dir = get_user_config_dir() / "log"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


RDP_GROUP_KEYWORDS = ["server-", "auto-"]


class ConfigGenerator:
    def __init__(self):
        self._config_dir = get_user_config_dir()

    def _filter_rdp_groups(self, proxy_groups: list) -> list:
        filtered = []
        for group in proxy_groups:
            name = group.get("name", "").lower()
            if any(kw in name for kw in RDP_GROUP_KEYWORDS):
                filtered.append(group)
        return filtered

    def _filter_rdp_rules(self, rules: list, filtered_groups: list) -> list:
        group_names = {g.get("name", "") for g in filtered_groups}
        filtered = []
        for rule in rules:
            parts = rule.split(",")
            if len(parts) >= 2:
                target = parts[-1].strip()
                if target in group_names or target in ["DIRECT", "REJECT"]:
                    filtered.append(rule)
        if not any("MATCH" in r for r in filtered):
            filtered.append("MATCH,DIRECT")
        return filtered

    def generate_clash_config_from_subscription(self, raw_config: dict) -> Path:
        proxy_groups = raw_config.get("proxy-groups", [])
        filtered_groups = self._filter_rdp_groups(proxy_groups)
        filtered_rules = self._filter_rdp_rules(
            raw_config.get("rules", []), filtered_groups
        )

        config = {
            "port": 17890,
            "socks-port": SOCKS_PORT,
            "external-controller": "127.0.0.1:17891",
            "allow-lan": False,
            "mode": raw_config.get("mode", "rule"),
            "geodata-mode": False,
            "geo-auto-update": False,
            "proxies": raw_config.get("proxies", []),
            "proxy-groups": filtered_groups,
            "rules": filtered_rules,
        }

        if raw_config.get("dns"):
            config["dns"] = raw_config["dns"]

        config_path = self._config_dir / "runtime_clash.yaml"
        with open(config_path, "w", encoding="utf-8") as f:
            yaml.dump(config, f, allow_unicode=True)
        return config_path

    def generate_clash_config(self, proxies: list) -> Path:
        proxy_names = [p.get("name", f"proxy-{i}") for i, p in enumerate(proxies)]

        config = {
            "port": 17890,
            "socks-port": SOCKS_PORT,
            "external-controller": "127.0.0.1:17891",
            "allow-lan": False,
            "mode": "rule",
            "geodata-mode": False,
            "geo-auto-update": False,
            "proxies": proxies,
            "proxy-groups": [
                {
                    "name": "PROXY",
                    "type": "select",
                    "proxies": proxy_names if proxy_names else ["DIRECT"],
                }
            ],
            "rules": ["MATCH,PROXY"],
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
				<SocksUserName>librascloud</SocksUserName>
				<SocksPassword>$1$4c2a95fa3aa1be1f4f2cbfb3eac012d0$323383454e7ed34f0f92e4349be5f866a74020f2d0122890f890d107594d5b7c</SocksPassword>
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
			<Server>
				<Name>Please add your server here</Name>
				<Description/>
				<Server>Server IP</Server>
				<MacAddress/>
				<UseVMBus>0</UseVMBus>
				<EnhancedMode>0</EnhancedMode>
				<VMId/>
				<InheritGeneral>0</InheritGeneral>
				<EnableCredSspSupport>1</EnableCredSspSupport>
				<InheritProxy>1</InheritProxy>
				<InheritDisplay>1</InheritDisplay>
				<RedirectPrinters>0</RedirectPrinters>
				<RedirectClipboard>1</RedirectClipboard>
				<RedirectPorts>0</RedirectPorts>
				<RedirectSmartCards>0</RedirectSmartCards>
				<RedirectDrives>0</RedirectDrives>
				<DriveCollection/>
				<AudioRedirectionMode>0</AudioRedirectionMode>
				<AudioCaptureRedirectionMode>0</AudioCaptureRedirectionMode>
				<KeyboardHookMode>1</KeyboardHookMode>
				<StartProgramOnConnection>0</StartProgramOnConnection>
				<StartProgram/>
				<WorkDir/>
				<PerformanceFlags>384</PerformanceFlags>
				<BitmapPersistence>1</BitmapPersistence>
				<AutoReconnect>0</AutoReconnect>
				<BandwidthDetection>1</BandwidthDetection>
				<AuthenticationLevel>0</AuthenticationLevel>
				<GatewayProfileUsageMethod>0</GatewayProfileUsageMethod>
				<GatewayUsageMethod>1</GatewayUsageMethod>
				<GatewayHostname/>
				<GatewayCredsSource>4</GatewayCredsSource>
				<GatewayUserName/>
				<GatewayPassword/>
				<GatewayDomain/>
				<GatewayUseGeneralCred>1</GatewayUseGeneralCred>
				<UseClientName>0</UseClientName>
				<ClientName/>
				<ProxyType>0</ProxyType>
				<SocksHostname>127.0.0.1</SocksHostname>
				<SocksPort>{SOCKS_PORT}</SocksPort>
				<SocksUserName/>
				<SocksPassword/>
				<UserName>Administrator</UserName>
				<Domain/>
				<Password/>
				<RDPPort>3389</RDPPort>
			</Server>
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
		<ExternalTool Title="&amp;Shadow Session" Command="%windir%\\system32\\mstsc.exe" Arguments="/shadow:%session% /v:%server% /control" StartPath=""/>
	</ExternalTools>
</MultiDesk>"""
