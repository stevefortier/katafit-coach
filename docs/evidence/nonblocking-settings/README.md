# Nonblocking settings — synthetic served-Studio evidence

These screenshots were captured from the actual Studio document and admin server using disposable configuration storage and synthetic backend/provider boundaries. They are not screenshots of Warden or proof of an installed production upgrade.

- `b1-second-save-while-stop-held.png`: a second settings revision has saved while native Stop remains held. The form and Save remain enabled; the lifecycle separately reports background stopping.
- `b5-saved-refresh-failed.png`: the settings POST committed, but the following settings GET failed. The notice explicitly says Saved and warns that the saved view could not refresh; its displayed revision can therefore remain stale.

Behavioral reproduction lives in `tests/nonblocking-settings-browser.test.ts`. The complete browser suite also exercises no status preflight/confirmation, save during preview, lost-response readback without locking/replay, a still-pending original write after unchanged readback, and honest restart-pending presentation.
