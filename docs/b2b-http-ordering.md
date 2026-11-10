# 이로움·보필 HTTP 장바구니 분석과 운영 설계

## 추가: 브라우저 없는 로그인 3차 시험 성공 (2026-11-10)

코디네이터가 승인한 사이트별 마지막 추가 1회를 수행했고, **이로움·보필 모두 빈 메모리 쿠키 저장소에서 로그인한 뒤 같은 쿠키로 장바구니를 GET해 `로그아웃` 문구를 확인했다.** 사이트별 누적 로그인 POST는 정확히 3회다. 이번 실행은 사이트마다 로그인 페이지 GET 1회, 로그인 POST 1회, 장바구니 GET 1회뿐이며 홈 이동·스크립트 실행·추가 재시도는 없었다. 인증 정보는 승인된 메모리 파일의 THK(이로움)·보필 행에서만 읽었다.

| 사이트 | 이번 요청과 응답 | 성공 근거 |
| --- | --- | --- |
| 이로움 | `/bbs/login.php` GET 200 → `/bbs/login_check.php` POST 302 → `/shop/cart.php` GET 200 | 빈 URL 경로가 있는 같은 사이트 Location을 `/`로 정규화해 검사만 하고 따라가지 않았다. 같은 세션의 장바구니 HTML에 `로그아웃` 문구가 있었다. |
| 보필 | `/member/login.php` GET 200 → `/member/login_ps.php` POST 200 `text/html` → `/order/cart.php` GET 200 | POST 응답은 이동 스크립트가 포함된 HTML로 분류됐고 로그인 폼 재표시 분류는 아니었다. 이를 실행하지 않고 같은 세션의 장바구니 HTML에서 `로그아웃` 문구를 확인했다. |

오프라인으로 저장된 보필 페이지 스크립트와 폼을 먼저 대조했다. `$.post('../member/login_ps.php', params)`는 비 www 페이지 기준 같은 origin으로 해석되며 HTML form action의 www 주소를 사용하지 않는다. `dataType` 지정이 없어 HTML이라는 이유만으로 JSON 실패로 처리한 기존 판정은 맞지 않았다. 이번 요청은 `X-Requested-With: XMLHttpRequest`, 로그인 페이지 `Referer`, 비 www `Origin`, `Accept: */*`, `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`를 보냈다. 폼 직렬화는 체크된 `saveId`도 포함하도록 수정했고 서버가 준 다른 필드를 유지했다. 암호화 구조는 기존 구현과 일치했으며 Base64 전체를 URL 인코딩한 뒤 복원하는 모의 시험과 Node crypto 대조가 통과했다. 쿠키는 `HTTPCookieProcessor`가 같은 세션 메모리에서 전달하며 종료 시 삭제했다.

이전 1·2차 POST의 원문 HTML은 저장하지 않았으므로 그 응답이 무엇이었는지는 소급 확정할 수 없다. 3차는 이동 HTML이었다는 구조만 기록했다. 헤더·직렬화·응답 판정을 함께 수정했으므로 어느 변경이 인증 결과에 영향을 주었는지 분리해 입증한 것은 아니다. 실패 횟수·계정 잠김·캡차·추가 인증·차단 신호가 있으면 즉시 중단하도록 했고 이번 실행에서는 감지되지 않았다.

최종 모의 시험 12개는 리다이렉트 정규화·외부 이동과 POST 재전송 차단·홈 GET 차단·AJAX 헤더·성공한 폼 요소·암호문 인코딩·쿠키 전달·HTML 분류·장바구니 성공 판정·위험 신호 중단을 검증한다. 기본 `python`에는 `cryptography`가 없어 시험 로딩이 실패했고, 해당 의존성이 이미 있는 Codex 런타임 Python으로 12개 모두 통과했다. 패키지 설치나 PC 설정 변경은 하지 않았다.

이번에도 장바구니 담기·삭제, 주문·결제, 회원정보 변경, 다른 업체 접근, 발송, Firebase 운영 변경, workflow 실행, 배포, 커밋·푸시는 하지 않았다. 초안은 기존 Node 실행기에 연결하지 않았다. 이번 성공은 브라우저 없는 로그인과 장바구니 인증 확인 범위이며, 운영 도입에는 수량·옵션 파서·세션 만료·오류 처리 검증이 남는다.

