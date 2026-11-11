# Membership order background runner

GitHub Pages stores jobs in Firebase Realtime Database. A Cloud Run Job polls `order-ops/jobs`, claims `QUEUED` work transactionally, checks the Eroum session in a headless browser, and writes a detailed report back to the same job. The dashboard is the review and acceptance surface.

## Current scope

- Claims queued work and reports `RUNNING`, then `HOLD` or `AWAITING_REVIEW`.
- Writes worker identity, start/end timestamps, row counts, reason details, and a dashboard review state.
- 준비 실행은 주문을 제출하지 않습니다. 준비 성공 후 운영 페이지에서 `검토 수락`과 `주문 확정`을 차례로 승인한 1행 작업만 실제 제출할 수 있습니다.
- Validates that a server-side Eroum browser session is present and active.
- DYJ-03·DA-006 상품은 상품 매핑, (필요 시) 색상 옵션 선택, 수량·가격 확인, 주문서 배송지 입력과 HTML 필수값 검증까지 수행합니다.
- 이로움의 `My 보유 재고`는 이로움 재고가 아니라 구매자의 과거 주문 수량이므로 재고 부족으로 보류하지 않습니다. 대신 출고지연·`N/N일 출고 예정`·출고 일정 확인 중·품절 안내를 찾아 행별 `shippingNotes`와 리포트의 `shippingNoticeRows`로 따로 기록합니다.
- 준비 단계에서는 최종 `주문하기` 버튼을 호출하지 않고 `AWAITING_REVIEW`로 기록합니다. 실제 제출은 승인 코드가 일치하는 `SUBMIT_QUEUED` 작업만 처리합니다.
- 실제 제출 직전에 Firebase에 행별 `SUBMITTING` 잠금을 먼저 저장합니다. 제출 결과가 불명확하면 `UNKNOWN`으로 멈추고 자동 재시도하지 않아 중복 주문을 방지합니다.
- 일회성 최종 승인 요청번호는 GitHub Actions 저장소 변수에도 사용 완료로 먼저 기록합니다. 공개 Firebase 값이 재전송되더라도 같은 승인으로 주문을 다시 넣지 않습니다.
- 현재 실제 제출은 한 번에 1행만 허용합니다. 같은 주문번호의 복수 품목 묶음 제출은 별도 구현 전까지 차단합니다.
- 옵션(색상)은 주문 파일의 `option`(색상/옵션) 열 값으로 선택하고, 비어 있으면 상품명에 적힌 색상을 사용합니다. 값이 없거나 이로움에서 옵션을 찾지 못하면 `HOLD`로 기록합니다.

## GitHub Actions worker

The repository workflow `.github/workflows/order-worker.yml` runs every five minutes and can also be started manually. It checks Firebase for dashboard jobs in `QUEUED` status and returns a report to the same job. The user's PC and browser are not involved.

The Playwright dependency is pinned to the same version as the GitHub Actions browser container so the headless Chromium executable is always available.

Configure these GitHub Actions secrets before enabling the worker:

- `FIREBASE_DATABASE_URL`: the project's Realtime Database URL.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: a Firebase service account JSON with Realtime Database access.
- `EROUM_STORAGE_STATE_JSON`: Playwright storage state for the authorized Eroum account. Never commit it or put it in the dashboard.
- `FINAL_SUBMISSION_APPROVAL_KEY`: 12자 이상의 최종 승인 코드. 운영 페이지는 원문을 저장하지 않고 작업 ID와 일회성 요청번호를 포함한 SHA-256 증명값만 Firebase에 저장합니다.
- `B2B_SUBMISSION_LEDGER_KEY`: 원본 행 식별자를 공개 원장에 HMAC으로 남길 때 쓰는 별도 고정 비밀 키(32자 이상). HTTP와 기존 Playwright가 함께 사용한다. 2026-11-11부터 `process-queue`의 큐 처리 단계에 주입한다. 지금은 실제 제출을 하지 않는다. 이 키가 없는 경우에는 원장 예약 전에 HOLD한다.

`FIREBASE_QUEUE_PATH` defaults to `order-ops/jobs`; `WORKER_ID` is optional. State flow: `QUEUED → RUNNING → AWAITING_REVIEW → REVIEWED → SUBMIT_QUEUED → RUNNING → COMPLETED`. Failures and unresolved fields remain `HOLD` or `FAILED`. 최종 제출 워커는 검토 수락, 최종 승인, 승인 코드 증명값을 모두 다시 확인합니다.

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

