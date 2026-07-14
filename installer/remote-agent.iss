; Inno Setup script for the Remote Support Agent (Windows).
;
; Builds a signed-ready installer that:
;   1. installs remote-agent.exe under Program Files,
;   2. asks the operator for the backend URLs + one-time enrollment token,
;   3. enrolls the device once (persisting a DPAPI-protected device token),
;   4. registers the agent to auto-start at logon (`remote-agent install`).
;
; The enrollment token is used only during install and is never stored on disk;
; only the DPAPI-protected device token persists. There is no hidden/silent mode
; — the agent always shows the consent banner when a session starts.
;
; Compile with:  iscc installer\remote-agent.iss
; (Expects the release binary at ..\agent-rust\target\release\remote-agent.exe)

#define AppName "Remote Support Agent"
#define AppVersion "0.1.0"
#define AppPublisher "Remote Support MVP"
#define ExeName "remote-agent.exe"

[Setup]
AppId={{7C3A9E52-6B1D-4F0A-9E2C-REMOTESUPPORT}}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\RemoteSupportAgent
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=remote-agent-setup-{#AppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
; Per-user install so screen capture runs in the interactive desktop session.
PrivilegesRequired=lowest
UninstallDisplayName={#AppName}

[Files]
Source: "..\agent-rust\target\release\{#ExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#ExeName}"

[Code]
var
  ConfigPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  ConfigPage := CreateInputQueryPage(wpSelectDir,
    'Connect to your backend',
    'Enter the details your administrator gave you.',
    'These are used once to enroll this device. The one-time enrollment token is not stored on disk.');
  ConfigPage.Add('Backend API URL (e.g. https://support.example.com):', False);
  ConfigPage.Add('Backend WebSocket URL (e.g. wss://support.example.com):', False);
  ConfigPage.Add('Enrollment token:', True);   { masked }
  ConfigPage.Values[0] := 'http://localhost:8080';
  ConfigPage.Values[1] := 'ws://localhost:8080';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = ConfigPage.ID) then
  begin
    if (ConfigPage.Values[0] = '') or (ConfigPage.Values[1] = '') or (ConfigPage.Values[2] = '') then
    begin
      MsgBox('Please fill in the API URL, WebSocket URL, and enrollment token.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Exe, ApiBase, WsBase, Token, Params: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    Exe := ExpandConstant('{app}\{#ExeName}');
    ApiBase := ConfigPage.Values[0];
    WsBase := ConfigPage.Values[1];
    Token := ConfigPage.Values[2];

    { 1. Enroll once — persists a DPAPI-protected device token. }
    Params := 'enroll --api-base "' + ApiBase + '" --ws-base "' + WsBase +
              '" --enrollment-token "' + Token + '"';
    if not Exec(Exe, Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      MsgBox('Enrollment did not complete (exit ' + IntToStr(ResultCode) + ').' + #13#10 +
             'You can retry later from a terminal with:' + #13#10 + Exe + ' ' + Params,
             mbInformation, MB_OK);

    { 2. Register auto-start at logon (backend URLs baked in; no token stored). }
    Params := 'install --api-base "' + ApiBase + '" --ws-base "' + WsBase + '"';
    Exec(Exe, Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

[UninstallRun]
; Remove the auto-start registration before files are deleted.
Filename: "{app}\{#ExeName}"; Parameters: "uninstall"; Flags: runhidden; RunOnceId: "RemoveAutostart"
