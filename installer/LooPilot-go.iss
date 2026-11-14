#ifndef AppVersion
  #define AppVersion "0.1"
#endif

#define AppName "LooPilot-go"
#define AppExe "LooPilot-go v" + AppVersion + ".exe"

[Setup]
AppId={{C4D5B761-9D76-4A7F-9B5B-7A0010010001}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\LooPilot-go
DefaultGroupName={#AppName}
OutputDir=..\dist-wails
OutputBaseFilename=LooPilot-go-Setup-v{#AppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
WizardStyle=modern
UninstallDisplayName={#AppName}

[Files]
Source: "..\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"

[Run]
Filename: "{app}\{#AppExe}"; Description: "启动 {#AppName}"; Flags: postinstall nowait skipifsilent
