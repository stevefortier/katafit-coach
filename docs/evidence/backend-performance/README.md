# Backend performance preview

These screenshots show the actual standalone Coach Diagnostics UI with **synthetic local data**, not production measurements.

The fixture exercises local backend requests, persisted Diagnostics receipts and the authenticated browser UI. Deliberately unknown-tool and historical descriptor-free records test the honest unavailable-name/duration fallbacks; they are not evidence of missing supported production call names.

- `desktop.png`: desktop performance breakdown and raw Diagnostics.
- `mobile.png`: mobile layout with named backend operations and sort/export controls.

The summary uses all retained backend receipts even when raw logs are filtered to Info. Its cumulative request time is not wall-clock elapsed time, and its window is not lifetime usage. Caller/turn attribution is not part of this change.
