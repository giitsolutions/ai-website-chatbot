# Release Checklist

Use for every change before replacing the running server on port 3000.

## 1. Before changing code
- [ ] Note the running version: `curl http://localhost:3000/api/health`
- [ ] Record the data baseline (chatbot rows, Qdrant points)
- [ ] Back up files you will edit (`name.before-<change>-<timestamp>.js`); never overwrite existing backups

## 2. Test the release candidate on port 3001 (port 3000 keeps running)
```powershell
$env:PORT = "3001"; node server.js
```
In another window (set `TEST_BASE_URL=http://localhost:3001`; for `test:http` also set a throwaway
`ADMIN_API_KEY` for both the server and the test, or use the one in `.env`):
- [ ] `npm run check`
- [ ] `npm test` (run while the model is idle)
- [ ] `npm run test:ingest`
- [ ] `npm run test:http`
- [ ] `npm run test:answers` (alone; ~20 min)
- [ ] `npm run test:widget`
- [ ] `npm run test:runtime`
- [ ] Data counts equal the baseline

## 3. Deploy
- [ ] Snapshot the current release into `backups/release-<version>-<timestamp>/` with a `ROLLBACK.md`
- [ ] Stop only the process on port 3000; start `npm start`
- [ ] `/api/health` shows the new version and all dependencies `ok`

## 4. Verify on port 3000
- [ ] Non-public files return 404 (backups, tests, `.env`)
- [ ] `npm run test:http`, `npm run test:widget`, `npm run test:answers`
- [ ] Data counts equal the baseline
- [ ] Stop the temporary 3001 server

## 5. Roll back if anything fails
Follow `backups/release-old-.../ROLLBACK.md`, restart port 3000, re-check health.

## 6. Commit
- [ ] `git status` shows no secrets, backups or `.env*` files
- [ ] Secret scan of tracked files is clean
- [ ] Commit locally; push or publish only with explicit approval