민감값 없는 새 결과는 Git 제외 경로 `.local-analysis/http-ordering/http-login-results-attempt-3.json`, 누적 시도 횟수는 `http-login-attempts.json`, 완료 증거는 `.orca-routing/tasks/97c4589d4e41471b/evidence.json`에 UTF-8로 기록했다. 3차 응답 원문·쿠키·secretKey·암호문은 출력하거나 저장하지 않았다. 이전 결과 파일은 보존했다.

## 이전 1·2차: 브라우저 없는 로그인 실제 시험 (2026-11-10)

이번 시험은 Python `urllib.request`와 사이트별 빈 `CookieJar`로 수행했다. 인증 정보는 승인된 로컬 메모리 파일의 THK(이로움)·보필 행에서 실행 시에만 읽었다. 사이트별 로그인 POST는 정확히 2회이며, 더 이상 실제 요청을 보내지 않았다. **두 사이트 모두 로그인 성공 및 장바구니 접근을 검증하지 못했다.** 장바구니 담기·삭제·주문·결제·회원정보 변경·운영 큐 연결·배포는 수행하지 않았다.

| 사이트 | 관찰 | 판정 및 남은 일 |
| --- | --- | --- |
| 이로움 | 두 번 모두 로그인 GET 200, 로그인 POST 302. 두 번째 진단에서 리다이렉트 호스트는 같은 사이트이고 URL 경로가 빈 문자열이었다. 초안의 경로 허용 검사가 이를 차단하여 후속 GET을 보내지 않았다. | 서버 인증 실패라고 단정할 수 없으며 성공도 미확인이다. 이후 빈 경로를 `/`로 정규화하는 코드를 모의 시험으로 수정했다. 이 수정은 실제 사이트에서 재검증하지 않았다. |
| 보필 | 두 번 모두 로그인 GET 200, 암호화한 ID·비밀번호를 보내는 로그인 POST 200. 두 번째 응답은 `text/html`, HTML 형태였고 BOM은 없었다. JSON 파싱이 실패했다. | `code`·`message` 성공 분기를 검증할 수 없어 장바구니 GET을 보내지 않았다. HTML을 반환한 원인은 미확정이며 추가 인증·차단 가능성도 배제할 수 없다. 우회나 추가 요청은 하지 않았다. |

1회 후 자동 반복 없이 원인을 검토하고 작업의 재시도 예약을 사용했다. 2회째에는 HTTPS 기본 포트 허용, BOM·gzip 처리를 추가하고 민감값 없는 응답 형식·리다이렉트 진단을 남겼으나 성공하지 못했다. 추가 실제 시험은 이번 승인 범위를 벗어나므로 중단했다.

`worker/order-runner/http_login_draft.py`는 별도 Python 초안이며 기존 Node 실행기나 workflow에서 불러오지 않는다. 외부 의존성은 `cryptography`다. 사이트별 메모리 쿠키 저장소, 로그인 함수, 장바구니 HTML의 `로그아웃` 확인, 요청 경로·메서드 제한, 타임아웃, 동일 객체의 재로그인 금지를 포함한다. 쿠키 파일을 만들거나 운영 자격 증명 저장소를 변경하지 않는다. 초안은 아직 운영 투입 가능한 구현이 아니다.

보필 암호화는 관찰한 페이지 스크립트대로 문자열마다 IV 16바이트·salt 256바이트를 새로 만들고 PBKDF2-HMAC-SHA512 999회로 32바이트 키를 만든다. AES-256-CBC/PKCS7 암호문 Base64, IV·salt hex, iterations를 담은 JSON UTF-8 전체를 다시 Base64로 감싼다. 페이지 callback은 JSON에서 `code`와 `message` 키가 모두 없을 때 성공으로 분기하므로, 키가 존재하는 `null`이나 `0`도 성공으로 취급하지 않는다.

`test_http_login_draft.py`의 모의 시험 6개가 통과했다. 가짜 고정 입력의 Python 암호화와 Node 내장 crypto 결과 대조, 문자열별 난수 분리, 양쪽 로그인 성공·실패 분기, HTML 응답 중단, 재시도 금지, 요청 범위 제한, 빈 리다이렉트 경로 정규화를 확인했다. 이 시험은 실제 인증 성공의 증거가 아니다. 독립 검토는 이번 배정에서 요구되지 않았고 수행하지 않았다.

