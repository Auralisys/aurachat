@echo off
setlocal
rem Production launcher for AuraChat.
rem 1. Prefer the installed app (Tauri NSIS: %LOCALAPPDATA%\AuraChat).
rem 2. Fall back to a per-machine install, then to the local release build.
set "APP=%LOCALAPPDATA%\AuraChat\aurachat.exe"
if not exist "%APP%" set "APP=%ProgramFiles%\AuraChat\aurachat.exe"
if not exist "%APP%" set "APP=%~dp0src-tauri\target\release\AuraChat.exe"
if not exist "%APP%" (
  echo AuraChat non e' installato.
  echo Esegui l'installer in src-tauri\target\release\bundle\nsis\
  pause
  exit /b 1
)
start "" "%APP%"
