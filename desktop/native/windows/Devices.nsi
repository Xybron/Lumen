Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
Name "Lumen Camera and Microphone"
OutFile "${ARTIFACTS}\LumenDevicesSetup.exe"
InstallDir "$PROGRAMFILES64\Lumen\Devices"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Lumen devices require 64-bit Windows."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Lumen devices require Windows 10 version 2004 or newer, or Windows 11."
    Abort
  ${EndIf}
  SetRegView 64
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $0 < 19041
    MessageBox MB_ICONSTOP "Update Windows to version 2004 (build 19041) or newer before installing Lumen devices."
    Abort
  ${EndIf}
FunctionEnd

Section "Lumen devices"
  SetRegView 64
  ${DisableX64FSRedirection}
  SetOutPath "$INSTDIR"
  File "${ARTIFACTS}\LumenCamera.dll"
  File "${ARTIFACTS}\LumenDeviceBridge.exe"
  File "${ARTIFACTS}\LumenAudio.inf"
  File "${ARTIFACTS}\LumenAudio.cat"
  File "${ARTIFACTS}\LumenAudio.sys"
  File "${ARTIFACTS}\SOFTCAM-LICENSE.txt"
  File "${ARTIFACTS}\AUDIO-DRIVER-LICENSE.txt"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LumenDevices" "DisplayName" "Lumen Camera and Microphone"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LumenDevices" "Publisher" "Lumen"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LumenDevices" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LumenDevices" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LumenDevices" "NoRepair" 1
  ExecWait '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\LumenCamera.dll"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Windows could not register Lumen Camera. Close apps using the camera and retry."
    Abort
  ${EndIf}
  ExecWait '"$INSTDIR\LumenDeviceBridge.exe" install-audio "$INSTDIR\LumenAudio.inf"' $0
  ${If} $0 == 3010
    SetRebootFlag true
  ${ElseIf} $0 != 0
    MessageBox MB_ICONSTOP "Windows could not install Lumen Microphone. The driver package must be Microsoft-signed. Setup can be retried or removed from Windows Installed apps."
    Abort
  ${EndIf}
  ${EnableX64FSRedirection}
SectionEnd

Section "Uninstall"
  SetRegView 64
  ${DisableX64FSRedirection}
  ExecWait '"$INSTDIR\LumenDeviceBridge.exe" remove-audio "$INSTDIR\LumenAudio.inf"' $0
  ${If} $0 == 3010
    SetRebootFlag true
  ${ElseIf} $0 != 0
    MessageBox MB_ICONSTOP "Close apps using Lumen audio, then run this uninstaller again."
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\regsvr32.exe" /u /s "$INSTDIR\LumenCamera.dll"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Close apps using Lumen Camera, then run this uninstaller again."
    Abort
  ${EndIf}
  Delete "$INSTDIR\LumenCamera.dll"
  Delete "$INSTDIR\LumenDeviceBridge.exe"
  Delete "$INSTDIR\LumenAudio.inf"
  Delete "$INSTDIR\LumenAudio.cat"
  Delete "$INSTDIR\LumenAudio.sys"
  Delete "$INSTDIR\SOFTCAM-LICENSE.txt"
  Delete "$INSTDIR\AUDIO-DRIVER-LICENSE.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LumenDevices"
  ${EnableX64FSRedirection}
SectionEnd
