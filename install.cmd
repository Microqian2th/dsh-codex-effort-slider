@echo off
rem better-dsh-codex-effort-slider installer (Windows wrapper).
rem Runs install-profile.ps1 with the execution policy bypassed for this run only
rem (no machine-wide policy change). Pass through args, e.g.:
rem   install.cmd -Profile tui
rem   install.cmd -Uninstall
setlocal
set "SCRIPT=%~dp0install-profile.ps1"
if not exist "%SCRIPT%" (
  echo Cannot find install-profile.ps1 next to this file.
  exit /b 1
)
where pwsh.exe >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
endlocal
