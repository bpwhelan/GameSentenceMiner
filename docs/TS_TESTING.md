# TypeScript Testing (Electron/Main)

This project now has two complementary TypeScript testing paths:

1. Unit tests (`vitest`) for fast feedback on TS modules.
2. Dev chaos harness for manual, high-stress update/startup failure simulation.

## 1) Unit Tests (Vitest)

Run once:

```bash
npm run test:ts
```

Watch mode:

```bash
npm run test:ts:watch
```

Current examples live in:

- `electron-src/main/services/dev_fault_injection.test.ts`
- `electron-src/main/services/update_chaos_harness.test.ts`

Use these as templates for new tests in `electron-src/main/**`.

## 2) Dev Chaos Harness (Manual Stress Testing)

Run full update/startup chaos scenarios:

```bash
npm run dev:chaos-update
```

This launches Electron with `--dev-chaos-update` and runs scenario-by-scenario fault injection across update/install/startup checkpoints, then attempts recovery and backend launch.

### Optional scenario filter

Run only specific checkpoints (comma-separated):

PowerShell:

```powershell
$env:GSM_CHAOS_SCENARIOS='update.sync_lockfile,startup.run_gsm'; npm run dev:chaos-update
```

Bash:

```bash
GSM_CHAOS_SCENARIOS=update.sync_lockfile,startup.run_gsm npm run dev:chaos-update
```

### Optional env failure plan (advanced)

You can force ad-hoc failures using:

`GSM_CHAOS_FAIL_PLAN='checkpoint:count,other_checkpoint:count'`

or JSON:

`GSM_CHAOS_FAIL_PLAN='{"checkpoint":1}'`

## Notes

- Chaos mode is intended for developer use.
- It is not part of CI/automated test suites by default.
- Scenario results are logged and summarized in a completion dialog.
