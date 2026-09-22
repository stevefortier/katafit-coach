# Membership-baseline conversation guidance

Actual Studio HTML/JS served by the real admin component, with synthetic member API responses and inference. No customer data or production access. Desktop (1280px) and mobile (390px) full-page captures show membership-baseline message access, separate activity-category sharing and raw-attachment exclusion.

Reproduce with `COACH_EVIDENCE_DIR=<output> npm run test:coach-browser`. This browser test verifies member/roster empty and unavailable states, operator isolation, cancellation, Clear, pagination and mobile overflow. Browser proof is not backend authorization proof.

Validation: 235 standalone tests passed; build, format check, browser and production-only package smoke passed. Companion backend verification and deployment are separate gates. These screenshots supersede prior category-gated conversation guidance; historical screenshots remain unchanged.