실제 시험 스크립트와 민감값 없는 결과·시도 횟수는 Git 제외 경로 `.local-analysis/http-ordering/try-http-login.py`, `http-login-results.json`, `http-login-attempts.json`에 있다. 응답 본문·인증 정보·쿠키·secretKey·암호문은 출력하거나 기록하지 않았다. 이번 완료 증거는 `.orca-routing/tasks/97c4589d4e41471b/evidence.json`이다.

2026-11-10, 승인된 계정과 상품으로 확인했다. 분석·시험에는 Aside `u1`을 사용했다. **운영은 Aside나 브라우저 없이 로그인부터 쿠키 관리·담기·조회·삭제까지 HTTP 클라이언트로 수행하도록 설계한다.** 이번에는 설계와 장바구니 시험만 했으며 운영 코드·주문 제출 코드는 만들지 않았다.

## 확인 결과와 범위

| 사이트 | 시작 상태 | 변경 요청 | 화면 대조 | 종료 상태·주문내역 |
| --- | --- | --- | --- | --- |
| 이로움 | 로그인 후 빈 장바구니 | DYJ-03 수량 1 담기 POST 1회, 해당 상품 삭제 POST 1회 | 1회 담기 뒤 1행, 페이지에 DYJ-03 문구 존재 | 빈 문구·0행, 주문내역 첫 페이지의 식별자 15개가 전후 동일 |
| 보필 | 기존 실제 상품 2행 | 추가 승인에 따라 기존 2행 일괄 삭제 POST 1회, 빈 상태 확인 후 BFSH10 수량 1 담기 POST 1회, 시험 상품 삭제 POST 1회 | BFSH10 단일 행·수량 `1개`·옵션 없음 확인 | 빈 문구·총 0개·0행, 주문내역 첫 페이지의 식별자 10개가 전후 동일 |

보필 기존 상품은 BOFEEL8 / 블루 / 수량할인 옵션 `1개 ~ 2개` / 수량 1, BOFEEL11 / 파스텔블루 / 수량할인 옵션 `1개 ~ 2개` / 수량 1이었다. 두 행 모두 실제 DOM의 `tr`에 있고 화면상 표시되며 `template`·`script` 내부가 아니었다. 처음에는 기존 상품 때문에 시험을 중단했고, 별도 전체 삭제 승인을 받은 뒤 두 행을 한 POST로 삭제했다.

이로움의 요청 수량은 1이고 담기 뒤 실제 체크박스는 단일 행이었다. 상품명 검사는 페이지 전체 문구를 대상으로 했으며 행의 `it_id`까지 대조하지 않았다. 수량 이름의 입력 요소도 찾지 못해 이번 구조화 증거의 `quantities`는 빈 배열이다. 수량 표시 요소의 형태는 미확정이다. 따라서 운영 전 행 단위 상품 ID와 수량 셀 파서를 추가해야 한다. 요청 수량·단일 상품 행 확인을 화면 수량의 독립 검증과 혼동하지 않는다.

주문내역 검사는 각 사이트 기본 목록 첫 페이지의 주문 식별자 집합을 전후 비교한 결과다. 새 식별자는 0개였고, 전체 주문 이력·백엔드 원장의 전수 검증을 뜻하지 않는다. 주문번호·고객정보·단가는 문서에 넣지 않았다.

주문 생성·결제 엔드포인트는 호출하지 않았다. 주문서 HTML은 GET으로 받아 파싱만 했고 스크립트를 실행하지 않았다. 회원정보·배송지 저장, 다른 업체, 운영 배포·워크플로 실행·커밋·푸시는 하지 않았다.

## 로그인과 세션

브라우저 기존 세션이 풀려 사이트별 폼 로그인 1회로 성공했다. 이후 Aside 앱이 중단되어 지휘자가 복구했고, 재시작에 따른 새 로그인 허용을 받아 다시 사이트별 1회로 성공했다. 최초 이로움 UI 조작은 제출 요소 종류를 잘못 지정해 요청 전에 중단됐고, 예약한 재시도 1회를 사용해 `input[type=submit]`으로 바로잡았다. HTTP 로그인 POST를 별도로 반복 시험하지 않았다.

추가로 브라우저 없는 Python HTTP 클라이언트가 빈 쿠키 저장소에서 각 로그인 페이지를 GET했다. 양쪽 모두 HTTP 200, HTTP 리다이렉트 없음이었으며 폼·스크립트·쿠키 이름을 읽었다. 이 GET은 실제 인증 성공 시험이 아니다.

### 이로움

