# Settings subtabs — local synthetic UI evidence

Actual standalone Coach Studio UI from the `feat/settings-subtabs` worktree (source committed as `b19c771efbd757a0254a984e5f600270ec4d5de5`), rendered through a local admin server with a temporary on-disk Store. No production account or customer data. The update endpoint was stubbed; these screenshots do not prove an installed production upgrade.

- `persona-desktop.png`: 1440px-wide desktop, Persona selected.
- `persona-mobile.png`: 390px-wide mobile, Persona selected.

Independent browser checks verified a single visible panel across all six subtabs; Connection and Persona drafts survive switching, persist after Save, and reload correctly; no horizontal overflow at 320/390/1440px; zero browser page errors.

Screenshots were taken after scrolling to the top so the sticky header does not obscure the content.