## 직배 발주 시간표

`data/direct-delivery-schedule.json`에는 업체별 발주마감, 접수마감, 발주수단, 비고가 한국시간 기준으로 저장됩니다. 이 저장소는 공개이므로 회사코드, ID, 비밀번호, 업체 이메일·팩스 번호는 넣지 않습니다. 사이트 로그인 정보가 필요하면 GitHub Actions secret으로 주입합니다. 운영 화면의 업체 분류와 마감 안내, 워커의 준비 예약이 이 파일을 공통 기준으로 사용합니다.

### 시간표 기반 준비 예약

운영 화면에서 저장한 작업의 `시간표로 준비 예약`을 누르면 다음 발주마감에 `PREPARE` 작업을 실행합니다. 한국시간 기준 주말을 건너뛰며 공휴일은 별도 확인이 필요합니다. 같은 업체의 여러 회차는 다음 회차를 선택합니다. 그레이스케일처럼 마감 시각이 없는 업체는 예약 대상에서 제외됩니다. 예약 상태는 `QUEUED`, 시각과 접수마감은 `scheduledPreparation`에 기록합니다.

즉시실행기는 예약 시각 전에는 워커를 호출하지 않고 워커도 선점 시 예약 시각을 재확인합니다. 접수마감이 지나 실행되면 `HOLD`로 남기며 다음 회차로 임의 이월하지 않습니다. GitHub Actions 예약은 지연될 수 있으므로 정확한 시각 실행을 보장하지 않습니다. Apps Script 변경은 운영 프로젝트에 별도로 반영해야 합니다.

기본 경로는 기존 이로움 Playwright입니다. 보필은 아래 HTTP 준비 경로를 선택할 수 있으며 나머지 업체는 미지원 채널로 보류됩니다. 메일·팩스·카톡은 자동 발송하지 않습니다. 검토 수락·최종 승인·1행 제한·제출 잠금·원장은 유지됩니다. 이 예약은 준비 작업에만 적용되며 최종 승인은 기존 30분 유효기간 안에 즉시 처리됩니다.

검증: `node --test worker/order-runner/schedule.test.mjs` (실제 주문·발송 없이 실행).

새 예약 기능은 기본 꺼짐입니다. 학습·준비 단계에서는 켜지 않습니다. 추후 별도 운영 승인을 받은 뒤에만 화면 빌드 환경의 `NEXT_PUBLIC_ENABLE_ORDER_PREPARATION_SCHEDULING`, 워커 환경의 `ENABLE_ORDER_PREPARATION_SCHEDULING`, 즉시실행기 스크립트 속성의 `ENABLE_ORDER_PREPARATION_SCHEDULING`을 모두 `true`로 설정해야 예약 준비가 실행됩니다. 현재 워크플로에는 활성화 변수를 주입하지 않습니다.

## 이로움·보필 HTTP 장바구니 준비 (기본 꺼짐)

브라우저 없이 로그인하고 고정 시험 상품으로 장바구니·주문서 초안을 확인하는 준비 경로다. **주문 제출 함수는 없다.** 이로움은 상품 검사·검색 조회 후 저장된 `select_item`과 같은 상품 필드로 메모리 초안을 만들고, 보필은 시험 상품 1개 담기 → 전체 상품 주문 GET → `직접 입력` 초안 → 시험 행 삭제 → 빈 장바구니 확인을 한다. 위 Playwright 주문 흐름, 승인 절차, `SUBMITTING` 잠금, 제출 원장, 1행 제한, `FINAL_SUBMISSION_APPROVAL_KEY` 검증과는 코드를 공유하지 않는다.

- 켜는 조건: 환경변수 `ENABLE_B2B_HTTP_CART`가 정확히 `true`. 그 밖의 값이거나 없으면 Python을 실행하지 않아 사이트 요청이 0건이다.
- GitHub Actions secret 이름: `EROUM_LOGIN_ID`, `EROUM_LOGIN_PASSWORD`, `BOFEEL_LOGIN_ID`, `BOFEEL_LOGIN_PASSWORD`. 값은 저장소에 두지 않는다. 연결부는 해당 업체의 두 값만 자식 프로세스에 넘기고 Firebase·승인 키·GitHub 토큰은 넘기지 않는다.
- 의존성: Python 3.12와 `pip install -r requirements-http.txt`(`cryptography`).
- 실행: `node b2b-http-cart.mjs eroum` 또는 `bofeel`. 업체당 로그인 1회, 실패·시간 초과 시 재시도하지 않고 `cartCheckRequired`로 보고한다.
- workflow: `order-worker.yml`의 `b2b-http-cart` job은 수동 실행(`workflow_dispatch`)이면서 저장소 변수 `ENABLE_B2B_HTTP_CART`가 `true`일 때만 돈다. 예약 실행에서는 돌지 않는다. 이 job은 아직 실행하지 않았다.
- 시험: `node --test b2b-http-cart.test.mjs`, `python -m unittest discover -p "test_http*.py"`(`cryptography` 필요).

