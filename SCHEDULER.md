# Automatic Update Schedule

The dashboard supports two weekday refresh methods. GitHub Actions is the preferred method for the published GitHub Pages site because it does not require a local computer to remain open. Windows Task Scheduler remains available for local-only use.

## Schedule

- 08:15 and 20:30: each runs a full refresh of shared sources, company data, prices, scores, targeted research-event cache, and completeness validation.

## GitHub Pages

`.github/workflows/deploy-pages.yml` runs the same full refresh at 08:15 and 20:30 Taiwan time on weekdays, commits any changed public data back to `main`, then deploys the refreshed static site. It can also be run manually from the repository's **Actions** page by choosing **Deploy static dashboard to GitHub Pages** and **Run workflow**.

Scheduled GitHub workflows are best-effort: GitHub may start them a few minutes late when its shared runners are busy. The workflow records the actual completion time in `data/scheduler_status.json`.

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
