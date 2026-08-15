' Create stableDSH shortcut on desktop (ASCII only)
Dim ws, sc, desktop, lnk
Set ws = CreateObject("WScript.Shell")
desktop = ws.SpecialFolders("Desktop")
lnk = desktop & "\stableDSH.lnk"
Set sc = ws.CreateShortcut(lnk)
sc.TargetPath = "C:\MyMy\my_work\dsh_default\stableDSH\node_modules\electron\dist\electron.exe"
sc.Arguments = """C:\MyMy\my_work\dsh_default\stableDSH"""
sc.WorkingDirectory = "C:\MyMy\my_work\dsh_default\stableDSH"
sc.IconLocation = "C:\MyMy\my_work\dsh_default\stableDSH\assets\icon.ico,0"
sc.Description = "stableDSH - DeepSeek Harness desktop app"
sc.Save
MsgBox "stableDSH shortcut ready."
