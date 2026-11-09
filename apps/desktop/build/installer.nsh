; VIEWER installer additions (WP 5.5). Per user: everything is under HKCU and the user's own folder.

!include "FileFunc.nsh"

!macro customInstall
  ; The library server address, when IT gives one: VIEWER-Setup.exe /S /SERVER_URL=https://viewer.internal
  ; It is written to viewer.json next to VIEWER.exe, which the app reads first after its environment.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/SERVER_URL=" $R1
  ${IfNot} ${Errors}
  ${AndIf} $R1 != ""
    FileOpen $R2 "$INSTDIR\viewer.json" w
    FileWrite $R2 '{"serverUrl": "$R1"}$\r$\n'
    FileClose $R2
  ${EndIf}

  ; "Open with VIEWER" for FBX, zip and JSON, without becoming their default program.
  WriteRegStr HKCU "Software\Classes\Applications\VIEWER.exe\shell\open\command" "" '"$INSTDIR\VIEWER.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\VIEWER.exe" "FriendlyAppName" "VIEWER"
  WriteRegStr HKCU "Software\Classes\Applications\VIEWER.exe\SupportedTypes" ".glb" ""
  WriteRegStr HKCU "Software\Classes\Applications\VIEWER.exe\SupportedTypes" ".gltf" ""
  WriteRegStr HKCU "Software\Classes\Applications\VIEWER.exe\SupportedTypes" ".fbx" ""
  WriteRegStr HKCU "Software\Classes\Applications\VIEWER.exe\SupportedTypes" ".zip" ""
  WriteRegStr HKCU "Software\Classes\Applications\VIEWER.exe\SupportedTypes" ".json" ""
  WriteRegStr HKCU "Software\Classes\.fbx\OpenWithList\VIEWER.exe" "" ""
  WriteRegStr HKCU "Software\Classes\.zip\OpenWithList\VIEWER.exe" "" ""
  WriteRegStr HKCU "Software\Classes\.json\OpenWithList\VIEWER.exe" "" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Applications\VIEWER.exe"
  DeleteRegKey HKCU "Software\Classes\.fbx\OpenWithList\VIEWER.exe"
  DeleteRegKey HKCU "Software\Classes\.zip\OpenWithList\VIEWER.exe"
  DeleteRegKey HKCU "Software\Classes\.json\OpenWithList\VIEWER.exe"
  Delete "$INSTDIR\viewer.json"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