- 시작: `GET https://eroumcare.com/bbs/login.php`.
- 폼: `name=flogin`, `method=POST`, action `/bbs/login_check.php`, `application/x-www-form-urlencoded`.
- 필드: `mb_id`, `mb_password`, 숨은 `url`; 선택 체크박스 `auto_login`. 체크하지 않은 체크박스는 보내지 않는다. `url`은 반환 경로이므로 같은 사이트의 승인된 경로로 제한한다.
- 읽은 `flogin_submit`은 ID·비밀번호 공백 검사 후 일반 폼 제출만 한다. 이 폼에서는 숨은 CSRF 토큰·암호화용 생성 토큰·캡차를 관찰하지 않았다. 추가 인증이 다른 조건에서도 없다는 보장은 아니다.
- 관찰한 로그인 페이지 응답 쿠키 이름: `PHPSESSID`, `2a0d2363701f23f8a75028924a3af643`. 값은 보존하거나 문서화하지 않는다. 어떤 쿠키가 인증에 반드시 필요한지는 제거 실험을 하지 않아 미확정이다. HTTP 클라이언트는 서버가 설정한 쿠키 전체를 도메인·경로·만료 조건대로 관리한다.
- 브라우저 로그인 후 최종 경로는 `/`였다. 인증 POST 응답의 정확한 HTTP 리다이렉트 상태 코드·중간 경로는 이번에 수집하지 못했다. 운영에서는 허용된 같은 사이트 경로만 따라가고, 응답 200 여부 대신 인증된 장바구니·계정 상태로 성공을 판정해야 한다.

### 보필

- 시작: `GET https://bofeelmall.com/member/login.php`.
- 폼: `id=formLogin`, POST. HTML action은 `https://www.bofeelmall.com/member/login_ps.php`지만, 실제 페이지의 submit 핸들러는 `$.post('../member/login_ps.php', params)`로 가로챈다. 운영에서는 관찰한 같은 origin의 `https://bofeelmall.com/member/login_ps.php`를 대상으로 설계하고 임의의 외부 호스트로 자격증명을 전달하지 않는다.
- 필드: `mode`, `returnUrl`, `secretKey`, `encryptFl`, `loginId`, `loginPwd`, 선택 `saveId`. 비회원 주문조회용 `formOrderLogin`은 별도 폼이며 사용하지 않는다.
- `secretKey`는 로그인 GET HTML에 값이 있는 숨은 필드다. 같은 쿠키 저장소로 페이지를 받은 뒤 해당 응답의 값을 사용한다. `encryptFl`은 관찰 시 `Y`였다. 키·쿠키·토큰 값은 로그에 남기지 않는다.
- **ID와 비밀번호 모두 브라우저 JavaScript에서 암호화한다.** 평문을 `loginId`·`loginPwd`에 그대로 보내는 HTTP 구현은 현재 폼과 다르다.
- 관찰한 암호화 구조: 각 문자열마다 새 IV 16바이트와 salt 256바이트를 생성한다. 숨은 `secretKey`를 키 재료로 PBKDF2-HMAC-SHA512, 반복 999회, 파생 키 32바이트를 얻는다. AES-256-CBC와 CryptoJS 기본 PKCS#7 패딩으로 암호화한다. 결과는 `{ciphertext, iv, salt, iterations}` JSON이며 ciphertext는 Base64, iv·salt는 hex이고 JSON의 UTF-8 바이트 전체를 다시 Base64로 감싼다. ID와 비밀번호는 각각 암호화하므로 난수도 각각 생성한다.
- 이 계산은 일반 암호 라이브러리로 브라우저 없이 재현할 수 있는 구조다. 이번에 운영용 암호 코드를 구현하거나 브라우저 없는 인증 POST를 실행하지 않았으므로 상호운용 성공은 아직 검증하지 않았다. 운영 전 실제 자격증명 없이 만든 고정 입력으로 CryptoJS와 HTTP 클라이언트 암호 결과를 대조해야 한다.
- 로그인 AJAX 콜백은 JSON의 `code`, `message`, `url`을 검사하고 성공 분기에서 `returnUrl` 또는 `/`로 JavaScript 이동한다. 오류 분기에서도 `url` 이동이 가능하므로 이동만으로 성공을 판정하면 안 된다. 브라우저 시험 최종 경로는 `/main/index.php`였다. 정확한 HTTP 응답·리다이렉트 체인은 수집하지 않았다.
- 로그인 GET에서 관찰한 쿠키 이름: `GD5SESSID`, `GMCS`, `analytics_client_id`, `analytics_session_id`, `analytics_session_date`, `analytics_session_channel`. 도메인은 `.bofeelmall.com`이었다. 처음 두 쿠키와 analytics 쿠키의 인증상 필수 여부는 분리 시험하지 않았다. 세션 쿠키와 서버 토큰의 유효기간·회전 규칙도 미확정이다.
- 관찰한 일반 로그인 폼에는 캡차가 없었다. `secretKey`는 서버가 제공하고 암호문·IV·salt는 클라이언트가 계산한다. 다른 접속 조건의 추가 인증·차단이 나오면 우회하거나 반복하지 않고 중단한다.

