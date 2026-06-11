!macro NSIS_HOOK_PREINSTALL
  ; Stop old processes before copying files. Runtime core copies are named
  ; nextdesk-core-<parent-pid>-<timestamp>.exe, and taskkill /IM does not
  ; match that wildcard reliably. PowerShell Get-Process does.
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name nextdesk-core-* -ErrorAction SilentlyContinue | Stop-Process -Force"'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk-core.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk-core-amd64.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk-core-arm64.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk.exe'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Add Windows Firewall rule for NextDesk core engine
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NextDesk Core"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NextDesk Core amd64"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NextDesk Core arm64"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="NextDesk Core" dir=in action=allow program="$INSTDIR\bin\nextdesk-core.exe" enable=yes profile=any'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="NextDesk Core amd64" dir=in action=allow program="$INSTDIR\bin\nextdesk-core-amd64.exe" enable=yes profile=any'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="NextDesk Core arm64" dir=in action=allow program="$INSTDIR\bin\nextdesk-core-arm64.exe" enable=yes profile=any'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop running processes before removing installed files. Runtime core copies
  ; are named nextdesk-core-<parent-pid>-<timestamp>.exe.
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name nextdesk-core-* -ErrorAction SilentlyContinue | Stop-Process -Force"'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk-core.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk-core-amd64.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk-core-arm64.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk.exe'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove Windows Firewall rule on uninstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NextDesk Core"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NextDesk Core amd64"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NextDesk Core arm64"'
!macroend
