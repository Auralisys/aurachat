; ONNX Runtime is linked statically; its Windows distribution also needs DirectML.
!macro NSIS_HOOK_POSTINSTALL
  ; Tauri includes this file before defining MAINBINARYSRCPATH: resolve it only here.
  !searchreplace AURA_DIRECTML_PATH "${MAINBINARYSRCPATH}" "${MAINBINARYNAME}.exe" "DirectML.dll"
  SetOutPath "$INSTDIR"
  File /oname=DirectML.dll "${AURA_DIRECTML_PATH}"
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\DirectML.dll"
  RMDir "$INSTDIR"
!macroend