## 장바구니 HTTP 규약

모든 변경 시험은 로그인된 페이지에서 같은 origin의 `fetch`로 URL 인코딩 POST를 직접 전송했다. 버튼의 주문 함수를 호출하지 않았다. 브라우저 세션 쿠키는 자동 동반됐으며 쿠키 값은 출력하지 않았다. AJAX 담기는 `X-Requested-With: XMLHttpRequest`도 보냈다. 이 헤더가 필수인지 별도 제거 시험은 하지 않았다. 장바구니와 사후 주문내역의 판정은 Aside가 렌더링한 DOM을 읽었다. 브라우저 없는 원본 HTML 파서로 같은 판정이 가능한지는 운영 전 검증해야 한다.

### 이로움

| 기능 | 주소·메서드 | 필드·처리 | 관찰 응답 |
| --- | --- | --- | --- |
| 조회 | `GET /shop/cart.php` | HTML에서 실제 상품 행과 빈 문구 판정 | HTML |
| 담기 | `POST /shop/itemcart.php` | `form[name=fitem]` 직렬화, 반드시 `sw_direct=0` | 200, Content-Type은 HTML이지만 본문은 정확히 `OK` |
| 선택 삭제 | `POST /shop/cartupdate.php` | 장바구니 폼 직렬화, `act=seldelete`, 시험 행만 선택 | 200, 최종 `/shop/cart.php`로 리다이렉트, HTML |

DYJ-03의 상품 ID는 `PRO2022102700012`다. 담기 필드는 `it_id[]`, `it_msg1[]`, `it_msg2[]`, `it_msg3[]`, `sw_direct`, `url`, `io_type[상품ID][]`, `io_id[상품ID][]`, `io_value[상품ID][]`, `ct_qty[상품ID][]`였다. 옵션 없는 기본 행과 수량 1을 사용했다. 숨은 값과 옵션 ID는 그때 받은 상품 폼에서 읽고 의미를 추측해 생성하지 않는다.

실제 `fitem_submit`은 `document.pressed`가 장바구니일 때 `sw_direct=0`과 `$.post('./itemcart.php', $(f).serialize())`를 사용한다. 그 외 분기는 `sw_direct=1`로 일반 폼을 제출하므로 호출 금지다. 폼의 기본 action이 `cartupdate.php`라는 이유로 담기 주소를 잘못 고르지 않는다.

삭제 폼 필드는 `only_recipient`, `ct_all`, `ct_chk[행번호]`, `it_id[행번호]`, `it_name[행번호]`, `url`, `records`, `act`였다. 실험에서는 단일 DYJ-03 행을 재확인한 뒤 해당 `ct_chk`만 포함했다. 소스에는 `act=alldelete`도 있지만 이로움에서는 실행하지 않았다. `act=buy`, `sup_recipient`는 사용하지 않는다.

관찰한 담기·삭제 폼에는 별도 이름의 CSRF 토큰이 없었다. 서버가 세션·Origin·Referer·추가 검증을 사용하지 않는다고 결론 내릴 수는 없다. 쿠키를 없앤 요청, 토큰 변조, 인증 우회 실험은 하지 않았다.

### 보필

| 기능 | 주소·메서드 | 필드·처리 | 관찰 응답 |
| --- | --- | --- | --- |
| 조회 | `GET /order/cart.php` | `#frmCart input[name="cartSno[]"]`의 실제 행, 빈 문구, 총 수량 | HTML |
| 담기 | `POST /order/cart_ps.php` | `#frmView` 직렬화, `mode=cartIn`, `cartMode` 빈 값 | 200 JSON, 키 `error`, `message`; 오류 표시 없음 |
| 선택 삭제 | `POST /order/cart_ps.php` | `#frmCart` 직렬화, `mode=cartDelete`, 삭제할 `cartSno[]`만 포함 | 200 HTML, iframe용 처리 응답; 별도 GET으로 결과 확인 |

