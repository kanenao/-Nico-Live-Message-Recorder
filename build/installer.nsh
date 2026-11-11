!macro customInstall
  ; Write the updater marker into the same registry hive used by this install scope.
  WriteRegStr SHELL_CONTEXT "Software\kanenao\NicoLiveMessageRecorder" "InstallLocation" "$INSTDIR"
  WriteRegStr SHELL_CONTEXT "Software\kanenao\NicoLiveMessageRecorder" "InstallType" "NSIS"
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\kanenao\NicoLiveMessageRecorder"
!macroend
