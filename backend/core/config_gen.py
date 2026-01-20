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
        self._proxy_port = SOCKS_PORT

    def set_proxy_port(self, port: int):
        self._proxy_port = port

    def get_proxy_port(self) -> int:
        return self._proxy_port

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
            if rule.startswith("RULE-SET,"):
                continue
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

    def generate_multidesk_xml(self) -> Path:
        xml_path = self._config_dir / "MultiDesk.multidesk"
        xml_content = self._build_xml()
        with open(xml_path, "w", encoding="utf-8") as f:
            f.write(xml_content)
        return xml_path

    def _build_xml(self) -> str:
        port = self._proxy_port
        return f"""<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<MultiDesk>
\t<Servers>
\t\t<Group>
\t\t\t<Properties>
\t\t\t\t<Name>LibrasService-Asia-Group</Name>
\t\t\t\t<Description/>
\t\t\t\t<InheritGeneral>0</InheritGeneral>
\t\t\t\t<InheritProxy>1</InheritProxy>
\t\t\t\t<ProxyType>1</ProxyType>
\t\t\t\t<SocksHostname>127.0.0.1</SocksHostname>
\t\t\t\t<SocksPort>{port}</SocksPort>
\t\t\t\t<SocksUserName>librascloud</SocksUserName>
\t\t\t\t<SocksPassword>$1$4c2a95fa3aa1be1f4f2cbfb3eac012d0$323383454e7ed34f0f92e4349be5f866a74020f2d0122890f890d107594d5b7c</SocksPassword>
\t\t\t\t<InheritDisplay>1</InheritDisplay>
\t\t\t\t<GroupCollapsed>0</GroupCollapsed>
\t\t\t\t<UserName>administrator</UserName>
\t\t\t\t<Domain/>
\t\t\t\t<Password>$1$4721fdb4852584c619bf2fab37b350d3$7a2429768746cbe2eceea00915d4fd26c721072d80291518623d68e3d5b842f7</Password>
\t\t\t\t<RDPPort>3389</RDPPort>
\t\t\t\t<DesktopHeight>0</DesktopHeight>
\t\t\t\t<DesktopWidth>0</DesktopWidth>
				<ZoomLevel>100</ZoomLevel>
				<DesktopScaleFactor>0</DesktopScaleFactor>
				<ColorDepth>24</ColorDepth>
				<FullScreen>0</FullScreen>
				<ConnectToServerConsole>0</ConnectToServerConsole>
				<SmartSizing>1</SmartSizing>
			</Properties>
			<Server>
				<Name>Please add your asia server here</Name>
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
				<GatewayPassword>$1$7ea0886fde0d629c9317846b63dac205$7d8319608c30c393f1a7d0517c9c14deccfd73bad0a508ec45b05ba1801aa4c0</GatewayPassword>
				<GatewayDomain/>
				<GatewayUseGeneralCred>1</GatewayUseGeneralCred>
				<UseClientName>0</UseClientName>
				<ClientName>$1$306d20e9bbd269b79d4f4ace00e1c068$49d8bc37e92571ef41534e6d188a8dad320931dc9a813f0306ecbf4d85250914</ClientName>
				<ProxyType>0</ProxyType>
				<SocksHostname>127.0.0.1</SocksHostname>
\t\t\t\t<SocksPort>{port}</SocksPort>
				<SocksUserName/>
				<SocksPassword/>
				<UserName>Administrator</UserName>
				<Domain/>
				<Password>$1$f9bc5c52fc3f1ee995a7d3aed85aafde$473804d3a3ecd5715886d7ac9a268c62085b53b7b4b3f0c66b5028856982214e</Password>
				<RDPPort>3389</RDPPort>
			</Server>
		</Group>
		<Properties>
			<Name>Servers</Name>
			<Description/>
			<InheritGeneral>0</InheritGeneral>
			<InheritProxy>0</InheritProxy>
			<InheritDisplay>0</InheritDisplay>
			<GroupCollapsed>0</GroupCollapsed>
			<UserName>Administrator</UserName>
			<UserName/>
			<Domain/>
			<Password>$1$149f7517dc8e61dee9277d35ce09bef0$0bad825600398f03ca52df0d7035eb52980bd775fe092b8810017a0600d4efe1</Password>
			<RDPPort>3389</RDPPort>
			<ProxyType>1</ProxyType>
			<SocksHostname>127.0.0.1</SocksHostname>
\t\t\t<SocksPort>{port}</SocksPort>
			<SocksUserName>LibrasCloud</SocksUserName>
			<SocksPassword>$1$1ca28dd147ccd2f242e43a01775ddc10$5c4492b2704ed64e7e08dd06998d9d9d0cc2a38a93b1e98f6775ca5b34d0f0ac</SocksPassword>
			<DesktopHeight>-10</DesktopHeight>
			<DesktopWidth>-10</DesktopWidth>
			<ZoomLevel>100</ZoomLevel>
			<DesktopScaleFactor>0</DesktopScaleFactor>
			<ColorDepth>24</ColorDepth>
			<FullScreen>0</FullScreen>
			<ConnectToServerConsole>0</ConnectToServerConsole>
			<SmartSizing>0</SmartSizing>
		</Properties>
		<Group>
			<Properties>
				<Name>LibrasService-Americas-Group</Name>
				<Description/>
				<InheritGeneral>1</InheritGeneral>
				<InheritProxy>1</InheritProxy>
				<InheritDisplay>1</InheritDisplay>
				<GroupCollapsed>0</GroupCollapsed>
			</Properties>
			<Server>
				<Name>Please add your america server here</Name>
				<Description/>
				<Server>Please add your america server here</Server>
				<MacAddress/>
				<UseVMBus>0</UseVMBus>
				<EnhancedMode>0</EnhancedMode>
				<VMId/>
				<InheritGeneral>1</InheritGeneral>
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
				<GatewayPassword>$1$747d8c608c6010e000982ebc17a2648e$8b766a982d8ea5fd7a3b9bf1e430b8bcc6c02dbe818ef567b6fa74e4e7e49f7b</GatewayPassword>
				<GatewayDomain/>
				<GatewayUseGeneralCred>1</GatewayUseGeneralCred>
				<UseClientName>0</UseClientName>
				<ClientName>$1$ff6010ae8894bda4f32c52fefaac0743$ed1ce00a98279ced5091345d46846bbd0fe69d0653e1377ff3cb674d5d6dc817</ClientName>
			</Server>
		</Group>
	</Servers>
	<Settings/>
	<ExternalTools>
		<ExternalTool Title="P&amp;ing" Command="%comspec%" Arguments="/k ping -t %server%" StartPath=""/>
		<ExternalTool Title="&amp;Query User" Command="%comspec%" Arguments="/k query user /server:%server%" StartPath=""/>
		<ExternalTool Title="&amp;Query Session" Command="%comspec%" Arguments="/k query session /server:%server%" StartPath=""/>
		<ExternalTool Title="&amp;Shadow Session" Command="%windir%\\system32\\mstsc.exe" Arguments="/shadow:%session% /v:%server% /control" StartPath=""/>
	</ExternalTools>
</MultiDesk>"""
