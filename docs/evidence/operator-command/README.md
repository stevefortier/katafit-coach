# Synthetic actual-Studio UI evidence

Actual production Studio UI in headless Chromium at desktop/mobile viewports, with synthetic HTTP fixtures. No customer data or real customer messages. The photo is deliberately labeled SYNTHETIC PHOTO / Transport fixture.

- `thread-{desktop,mobile}.png`: member messages and Coach replies have distinct sides and attribution; generated insight remains a separate item.
- `activities-{desktop,mobile}.png`: lazy shared workout recorded set, meal ingredients/stored nutrition and original image transport fixture. This proves browser rendering, not backend authorization.
- `keyboard-{desktop,mobile}.png`: manager/recipient UI and multiline composer.

Reproduce through `npx tsx --test tests/studio-keyboard.test.ts tests/studio-member-thread.test.ts tests/studio-activity-browser.test.ts`. Tests cover Enter send, Shift+Enter newline, composition/repeat/disabled guards, recipient payloads, pagination, activity grouping, bounded JSON/image reads, collapse cleanup and stale cross-member responses.

Backend authorization, real MCP and packed provider/recipient persistence are separate acceptance gates; these screenshots alone do not prove them. No production deployment is claimed.