BFSH10의 상품 번호는 `1000000025`다. 옵션 없는 기본 행·수량 1이었다. 핵심 상품 필드는 `goodsNo[]`, `optionSno[]`, `goodsCnt[]`다. 추가로 `mode`, `scmNo`, `cartMode`, `ac_id`, `useBundleGoods`, `deliveryCollectFl`, `deliveryMethodFl`, `goodsDeliveryFl`, `sameGoodsDeliveryFl`, `optionFl`, `brandCd`, `cateCd`, 세금·할인·마일리지·가격 계산 필드와 `couponApplyNo[]` 등이 직렬화됐다. 필드 이름과 값의 공급 위치만 기록하며 단가·계산 금액은 이 문서에 넣지 않는다.

폼에서 읽은 계산 필드·옵션 번호를 그대로 전달한 시험이므로 최소 필수 필드 집합은 아직 확정되지 않았다. `ac_id`를 CSRF 토큰으로 단정하지 않으며, 의미가 미확정인 숨은 값도 새 응답에서 읽어 보존한다. 서버가 최종 가격을 검증해야 한다는 가정과 별개로 클라이언트가 계산 값을 임의 변경하지 않는다.

삭제 직렬화 필드는 `mode`, `cart[cartSno]`, `cart[goodsNo]`, `cart[goodsCnt]`, `cart[addGoodsNo]`, `cart[addGoodsCnt]`, `cart[couponApplyNo]`, `useBundleGoods`, `ac_id`, `cartSno[]`였다. 기존 상품 삭제는 추가 승인에 따라 두 `cartSno[]`를 한 POST로 보냈다. 이후 시험 삭제에는 BFSH10 한 행만 포함했다. 응답 HTML의 스크립트를 HTTP 클라이언트에서 실행하지 않고 GET 조회로 검증한다.

소스의 `gd_cart_remove`는 `GET /order/cart_ps.php?mode=remove`를 iframe으로 보내 전체를 비운다. 이는 이름이 GET이어도 변경 요청이다. 이번에는 사용하지 않았고 운영 허용 목록에도 넣지 않는다. `cart_ps.php`는 mode에 따라 기능이 바뀌므로 경로만 허용해서는 안 된다. `cartMode=d`, `pa`, `mode=orderSelect` 및 주문 이동 분기는 차단한다.

## 주문서 제출 구조 — 읽기만 수행

두 사이트 모두 GET HTML을 DOM으로 읽거나 소스를 파싱했다. 폼 제출·검증 함수 호출·약관 선택·주소 입력·저장은 하지 않았다. 주문서 GET이 서버 임시 상태를 만들거나 바꾸는지는 확인하지 못했다. 페이지 스크립트 미실행과 주문내역 불변을 서버 상태 무변경의 증거로 해석하지 않는다. 주문서의 쿠키·토큰·개인정보가 포함될 수 있는 원문은 `.local-analysis/http-ordering/`에만 두고 저장소에 추가하지 않는다.

### 이로움

`GET /shop/simple_order.php`의 HTML에 `form#simple_order`, `name=forderform`, `method=POST`, action `orderformupdate.php`가 있었다. 이 GET은 장바구니에서 `act=buy`를 보내지 않고 수행했으므로 실제 상품이 연결된 주문서 검증을 뜻하지 않는다. `form_submit`은 실행하지 않았다.

- 주문·상태: `checkUnload`, `dc_id`, `mb_order_approve`, `form_mb_id`, `pen_type`, `pen_id`, `pen_nm`.
- 금액·배송비·결제: `org_od_price`, `od_price`, `od_settle_case`, `od_send_cost2`, `od_send_cost`, `od_installation_cost`, `od_delivery_type`.
- 주문자: `od_name`, `od_tel`, `od_hp`, `od_zip`, `od_addr1`, `od_addr2`, `od_addr3`, `od_addr_jibeon`, `od_email`.
- 수취인·요청: `od_b_name`, `od_b_tel`, `od_b_hp`, `od_b_zip`, `od_b_addr_jibeon`, `od_b_addr1`, `od_b_addr2`, `od_memo`.
- 쿠폰: `cp_id[]`, `od_cp_id`, `od_cp_price`, `sc_cp_id`.
- 증빙: `ot_typereceipt`, `typereceipt_bname`, `typereceipt_boss_name`, `typereceipt_bnum`, `typereceipt_btel`, `ot_location_zip`, `ot_location_jibeon`, `ot_location_addr1`, `ot_location_addr2`, `typereceipt_buptae`, `typereceipt_bupjong`, `typereceipt_email`, `typereceipt_manager_name`.

