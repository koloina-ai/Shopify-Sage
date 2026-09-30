@echo off
rem Arrete le demarrage automatique du connecteur : double-cliquer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer-auto.ps1" -Desinstaller %*
