# Membership order background runner

GitHub Pages stores jobs in Firebase Realtime Database. A Cloud Run Job polls `order-ops/jobs`, claims `QUEUED` work transactionally, checks the Eroum session in a headless browser, and writes a detailed report back to the same job. The dashboard is the review and acceptance surface.

## Current scope

- Claims queued work and reports `RUNNING`, then `HOLD` or `AWAITING_REVIEW`.
- Writes worker identity, start/end timestamps, row counts, reason details, and a dashboard review state.
- Never submits an order. `report.canSubmit` is always `false`.
- Validates that a server-side Eroum browser session is present and active.
- DYJ-03·DA-006 상품은 상품 매핑, (필요 시) 색상 옵션 선택, 수량·가격 확인, 주문서 배송지 입력과 HTML 필수값 검증까지 수행합니다.
- 이로움의 `My 보유 재고`는 이로움 재고가 아니라 구매자의 과거 주문 수량이므로 재고 부족으로 보류하지 않습니다. 대신 출고지연·`N/N일 출고 예정`·출고 일정 확인 중·품절 안내를 찾아 행별 `shippingNotes`와 리포트의 `shippingNoticeRows`로 따로 기록합니다.
- 최종 `주문하기` 버튼은 호출하지 않으며 준비 결과만 대시보드의 `AWAITING_REVIEW` 상태로 기록합니다.
- 옵션(색상)은 주문 파일의 `option`(색상/옵션) 열 값으로 선택하고, 비어 있으면 상품명에 적힌 색상을 사용합니다. 값이 없거나 이로움에서 옵션을 찾지 못하면 `HOLD`로 기록합니다.

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

## THKC 발주서 학습 데이터

`data/thkc-learned-catalog.json`에는 2026-08-03부터 2026-10-07까지의 THKC 발주서 86개에서 학습한 열 구조, 상품명·모델·옵션 표기, 주문 유형과 검증 규칙이 저장됩니다. 고객명, 주소, 전화번호, 주문번호 같은 주문 원문은 포함하지 않습니다.

- 기본 열: 주문번호, 납품처, 납품처전화번호, 품명, 주문수량, 비고(내역)
- 납품처: 마지막 밑줄을 우선 사용하고 공백이 포함된 마지막 슬래시를 보조 구분자로 사용해 주소와 수취인을 나눕니다.
- 우편번호: 원본에 없으므로 주소 검색으로 보완해야 합니다.
- 주문번호가 없거나 `THK`인 행은 고객 주문과 분리한 지점·재고 주문 후보로 검토합니다.
- 한 주문번호에 두 품목이 있는 경우 한 주문의 복수 상품 행으로 묶습니다.
- 상품 ID와 사이트 옵션값은 이로움 상품 화면에서 별도로 확인한 뒤 실행 매핑에 등록합니다.

로컬 재분석은 고객정보가 포함된 결과를 `.local-analysis/`에만 저장하며 이 폴더는 Git에서 제외됩니다.