## 취합 행 기반 HTTP 큐 경로 (2026-11-11)

위 `b2b-http-cart.mjs`는 기존 고정 시험 전용이다. 새 `b2b-orders.mjs`·`b2b-queue.mjs`·`http_queue.py`는 실제 취합 행을 상품 연결표와 대조하여 납품처별로 준비한다. 이로움은 `B2B_ORDER_TRANSPORT=http`일 때 선택하고 기본은 Playwright다. 보필 작업은 HTTP 준비 경로를 선택한다. 두 업체 모두 `ENABLE_B2B_HTTP_CART`가 정확히 `true`여야 하고 해당 업체의 로그인 secret이 필요하다. Python 3.12와 기존 `requirements-http.txt`가 필요하며 필요하면 실행 파일 경로를 `B2B_HTTP_PYTHON`으로 지정한다. 현재 workflow는 새 선택 변수·제출 변수를 넣지 않았으며 실행하지 않는다.

실행 환경(2026-11-11): `process-queue`의 `Process queued orders` 단계는 `EROUM_LOGIN_ID`·`EROUM_LOGIN_PASSWORD`·`BOFEEL_LOGIN_ID`·`BOFEEL_LOGIN_PASSWORD`·`B2B_SUBMISSION_LEDGER_KEY` secret을 받는다. 그 앞의 `Install HTTP preparation Python dependencies` 단계가 Playwright 컨테이너의 `python3`(venv를 못 만들면 apt로 `python3`·`python3-venv` 설치)로 `$RUNNER_TEMP/b2b-http-venv`를 만들고 `requirements-http.txt`를 설치한 뒤 `B2B_HTTP_PYTHON`을 지정한다(`actions/setup-python` 미사용). `ENABLE_B2B_HTTP_CART`와 `ENABLE_B2B_HTTP_SUBMIT`은 이 job에 넣지 않았으므로 큐 HTTP 준비와 제출은 여전히 꺼져 있다.

상품 연결표 `data/b2b-product-map.json`에는 상품번호·모델·품명·옵션 식별자만 있다. 확인된 기본 상품은 DYJ-03과 BFSH10이다. DA-006·BFMB20의 미확인 옵션과 연결표 밖 품명은 HOLD한다. 우편번호가 없는 원본 주소를 추측하지 않으며, 배송지 묶음·메모·빈 장바구니 확인 규칙은 `docs/b2b-http-ordering.md`를 따른다. 고객정보·단가·세션은 파일이나 로그로 내보내지 않는다.

양 사이트의 최종 POST 함수는 `http_submission.py`에 있으나 **현재 모든 실제 초안은 금액·결제 검증 미완료로 제출 불가**다. `ENABLE_B2B_HTTP_SUBMIT`의 기본값도 꺼짐이며 workflow에서는 켜지 않는다. 추후 검증을 보완해도 기존 REVIEWED→주문 확정→승인 증명→신뢰 원장→행 잠금과 한 주문·한 행 제한이 필요하다. 승인 증명은 행 내용까지 묶는다. 별도의 고정 비밀 `B2B_SUBMISSION_LEDGER_KEY`(32자 이상)가 있어야 두 전송 경로가 공유하는 원본 행 키를 HMAC 처리하여 공개 일회성 원장에 예약할 수 있다. 이 키는 자식 프로세스에 넘기지 않고 workflow에서는 큐 처리 단계에만 넣었으며, 교체할 때는 기존 원장의 중복 방지 기록 이전 절차가 필요하다. 다른 큐 작업·새 승인·전송 경로 교체에 의한 중복도 막는다. 모호한 응답은 UNKNOWN으로 멈추며 자동 재시도하지 않는다. 제출 함수는 가짜 HTTP 전송기로만 시험했다.

새 시험은 `node --test b2b-orders.test.mjs`와 `python -B -m unittest discover -p "test_http*.py"`에 포함된다. 실제 발주 금지는 유지된다.
