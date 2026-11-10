; HOLO installer additions (WP 5.5). Per user: everything is under HKCU and the user's own folder.

!include "FileFunc.nsh"
!include "WordFunc.nsh"

!macro customInstall
  ; The library server address, when IT gives one: HOLO-Setup.exe /S /SERVER_URL=https://viewer.internal
  ; It is written to viewer.json next to HOLO.exe, which the app reads first after its environment.
  ; GetOptions would cut the value at its first "/" (https://), so the value is everything after
  ; /SERVER_URL= up to the next space, with any quotes removed.
  ${GetParameters} $R0
  ClearErrors
  ${WordFind} $R0 "/SERVER_URL=" "E+1}" $R1
  ${IfNot} ${Errors}
    ${WordFind} $R1 " " "+1{" $R1
    ${WordReplace} $R1 '"' "" "+" $R1
  ${EndIf}
  ${IfNot} ${Errors}
  ${AndIf} $R1 != ""
    FileOpen $R2 "$INSTDIR\viewer.json" w
    FileWrite $R2 '{"serverUrl": "$R1"}$\r$\n'
    FileClose $R2
  ${EndIf}

  ; "Open with HOLO" for FBX, zip and JSON, without becoming their default program.
  WriteRegStr HKCU "Software\Classes\Applications\HOLO.exe\shell\open\command" "" '"$INSTDIR\HOLO.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\HOLO.exe" "FriendlyAppName" "HOLO"
  WriteRegStr HKCU "Software\Classes\Applications\HOLO.exe\SupportedTypes" ".glb" ""
  WriteRegStr HKCU "Software\Classes\Applications\HOLO.exe\SupportedTypes" ".gltf" ""
  WriteRegStr HKCU "Software\Classes\Applications\HOLO.exe\SupportedTypes" ".fbx" ""
  WriteRegStr HKCU "Software\Classes\Applications\HOLO.exe\SupportedTypes" ".zip" ""
  WriteRegStr HKCU "Software\Classes\Applications\HOLO.exe\SupportedTypes" ".json" ""
  WriteRegStr HKCU "Software\Classes\.fbx\OpenWithList\HOLO.exe" "" ""
  WriteRegStr HKCU "Software\Classes\.zip\OpenWithList\HOLO.exe" "" ""
  WriteRegStr HKCU "Software\Classes\.json\OpenWithList\HOLO.exe" "" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Applications\HOLO.exe"
  DeleteRegKey HKCU "Software\Classes\.fbx\OpenWithList\HOLO.exe"
  DeleteRegKey HKCU "Software\Classes\.zip\OpenWithList\HOLO.exe"
  DeleteRegKey HKCU "Software\Classes\.json\OpenWithList\HOLO.exe"
  Delete "$INSTDIR\viewer.json"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
