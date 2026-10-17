; ONNX Runtime is linked statically; its Windows distribution also needs DirectML.
!searchreplace AURA_DIRECTML_PATH "${MAINBINARYSRCPATH}" "${MAINBINARYNAME}.exe" "DirectML.dll"
!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File /oname=DirectML.dll "${AURA_DIRECTML_PATH}"
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\DirectML.dll"
  RMDir "$INSTDIR"
!macroend
