; Rigsmith for Windows: one installer for the app and the VST3 plugin.
; Build (Inno Setup 6):  iscc /DAppVersion=1.0.0 /DAppDir=<folder with Rigsmith.exe, ui and VST3> /O<out folder> Rigsmith.iss
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppDir
  #define AppDir "..\..\dist-app"
#endif

[Setup]
AppId={{8F6C0A64-3E52-4C3B-9A63-5E1B1F0C2D71}
AppName=Rigsmith
AppVersion={#AppVersion}
AppPublisher=Rigsmith
AppPublisherURL=https://github.com/SarthakSahoo1407/rigsmith
AppSupportURL=https://github.com/SarthakSahoo1407/rigsmith/issues
DefaultDirName={autopf}\Rigsmith
DefaultGroupName=Rigsmith
OutputBaseFilename=Rigsmith-Setup-Windows
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; The VST3 folder is under Program Files, which needs administrator rights.
PrivilegesRequired=admin
UninstallDisplayIcon={app}\Rigsmith.exe
DisableProgramGroupPage=yes

[Tasks]
Name: "vst3"; Description: "Install the VST3 plugin (for Reaper, Cubase, Studio One and other DAWs)"; GroupDescription: "Plugin:"
Name: "desktopicon"; Description: "Add a shortcut to the desktop"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#AppDir}\Rigsmith.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppDir}\ui\*"; DestDir: "{app}\ui"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#AppDir}\VST3\Rigsmith.vst3\*"; DestDir: "{commoncf64}\VST3\Rigsmith.vst3"; Flags: ignoreversion recursesubdirs createallsubdirs; Tasks: vst3

[Icons]
Name: "{group}\Rigsmith"; Filename: "{app}\Rigsmith.exe"
Name: "{group}\Uninstall Rigsmith"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Rigsmith"; Filename: "{app}\Rigsmith.exe"; Tasks: desktopicon

[Run]
; Rigsmith draws its screen with Edge WebView2. Windows 11 and current Windows 10 have it; install it if not.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""$f = Join-Path $env:TEMP 'MicrosoftEdgeWebview2Setup.exe'; Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $f; Start-Process $f -ArgumentList '/silent','/install' -Wait"""; StatusMsg: "Installing the Microsoft Edge WebView2 runtime..."; Flags: runhidden; Check: WebView2Missing
Filename: "{app}\Rigsmith.exe"; Description: "Open Rigsmith"; Flags: nowait postinstall skipifsilent

[Code]
function WebView2Missing: Boolean;
var
  version: String;
begin
  Result := not (RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', version)
             or RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', version))
            or (version = '') or (version = '0.0.0.0');
end;
