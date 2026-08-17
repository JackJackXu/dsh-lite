' DSH DLE launcher - hidden, no console (ASCII only)
' Resolves its own directory so the file works from any checkout location.
Dim shell, appDir, fso
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.Run """" & appDir & "\node_modules\electron\dist\electron.exe"" """ & appDir & """", 0, False
