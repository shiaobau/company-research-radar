# Automatic Update Schedule

The local dashboard uses Windows Task Scheduler for weekday updates. It runs only while the Windows user session is active.

## Schedule

- 08:15 and 20:30: each runs a full refresh of shared sources, company data, prices, scores, targeted research-event cache, and completeness validation.

## Install

```powershell
powershell -ExecutionPolicy Bypass -File tools\register-scheduled-update.ps1 -Action install
```

## Manual Run

```powershell
& "C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tools\scheduled-update.mjs --slot=morning
```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File tools\register-scheduled-update.ps1 -Action uninstall
```
