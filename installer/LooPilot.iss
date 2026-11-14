#define AppName "LooPilot"
#define AppVersion "1.0.2"

[Setup]
AppId={{A8C84B1F-4B65-4E0B-9E2E-202604020001}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\LooPilot
DefaultGroupName={#AppName}
OutputDir=..\dist
OutputBaseFilename=LooPilot-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
WizardStyle=modern

[Files]
Source: "..\dist\LooPilot.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\packaging\windows\LoopilotLauncher.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\packaging\windows\LoopilotLauncher.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\packaging\windows\config.example.json"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\LooPilot"; Filename: "{app}\LoopilotLauncher.cmd"; Parameters: "normal"; WorkingDir: "{app}"
Name: "{group}\LooPilot (Safe Queue)"; Filename: "{app}\LoopilotLauncher.cmd"; Parameters: "safe"; WorkingDir: "{app}"
Name: "{group}\LooPilot (Temporary Tunnel)"; Filename: "{app}\LoopilotLauncher.cmd"; Parameters: "public"; WorkingDir: "{app}"
Name: "{group}\LooPilot (Custom Tunnel)"; Filename: "{app}\LoopilotLauncher.cmd"; Parameters: "custom"; WorkingDir: "{app}"
Name: "{userdesktop}\LooPilot"; Filename: "{app}\LoopilotLauncher.cmd"; Parameters: "normal"; WorkingDir: "{app}"

[Dirs]
Name: "{userappdata}\LooPilot"

[Run]
Filename: "{app}\LoopilotLauncher.cmd"; Parameters: "normal"; Description: "Start LooPilot"; Flags: postinstall nowait skipifsilent

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigPath: String;
begin
  if CurStep = ssPostInstall then begin
    ConfigPath := ExpandConstant('{userappdata}\LooPilot\config.json');
    if not FileExists(ConfigPath) then
      SaveStringToFile(ConfigPath, '{' + #13#10 + '  "host": "127.0.0.1",' + #13#10 + '  "port": 4317,' + #13#10 + '  "tunnelCommand": "",' + #13#10 + '  "tunnelArgs": [],' + #13#10 + '  "tunnelUrl": "",' + #13#10 + '  "tunnelCwd": ""' + #13#10 + '}' + #13#10, False);
  end;
end;
