# hamms-launcher
HAMMS Studios launcher: download, update and play every HAMMS game.

Electron app. The store data comes from `hamms-games` (`config.json` → `catalogUrl`); accounts use Supabase.

- `main.js`: window, IPC, self-update (electron-updater, from this repo's releases)
- `src/gameManager.js`: catalog, install/update/uninstall, per-account library, launch
- `src/account.js`: HAMMS accounts
- `src/handoff.js`: launch ticket + `--hamms-user` / `--hamms-uid` passed to games
- `renderer/`: the launcher UI
- `store-bundle/`: offline copy of the store shipped inside the app

## Releasing
Bump `version` in `package.json`, build the installer, and publish a GitHub release tagged `v<version>` with
`HAMMS-Studios-Setup-<version>.exe`, its `.blockmap`, and `latest.yml`. Installed launchers update themselves from it.
