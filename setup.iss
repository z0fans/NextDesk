; NextDesk Installer Script
; Inno Setup 6.x compatible

#define MyAppName "NextDesk"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "NextDesk Team"
#define MyAppExeName "NextDesk.exe"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=installer
OutputBaseFilename=NextDesk_Setup_v{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
LicenseFile=
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "dist\NextDesk\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "backend\bin\WebView2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: not IsWebView2Installed

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
procedure KillRunningProcesses;
var
  ResultCode: Integer;
begin
  Exec('taskkill', '/F /IM NextDesk.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill', '/F /IM network.dat', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill', '/F /IM core.dat', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(500);
end;

function IsWebView2Installed: Boolean;
var
  RegValue: String;
begin
  Result := RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', RegValue);
  if not Result then
    Result := RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', RegValue);
  if not Result then
    Result := RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', RegValue);
end;

procedure InstallWebView2;
var
  ResultCode: Integer;
begin
  if not IsWebView2Installed then
  begin
    if MsgBox('NextDesk requires Microsoft WebView2 Runtime.' + #13#10 + 'Install now?', mbConfirmation, MB_YESNO) = IDYES then
    begin
      ExtractTemporaryFile('WebView2Setup.exe');
      Exec(ExpandConstant('{tmp}\WebView2Setup.exe'), '/silent /install', '', SW_SHOW, ewWaitUntilTerminated, ResultCode);
    end;
  end;
end;

function InitializeSetup: Boolean;
begin
  KillRunningProcesses;
  Result := True;
  InstallWebView2;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not IsWebView2Installed then
      InstallWebView2;
  end;
end;
