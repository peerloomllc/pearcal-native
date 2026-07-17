' PearCal Seeder - open the localhost dashboard in the default browser.
'
' The monitoring UI is gated by a per-install auth token. This reads the
' token from the machine-wide data directory and opens the UI URL. Run
' windowless via wscript; the Start Menu shortcut targets this file.

Option Explicit

Dim fso, shell, dataDir, tokenPath, token, stream

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

dataDir = shell.ExpandEnvironmentStrings("%ProgramData%") & "\PearCal Seeder"
tokenPath = dataDir & "\auth.token"

If Not fso.FileExists(tokenPath) Then
  MsgBox "PearCal Seeder has not finished starting yet." & vbCrLf & _
         "Wait a few seconds and open it again from the Start Menu.", _
         vbExclamation, "PearCal Seeder"
  WScript.Quit 1
End If

Set stream = fso.OpenTextFile(tokenPath, 1)
token = Trim(stream.ReadAll())
stream.Close

shell.Run "http://127.0.0.1:8731/?t=" & token, 1, False
