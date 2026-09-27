# Diagnostics Performance / Logs subtabs

Actual standalone Coach UI served by a local authenticated admin fixture using synthetic retained receipts, not production measurements or customer data. Captured by `tests/studio-backend-diagnostics.test.ts` with `COACH_EVIDENCE_DIR` set to the evidence directory.

Both panels were exercised at 1440, 390 and 320 CSS pixels; automated assertions verify no document overflow. The Logs capture intentionally uses All levels to expose successful Verbose and unsuccessful receipts; the application's default remains Info.

- Performance: [desktop](performance-1440.png), [mobile](performance-390.png), [narrow](performance-320.png).
- Logs: [desktop](logs-1440.png), [mobile](logs-390.png), [narrow](logs-320.png).

The earlier `../backend-performance/` screenshots document the pre-subtab layout and are superseded by these navigation previews.
