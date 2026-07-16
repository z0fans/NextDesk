!macro NSIS_HOOK_PREINSTALL
  ; Stop NextDesk before replacing application files.
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk.exe'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Remove the firewall rule left by releases that bundled a network engine.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NextDesk Core"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk.exe'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove Windows Firewall rule on uninstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="NextDesk Core"'
!macroend
