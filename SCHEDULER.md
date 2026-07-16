# Automatic Update Schedule

The local dashboard uses Windows Task Scheduler for weekday updates. It runs only while the Windows user session is active.

## Schedule

- 08:15: refresh official disclosure events and targeted research-event cache.
- 14:15: refresh all shared sources, company data, prices, scores, and targeted research-event cache.
- 20:30: refresh disclosures, governance, violations, and targeted research-event cache.

## Install

```powershell
powershell -ExecutionPolicy Bypass -File tools\register-scheduled-update.ps1 -Action install
```

## Manual Run

```powershell
& "C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tools\scheduled-update.mjs --slot=market_close
```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File tools\register-scheduled-update.ps1 -Action uninstall
```
