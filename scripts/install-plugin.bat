@echo off
rem install-plugin.bat - install a DSH plugin bundle into stableDSH (ASCII only)
rem usage: install-plugin.bat <path-to-plugin-bundle>
setlocal
set "DATA=%LOCALAPPDATA%\stableDSH"
rem %~dp0 ends with a backslash and is the scripts\ dir; go up one level to the project root
set "RES=%~dp0..\resources"
set "DENTRY=%RES%\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"

if "%~1"=="" (
  echo usage: install-plugin.bat ^<path-to-plugin-bundle^>
  exit /b 1
)
if not exist "%RES%\node\node.exe" (
  echo [stableDSH] bundled node not found. Run: node scripts\fetch-resources.js
  exit /b 1
)
if not exist "%DENTRY%" (
  echo [stableDSH] bundled dsh not found. Run: node scripts\fetch-resources.js
  exit /b 1
)

set "PATH=%RES%\dsh\node_modules\.bin;%PATH%"
set "DSH_HOME=%DATA%"
echo [stableDSH] installing plugin into %DATA% ...
"%RES%\node\node.exe" "%DENTRY%" plugin --profile web add "%~1"
set "EC=%ERRORLEVEL%"
if "%EC%"=="0" (
  echo [stableDSH] plugin installed. Restart stableDSH (tray menu: Restart DSH Service).
) else (
  echo [stableDSH] plugin install failed with code %EC%.
)
endlocal & exit /b %EC%
