# Studio source-update browser evidence

Actual Studio HTML/CSS/JavaScript rendered in Chromium against the real authenticated local admin HTTP server and update-state implementation. The GitHub response and installer are **synthetic fixtures** with explicit `aaaa…`, `bbbb…`, and `cccc…` revisions. These images do not establish a real GitHub installation, container source upgrade, production deployment or live model reply.

## Browser checks

Run `npm run test:updates-browser` (Chrome required; `CHROME_PATH` supported). The harness uses disposable credentials/state and closes its browser and server.

- Automatic source check after unlock; checking alone never installs.
- Explicit full-revision confirmation; dismissing it does not install.
- Unsaved configuration edits block upgrade confirmation.
- Applying disables conflicting controls; connection loss is shown as unconfirmed/reconnecting rather than success.
- Successful completion displays the verified installed revision and offers refreshed Studio assets.
- A failed synthetic installer leaves the prior installed revision visible; raw installer error text is not rendered.
- Reload retains authentication in this tab's session storage; Lock studio clears it. The credential is removed from the fragment and from the login input.
- Desktop width 1280 and mobile width 360; the full revision wraps without horizontal overflow.

## Images

- [Desktop update available](studio-updates-desktop.png)
- [Mobile explicit revision confirmation](studio-updates-mobile.png)
- [Failed installer, prior revision retained](studio-updates-failure.png)

## Other verification boundaries

`node scripts/docker-smoke.mjs` exercises the actual non-root Docker image with a disposable named data volume, authenticated endpoints, exact build revision when `COACH_EXPECTED_REVISION` is supplied, preserved credentials/configuration through normal container replacement, and recovery after forced container termination. It explicitly reports `sourceUpgradeTested: false`; source-update and rollback lifecycle proof belongs to the separate updater integration tests, not this Docker startup smoke.

The previous PID-file-only launcher failed the forced-termination replacement test because both old and new container processes used PID 7. The kernel-lock launcher passes this regression without requiring deletion of the data volume.

Final verification includes 195 passing tests, build/format checks, normal production-only packed install, and both browser suites. The updater browser regression also verifies that expired remembered credentials and active-session 401s return to login without continued polling, late status cannot repaint a locked session, and an older 401 cannot revoke a newer unlock.

Disk-monitor regressions reproduce files/directories disappearing after enumeration and a delayed scan completing after a child exits. Normal installer churn is tolerated; permission failures and the actual sparse-file size limit remain fail-closed. A CPU-constrained, `--init` Docker run also verified healthy cold startup beyond the original five-second fixture deadline.

Machine-readable receipts captured from actual execution:

- [Host packed upgrade lifecycle](host-packed-upgrade.json)
- [Non-root Docker packed upgrade lifecycle](docker-packed-upgrade.json)

Both use actual Git/npm staging, compiled source, installed CLI processes and authenticated admin requests. Only the GitHub/Git source boundary is redirected through a test-only Node preload to disposable local fixture commits. They prove upgrade → startup-failure rollback → another upgrade, unchanged config/secrets, retained versions and restart/crash recovery; they do not claim that any public upstream version was deployed. The Docker lifecycle receipt covers the final backend lifecycle and installer disk-monitor fixes. Browser regressions separately cover frontend authentication and reconnect behavior. The separate Docker smoke covers container recreation on a persistent named volume, including forced-kill recovery and exact clean-build identity in CI.

No customer/production state or real-provider inference was used in this updater verification.
