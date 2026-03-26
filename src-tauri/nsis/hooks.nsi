!macro NSIS_HOOK_POSTINSTALL
  ; Add Windows Firewall rule for NextDesk core engine
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NextDesk Core"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="NextDesk Core" dir=in action=allow program="$INSTDIR\bin\nextdesk-core.exe" enable=yes profile=any'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove Windows Firewall rule on uninstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NextDesk Core"'
!macroend