기존 학습 기록에서는 상품별 `io_id[]`, `prodMemo[]`, `ct_qty[]`도 확인됐다. 이번 빈 주문서 GET만으로 실제 제출 시 상품 연결·필수 조건·세션 의존성을 전부 확정하지 않는다. 페이지의 `beforeunload`에는 정리용 `ajax.simple_order.php` 호출이 있으므로 HTML만 받을 때는 페이지 스크립트를 실행하지 않는다.

### 보필

`GET /order/order.php` HTML에 `form#frmOrder`, POST action `./order_ps.php`가 있었다. `결제하기`의 제출 경로이며 전송 금지다.

- 세션·주문 연결: `csrfToken`, `cartSno[]`, `orderChannelFl`, `returnUrl`, `cartGoodsCnt`, `cartAddGoodsCnt`, `simpleJoin`.
- 상품별 계산: `memberDcInfo[상품번호][옵션번호]`, `priceInfo[상품번호][옵션번호]`, `mileageInfo[상품번호][옵션번호]`.
- 주문자: `orderName`, `orderPhone`, `orderCellPhone`, `orderEmail`, `orderCountryCode`, `orderZipcode`, `orderZonecode`, `orderState`, `orderCity`, `orderAddress`, `orderAddressSub`, 전화 국가·접두 코드 필드.
- 배송: `shipping`, `receiverName`, `receiverZonecode`, `receiverZipcode`, `receiverAddress`, `receiverAddressSub`, `receiverPhone`, `receiverCellPhone`, `receiverCountryCode`, `receiverState`, `receiverCity`, 전화 국가·접두 코드, `orderMemo`, `reflectApplyDelivery`.
- 결제·합계: `settleKind`, `bankSender`, `bankAccount`, `settlePrice`, `overseasSettlePrice`, `overseasSettleCurrency`, 배송비·쿠폰·마일리지 계산 필드.
- 방문 수령: `visitAddress`, `visitName`, `visitPhone`, `visitMemo`, `deliveryVisit`.

`csrfToken`은 주문서 숨은 필드로 관찰됐지만, 값·발급 규칙·필수 검증은 시험하지 않았다. `reflectApplyDelivery`는 회원 배송지 변경 가능성이 있어 사용하지 않는다. 기존 기록의 구매 동의 `termAgree_orderCheck`와 최종 `.btn_order_buy`도 조작하지 않았다. 주문서 구조 분석은 장바구니 모듈에 주문 기능을 추가하는 승인이 아니다.

## worker/order-runner 운영 모듈 제안

현재 `worker/order-runner`의 Playwright 의존 구현과 별도로 다음 경계를 갖는 HTTP 어댑터를 제안한다. 이번에는 파일·패키지·운영 동작을 변경하지 않았다.

| 구성 | 역할 |
| --- | --- |
| `VendorHttpSession` | 사이트·계정별 독립 쿠키 저장소, TLS 검증, 타임아웃, 허용 호스트·경로·메서드·mode 검사 |
| `EroumCartClient` | 로그인 GET·폼 POST, 상품 폼 파싱, 담기·실제 행 조회·시험 행 삭제 |
| `BofeelCartClient` | 로그인 GET·서버 키 추출·암호화·로그인 AJAX, 상품 폼 파싱, mode 제한 담기·조회·삭제 |
| `CartOperationJournal` | 요청 전 의도·상품 식별자·수량·생성 행 식별자·결과 상태 기록, 민감 값 제외 |

