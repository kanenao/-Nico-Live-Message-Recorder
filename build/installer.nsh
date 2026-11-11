!macro customInstall
  ; Keep a per-user install marker so the app can distinguish NSIS installs from ZIP copies.
  WriteRegStr HKCU "Software\kanenao\NicoLiveMessageRecorder" "InstallLocation" "$INSTDIR"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\kanenao\NicoLiveMessageRecorder"
!macroend
