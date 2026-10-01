# Compact roster and full-height photos

These are **synthetic local previews** of the actual admin-served Studio HTML, renderer and production CSS, not installed-production acceptance. Names, member stats, image bytes and map tiles are fixtures. The silhouette deliberately tests an unusually tall image: contain-fit preserves the full body without a circular crop. Existing authorized profile-photo sourcing is unchanged; this change prepares the layout for progress pictures rather than choosing a new photo source.

- [Desktop roster crop](desktop-roster.png): small All members button above the rail, two member cards, full-height rectangular image, initials fallback.
- [320px sticky Studio](mobile-320-sticky.png): original real root-scroll fixture and measured mobile chrome; roster stays inside the unchanged <200px height budget, member rail can scroll horizontally without widening the document.

The real sticky test retains its exact 650px root and 950px workspace scroll targets, <2px tolerance, selectable-member and overflow assertions. Parent separately verified map/scopes/roster, photo/privacy/denial, neutral-theme and official browser/Coach smoke behavior. Final test totals and CI state are recorded in the PR body.