1. Node HTTP 클라이언트와 검증된 쿠키 저장소를 사용한다. 기본 `fetch`만으로는 쿠키가 자동 보존되지 않으므로 `Set-Cookie`와 도메인·경로·Secure·만료를 처리하는 쿠키 저장소 연동이 필요하다. HTTP 클라이언트가 HTML 폼을 파싱하며 Aside·CDP·Playwright·브라우저 설치를 운영 전제로 삼지 않는다.
2. 계정 비밀값은 승인된 비밀 저장소에서 런타임에 읽는다. 인증 POST 본문, Cookie·Set-Cookie 헤더, 서버 키·CSRF 값, 금액·고객정보를 로그에서 제외한다. 쿠키 파일은 저장소 밖의 제한된 경로에 두고 운영체제 비밀 저장소에 연결한 암호화로 보호한다. 이는 설계 제안이며 이번에 PC 권한·저장소 설정은 바꾸지 않았다.
3. 로그인 페이지를 같은 쿠키 저장소로 GET하고 숨은 필드를 그 응답에서 읽는다. 보필은 앞서 설명한 암호화를 브라우저 없는 라이브러리로 재현한다. 인증 실패·캡차·새 인증 요구가 나오면 한 번에서 멈춘다. 로그인 성공은 인증된 페이지 구조로 검증한다. HTTP 200이나 이동 경로만으로 판정하지 않는다.
4. 사이트·계정별로 한 작업만 실행한다. 담기 전 장바구니를 읽고 예상 상태를 확인한다. 옵션은 상품 페이지의 실제 옵션 ID·표시명 대응으로 선택한다. 담기는 직렬화 배열의 중복 키 순서를 유지하며, 서버가 보낸 숨은 값을 임의로 줄이지 않는다.
5. 변경 요청의 자동 재전송을 끈다. 타임아웃·연결 종료·불명확한 응답이면 `uncertain`으로 기록하고 조회만 해서 결과를 확인한다. 확인되지 않은 담기·삭제를 다시 보내지 않는다. GET 이름만으로 안전성을 판단하지 않고 전체 삭제 GET 등 변경 경로도 거부한다.
6. 담기 후 행 단위 상품 ID·모델·옵션·수량·실제 행 식별자를 대조한다. 보필의 JSON 오류값은 숫자·문자열을 정규화해 판정하고, 성공 응답도 장바구니 재조회로 대조한다. 삭제는 해당 실행에서 생성한 행만 대상으로 한다. 이로움 `seldelete`가 옵션 행보다 상품 ID 단위로 삭제할 가능성은 미확정이므로, 담기 전 같은 `it_id`가 이미 있으면 중단한다. 삭제 직렬화 시 대상 외 `ct_chk`를 명시적으로 제거하고 상품 ID도 대조해야 한다. 기존 장바구니를 비우는 기능은 별도 명시적 승인 작업으로 분리하며 일반 시험·운영 실패 복구에서 자동 사용하지 않는다.
7. 허용 목록은 이로움 담기 `itemcart.php + sw_direct=0`, 삭제 `cartupdate.php + act=seldelete`, 보필 `cart_ps.php + mode=cartIn/cartDelete`처럼 payload 조건까지 검사한다. 로그인은 별도 어댑터에서만 허용한다. 주문·결제·회원정보·배송지 저장과 임의 URL 요청 기능은 이 모듈에 제공하지 않는다.
8. 쿠키 만료·세션 회전·HTML 구조 변경을 감지하면 진행을 중단한다. 로그에는 경로·메서드·상태 코드·필드 이름·승인된 상품 모델·수량·검증 결과만 남긴다. 원문 HTML·HAR을 운영 로그로 수집하지 않는다.

운영 도입 전 남은 검증은 브라우저 없는 양 사이트 로그인, 보필 암호화 상호운용, 세션 만료·회전·오류 응답, 각 사이트 수량·옵션 파서, 다중 옵션과 최소 필드 의존성이다. 이번 장바구니 시험 성공으로 실제 주문 제출이나 전체 운영 준비가 완료됐다고 판단하지 않는다.

## 증거와 독립 검토

민감 원문은 Git 제외 경로 `.local-analysis/http-ordering/`에 있다. 시험 결과 `eroum-test.raw`, `bofeel-test.raw`는 응답 본문·쿠키 값 없이 단계별 상태와 필드 이름을 기록한다. 로그인 구조 원문과 주문서 원문은 외부로 공유하지 않는다. 라우팅 완료 증거는 `.orca-routing/tasks/a3fe96568ff341a7/evidence.json`에 기록한다.

`claude-opus-5-5/high` 독립 읽기 전용 검토는 통과했다. 검토의 비차단 지적을 반영해 행 단위 ID·수량 추출의 한계, 조회의 브라우저 의존, 삭제 단위의 불확실성, 오류값 정규화, 주문서 GET의 임시 상태 가능성을 위에 명시했다. 암호화의 호출부는 작성자가 소스로 확인했으나 검토자는 별도로 확인하지 못했고, 실제 인증 상호운용도 미검증이다. 전체 검토 결과는 완료 증거의 `independent_review`와 별도 검토 JSON에 남긴다.
