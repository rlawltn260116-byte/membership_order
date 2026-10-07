# Membership order background runner

GitHub Pages stores jobs in Firebase Realtime Database. A Cloud Run Job polls `order-ops/jobs`, claims `QUEUED` work transactionally, checks the Eroum session in a headless browser, and writes a detailed report back to the same job. The dashboard is the review and acceptance surface.

## Current scope

- Claims queued work and reports `RUNNING`, then `HOLD` or `AWAITING_REVIEW`.
- Writes worker identity, start/end timestamps, row counts, reason details, and a dashboard review state.
- Never submits an order. `report.canSubmit` is always `false`.
- Validates that a server-side Eroum browser session is present and active.
- DYJ-03 상품은 상품 매핑, 수량·재고·가격 확인, 주문서 배송지 입력과 HTML 필수값 검증까지 수행합니다.
- 최종 `주문하기` 버튼은 호출하지 않으며 준비 결과만 대시보드의 `AWAITING_REVIEW` 상태로 기록합니다.
- DA-006처럼 옵션 선택이 필요한 상품은 옵션 검증 어댑터가 추가될 때까지 `HOLD`로 기록합니다.

## GitHub Actions worker

The repository workflow `.github/workflows/order-worker.yml` runs every five minutes and can also be started manually. It checks Firebase for dashboard jobs in `QUEUED` status and returns a report to the same job. The user's PC and browser are not involved.

The Playwright dependency is pinned to the same version as the GitHub Actions browser container so the headless Chromium executable is always available.

Configure these GitHub Actions secrets before enabling the worker:

- `FIREBASE_DATABASE_URL`: the project's Realtime Database URL.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: a Firebase service account JSON with Realtime Database access.
- `EROUM_STORAGE_STATE_JSON`: Playwright storage state for the authorized Eroum account. Never commit it or put it in the dashboard.

`FIREBASE_QUEUE_PATH` defaults to `order-ops/jobs`; `WORKER_ID` is optional. Suggested state flow: `QUEUED → RUNNING → AWAITING_REVIEW → SUBMIT_QUEUED → COMPLETED`. Failures and unresolved fields remain `HOLD` or `FAILED`. The dashboard records review and any future final approval. A future submit adapter must verify explicit dashboard approval before it can submit.

## Build

Use Node.js 22 locally. The scheduled GitHub Actions runner uses the Playwright container image so Chromium is available. The Firebase service account JSON is read from the process environment and is never written into the repository.

```sh
npm install
npm run build
```
