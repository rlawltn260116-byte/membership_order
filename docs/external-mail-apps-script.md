# Gmail(Apps Script) 외부메일 시험

외부메일은 개인 Gmail 계정의 Apps Script `MailApp`으로 보낸다. 회사 Outlook을 쓰는 나머지 업체와는 별개다. SMTP 비밀번호·앱 비밀번호를 사용하지 않는다. 이 문서는 사용자가 직접 설치하는 절차이며 코드 작성 중에는 배포·실제 발송을 하지 않는다. 도구는 개인 Gmail의 `/macros/s/…/exec` URL 기준이며 Workspace의 `/a/macros/…` URL은 지원하지 않는다.

**실제 업체 발송 금지. 첫 시험은 본인 회사 주소 한 곳만 허용한다.** 허용 목록에 업체 주소나 그룹·메일링리스트를 넣지 않는다. 본인 회사 주소의 자동 전달 규칙도 확인한다. 첨부에는 실제 주문·수취인 자료를 쓰지 않는다.

## 사용자가 직접 설치

1. 발신에 사용할 Gmail 계정으로 [script.google.com](https://script.google.com)에 접속해 **새 프로젝트**를 만든다. 기존 주문 즉시실행기와 별도 프로젝트로 만든다.
2. `Code.gs`에 `apps-script/external-mail/Code.gs` 내용을 붙여 넣는다. 프로젝트 설정에서 **appsscript.json 매니페스트 파일 표시**를 켜고 `apps-script/external-mail/appsscript.json` 내용을 붙여 넣어 저장한다.
3. **프로젝트 설정 → 스크립트 속성**에 아래 속성을 설정한다. 값은 저장소·문서·스크린샷·채팅·명령 기록에 남기지 않는다.

   | 속성 이름 | 값 |
   |---|---|
   | `EXTERNAL_MAIL_TOKEN` | 비밀번호 관리자로 생성한 무작위 32자 이상 토큰 |
   | `EXTERNAL_MAIL_ALLOWED_RECIPIENTS` | 본인 회사 주소 하나. 형식상 쉼표 목록도 지원하지만 시험에서는 한 곳만 설정 |
   | `EXTERNAL_MAIL_ENABLE_SEND` | 처음에는 `false`. 드라이런 확인 후 본인 주소 시험 직전에만 `true` |

4. **배포 → 새 배포 → 유형: 웹 앱**을 선택한다. **실행 계정: 나**로 설정한다. 아래 Python 도구는 Google 로그인 쿠키를 쓰지 않으므로 접근 권한은 로그인 없이 호출할 수 있는 **모든 사용자(Anyone)** 옵션이 필요하다. 조직 정책으로 해당 옵션이 없으면 여기서 중단하고 관리자에게 정책을 확인한다. 계정·조직 보안 설정을 우회하거나 바꾸지 않는다.
5. 배포 과정의 **액세스 승인**에서 사용할 계정을 확인하고 메일 전송 권한을 검토·허용한다. 출처나 계정이 예상과 다르면 중단한다. 이 프로젝트는 메일 읽기·Drive 권한을 요청하지 않는다.
6. 배포된 웹 앱의 `/exec` URL을 복사해 로컬 환경변수에만 보관한다. `/dev` URL은 시험 도구가 거부한다. URL도 공개 저장소에 쓰지 않는다. 코드 수정 후에는 **배포 관리 → 수정 → 새 버전**으로 갱신해야 기존 `/exec`에 반영된다.

공개 호출이 가능한 웹앱이므로 토큰이 인증 수단이다. 토큰은 JSON 본문으로만 전달하며 URL 쿼리에 넣지 않는다. 토큰이 노출되면 즉시 속성의 토큰을 교체하고 필요하면 배포를 중지한다. 시험 후에는 `EXTERNAL_MAIL_ENABLE_SEND=false`로 되돌린다.

## 로컬 호출

터미널 환경에 `EXTERNAL_MAIL_URL`, `EXTERNAL_MAIL_TOKEN`, `EXTERNAL_MAIL_TEST_TO`를 설정한다. 마지막 값은 **본인 회사 주소**다. 실제 값이 포함된 설정 파일은 저장소에 만들지 말고, 셸 기록에 값을 직접 입력하지 않는 로컬 비밀값 주입 방식을 사용한다.

```powershell
python tools/send_external_mail_test.py
python tools/send_external_mail_test.py --attachment <개인정보_없는_시험파일_경로>
```

기본은 `dryRun=true`이며 인증·전체 수신자·첨부·크기를 검사하고 발송하지 않는다. `ok=true`, `sent=false`, `dryRun=true`를 확인한다. 이후 본인 회사 주소만 허용되어 있음을 다시 확인하고 서버 속성을 `true`로 바꾼 뒤 본인이 아래 명령을 **한 번** 실행한다.

```powershell
python tools/send_external_mail_test.py --send
```

Gmail 보낸편지함과 본인 회사 수신함에서 제목·본문·첨부를 대조하고, 시험 후 서버 발송 속성을 다시 `false`로 바꾼다. **통신 오류·시간 초과·`SEND_UNKNOWN`은 발송되지 않았다는 뜻이 아니다. 자동 재시도하지 않고 보낸편지함부터 확인한다.** 이 도구에는 중복 발송 방지 원장이 없으므로 운영 자동화에 바로 연결하지 않는다.

## JSON 계약과 제한

요청 필드는 `token`, `to`, `cc`, `bcc`, `subject`, `body`, `attachments`, `dryRun`이다. 수신자는 주소 문자열(쉼표로 구분) 또는 주소 배열이며, `to`는 필수다. 세 종류 모두 스크립트 속성의 정확한 주소 허용 목록과 대소문자 무시 비교한다. 표시 이름·와일드카드·헤더 개행은 거부한다. `dryRun` 생략은 드라이런, 실제 발송은 JSON 불리언 `false`와 서버 발송 속성 `true`가 모두 필요하다. Python 도구는 본인 주소 하나의 `to`만 만든다.

첨부 하나의 형식은 `{"base64":"aGk=","filename":"test.txt","mimeType":"text/plain"}`이다. UTF-8 JSON 요청은 최대 2 MiB, 제목·본문·수신자·첨부 원본 합계는 최대 1 MiB, 첨부 최대 10개, 전체 수신자 최대 10개로 보수적으로 제한한다. 이 크기는 MIME 헤더·인코딩이 포함된 실제 전송 크기가 아닌 **애플리케이션 계산값**이다. HTML 본문·발신자 변경은 지원하지 않는다.

응답은 `ok`, `sent`, `code`, `messageBytes`, `remainingDailyQuota`를 포함하며 성공 시 `dryRun`도 포함한다. `SENT`는 MailApp 호출 성공이며 최종 수신을 보장하지 않는다. 인증 실패 시 크기·할당량은 `null`, 할당량 조회 불가 시에도 `null`이다. 오류는 HTTP 상태만으로 판단하지 않고 JSON의 `ok`로 판단한다. 도구는 민감값 보호를 위해 서버 원문 대신 안전한 상태 필드만 출력하고 실패 시 종료 코드 1을 반환한다.

주요 코드: `UNAUTHORIZED`(토큰 설정/일치 확인), `ALLOWLIST_REQUIRED`, `RECIPIENT_NOT_ALLOWED`, `SEND_DISABLED`, `QUOTA_EXCEEDED`, `MESSAGE_TOO_LARGE`, `SEND_UNKNOWN`. 도구는 알려진 코드만 화면에 출력한다. `BUSY`는 다른 호출 처리 중이다. 허용 목록의 끝 쉼표·오타도 `INVALID_RECIPIENT`가 되므로 서버 속성을 함께 확인한다. 사용하지 않는 `cc`·`bcc`는 생략하거나 빈 문자열·배열로 보내며 `null`은 거부한다. 로그인 HTML이나 예상 밖 리디렉션이 오면 배포 접근 권한을 확인한다. Google ContentService 응답은 별도 Google 호스트로 리디렉션되며 도구는 해당 호스트의 GET만 허용하고 토큰 본문을 재전송하지 않는다.

남은 일일 할당량은 메일 수가 아닌 수신자 기준이며 Google 계정 종류·정책에 따라 달라진다. 코드 상한과 별개로 서비스 제한이나 회사 메일 보안 정책으로 실패·격리될 수 있다. 배포와 실제 수신은 사용자 확인 전까지 미검증이다.

## 오프라인 검증

```powershell
python -m unittest discover -s tools -p test_send_external_mail_test.py
node --test apps-script/external-mail/external-mail.test.mjs
```

모든 테스트는 가짜 주소와 모의 서비스를 사용하고 네트워크 요청이나 실제 발송을 하지 않는다.

공식 참고: [MailApp](https://developers.google.com/apps-script/reference/mail/mail-app), [웹앱 배포](https://developers.google.com/apps-script/guides/web), [ContentService와 리디렉션](https://developers.google.com/apps-script/guides/content).
