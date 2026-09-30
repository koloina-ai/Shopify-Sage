@echo off
rem Demarrage automatique du connecteur (synchro, resume, page de suivi) : double-cliquer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer-auto.ps1" %*
