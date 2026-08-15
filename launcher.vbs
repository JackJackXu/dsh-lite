' stableDSH launcher - hidden, no console (ASCII only)
Dim shell, appPath
Set shell = CreateObject("WScript.Shell")
appPath = "C:\MyMy\my_work\dsh_default\stableDSH"
shell.Run """" & appPath & "\node_modules\electron\dist\electron.exe"" """ & appPath & """", 0, False
