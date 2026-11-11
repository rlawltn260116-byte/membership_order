# 이카운트 거래처 포털(ERP) 발주 분석

대상은 직배 시간표에서 발주 수단이 ERP인 업체 3곳(세비앙, 명성실버케어, 에이엠이)이다. 모두 이카운트 거래처 포털
`https://c-portal.ecount.com/`로 주문한다. 운영은 브라우저 없는 HTTP 요청이어야 하고, 실제 발주 금지는 해제되지 않았다.
회사코드, ID, 비밀번호, 세션 값, 업체 화면의 실제 데이터는 이 문서에 적지 않는다. 원본 응답과 스크립트는 `.local-analysis/ecount/`에만 있다.

## 최신 결과 (2026-11-11, 명성실버케어 추가 관찰)

명성실버케어의 정정된 로그인 정보로 **Aside 로그인 한 번 성공**했다. HTTP 로그인은 추가하지 않았고,
세비앙·에이엠이에는 접속하지 않았다. 하나의 `aside repl` 프로세스를 계속 유지해 같은 로그인 세션에서
품목 조회·코드 선택·수량 입력과 마지막 주문서조회를 관찰한 뒤 탭과 프로세스를 닫았다.
로그인 정보는 지정된 로컬 메모의 해당 행에서 읽어 메모리에만 전달했다.

| 확인 대상 | 결과와 검증 범위 |
|---|---|
| 주문서입력 데이터 | 최초 로딩 경로는 `/ECERP/SVC/CSA/ESD004M`. 별도 데이터 API 대신 HTML의 `viewBag`에 초기 데이터가 들어 있다. 최초 요청의 메서드와 본문은 계측 설치 전에 지나가 직접 포착하지 못했다 |
| 품목 검색·선택 | 아래 POST와 본문 구조를 실제 응답으로 확인했다. 일반 검색 뒤 검색 결과의 정확한 품목코드로 조회해 선택했다. 같은 요청을 재전송하거나 실패를 재시도하지 않았다 |
| 수량 입력 | 선택한 한 행에 수량 입력 후 Tab으로 확정했다. 추가 서버 요청 없이 화면에서 수량과 금액을 계산했다 |
| 저장·저장/전표 | 스크립트에서만 분석했다. 관련 버튼·키·저장·전표 요청을 사용하지 않았다 |
| 마지막 주문서조회 | 상단 `주문서조회` 메뉴로 읽기 조회했다. 조회 API가 성공했고 오늘을 포함하는 기본 기간의 전체 건수와 자료 배열이 모두 비어 있었다. 관찰한 저장 요청도 없었다 |
| HTTP 단독 재현 | 로그인은 이전 조사에서 검증됐다. 이번에는 브라우저에서 요청 구조를 관찰했으며, 새 조회 함수들의 HTTP 단독 실서버 재현은 하지 않았다 |

화면에 자동 임시저장 안내가 한 번 나타났다. 스크립트에는 `ecount.TemporarySave.localstorage`가 있으며,
그 시점 전후 관찰한 요청에는 서버의 임시저장·주문 저장 호출이 없었다. 브라우저 내부 저장의 구현 전체나
잔류 여부는 별도 확인하지 않았으므로 **아무 상태도 바뀌지 않았다고 단정하지 않는다**. 최종 주문서조회는
저장된 주문이 없는 상태였고, 이 관찰 세션의 탭은 닫았다. 명성실버케어의 이번 로그인 허용분은 소진됐다.

### 주문 화면의 초기 데이터

화면 스크립트는 `window["viewBag" + 화면식별자] = $.xextend(JSON, …)` 형식이다.
첫 JSON의 `_x_`를 `String.decryptXor`로 해독하고 합친다. 첫 글자는 키 길이, 그 다음은 키,
나머지는 두 글자씩 읽는 16진 바이트이며 키 글자와 순환 XOR한 UTF-8 JSON이다.
해독 결과에 점이 들어간 키는 브라우저의 전역 설정에 배치된다. 파서는 그 부수 효과를 실행하지 않는다.

주요 구조는 `CacheInfo`, `FormInfos`, `InitDatas.ViewData.Master`, `InitDatas.ViewData.Details`,
`WidgetDatas`, `DefaultOption`, `Permission`, `ProgramInfo`다.
`InitDatas`에는 `CustPassModifyData`, `CustWhData`, `Cust` 등 현재 거래처에 종속된 설정도 있다.
이 객체와 검색 문맥은 같은 세션의 메모리에서만 사용하며, 공개 문서·증거 파일에는 값을 넣지 않는다.

이번에 직접 포착한 주문서조회 화면 로딩은 `POST /ECERP/SVC/CSA/ESD005M`이고 본문 필드는
`alreadyIncludedLayout`, `requestKey`, `viewer_id`, `panel_id`, `is_from_left_menu`, `PRG_ID`다.
`load_order_input_data`는 같은 메뉴 이동 본문 형식을 주문서입력 경로에 적용하는 **미검증 어댑터**다.
이 형식을 주문서입력의 최초 요청으로 확정한 것은 아니며, 현재 세션에서 획득한 문맥 없이는 요청하지 않는다.

### 품목 검색과 선택

`POST /ECAPI/SVC/Inventory/Basic/GetListProdForSearchPopup`

- 쿼리 필드: `ec_req_sid`, `xce`. 관찰한 본문은 암호화되지 않은 JSON이고 응답은 Base64로 감싼 UTF-8 JSON이었다.
- 본문 `Request.Data`: `PARAM`, `CANCEL`, `keyword`, `INPUT_PROGRAM_ID`, `INPUT_CUST`,
  `INPUT_WH_CD`, `INPUT_WH_CD_T`, `INPUT_IO_CODE`, `BARCODE_SEARCH`, `SERIAL_DATE`,
  `PROD_SEARCH_TYPE`, `DecP`, `errorInfo`, `SerialList`.
- `errorInfo`: `programId`, `pageId`, `menuTitle`. 본문 루트에도 `CANCEL`을 제외한 위 필드들이 중복된다.
- 응답: `Status`, `Data.TotalCount`, `Data.Data`(품목 배열), `Errors`, `Error`, `Timestamp`,
  `RequestKey`, `RefreshTimestamp`, `AsyncActionKey` 등.
- 검색 행의 주요 필드: `PROD_CD`, `PROD_DES`, `SIZE_DES`, `BARCODE`, `PARAM`, `ROWORDER`,
  `SERIAL_SEARCH_YN`, `SERIAL_IDX` 등.
- 정확한 품목코드를 선택할 때도 같은 API를 사용했다. 이 응답에는 `PRICE`, `PRICE_VAT_INCLUDE`,
  `PRICE_VAT_YN`, `VAT_YN`, `VAT_RATE_BY`, `CS_MIN_ORDER_QTY`, `UNIT`, `BOM_NO` 등 가격·정책 필드가 추가됐다.
- 화면의 공통 API 래퍼는 `X-ECCSVER` 헤더와 `X-EC-API-Referer` 쿠키도 다룬다. HTTP 재현에서
  이 문맥이 필수인지와 응답 압축 방식은 검증하지 않았다. `X-Compression`이 있으면 현재 파서는 중단한다.

### 명성실버케어의 배송 필드와 초안

이 업체의 양식은 에이엠이에서 관찰한 상단 수취인 입력 양식과 다르다. 배송 정보가 **품목 행마다** 있다.

| 화면 항목 | 그리드 필드 |
|---|---|
| 품목코드·품목명 | `prod_cd`, `prod_des` |
| 수량 | `qty` |
| 수취인 | `remarks` |
| 연락처 | `p_remarks1` |
| 주소 | `p_remarks2` |
| 배송요청사항 | `ADD_TXT_01` |
| 송장번호 | `p_remarks3` |

초안 함수는 관찰한 배송 필드 매핑을 호출자가 명시해야 한다. 다른 업체에 같은 매핑을 자동 적용하지 않는다.
주소는 신규 입력만 받고 거래처 기본 주소를 복사하지 않는다. 배송요청사항에는 `비고(내역)` 원문만 넣고,
비고가 없으면 빈 문자열로 둔다. 주문번호나 설명을 덧붙이지 않는다.
품목·수량·일자·배송 필드의 **검토용 초안**만 반환하며 `submission_ready`는 항상 꺼져 있다.
금액·최소 주문수량·업체별 정책 검증과 추가문자 필드의 `AddDto` 직렬화가 남아 있다.

### 저장과 저장/전표 — 실행하지 않은 스크립트 분석

`xesd004m`의 `footer.save`가 반환하는 공통 API 경로는 `/SVC/Inventory/SaleOrder/Save`다.
관찰한 다른 공통 API와 같은 접두어 규칙을 적용하면 네트워크 경로는
`/ECAPI/SVC/Inventory/SaleOrder/Save`다. 전송 방식은 공통 API 래퍼의 JSON POST 흐름이며,
**이 저장 경로·메서드는 정적 분석에 따른 것으로 실제 전송해 확인하지 않았다**.

본문 구조:

- `Request`: `EditMode`, `CheckPermissionRequest`, `GbType`, `isFromApproval`, `NotiProgramId`, `Data`, `AddDto`.
- `CheckPermissionRequest`: `EditMode`, `GbType`, `ProgramId`, `PFlag`, `IsFromEdms`.
- `Data`: `DecAmt`, `ModifyRowCountOrigin`, `Master`, `Details`, `GwbdRequest`, `CS_CONFIRM`, `CHECK_GB_TYPE_OLD`.
- `Master`: `Key`(`REQ_DATE`, `REQ_NO`), `REQ_DATE`, `REQ_NO`, `TIME_DATE`, `CUST`, `CUST_DES`,
  `FOREIGN_FLAG`, `PJT_CD`, `WH_CD`, `EMP_CD`, `COLL_TERM`, `AGREE_TERM`, `P_DES1`부터 `P_DES6`,
  `TTL_CTT`, `EXCHANGE_TYPE`, `EXCHANGE_RATE`, `P_FLAG`, `REMARKS_WIN`, `NO_TAX`, `INFLOW`,
  `IO_TYPE`, `GB_TYPE`, `VERSION_NO`, `EDMS_DATE`, `EDMS_NO`, `REF_DES`, `HID`, `DISCOUNT_YN`,
  `PRICE_DISCOUNT_AMT`, `GB_TYPE_OLD`, `SALE_AMT`, `SALE_AMT_F`, `VAT_AMT`, `UQTY`, `QTY`, `PROD_DES`.
- `Details` 각 행: `ITEM_CD`, `PROD_CD`, `PROD_DES`, `SIZE_DES`, `UQTY`, `QTY`, `USER_PRICE_VAT`,
  `PRICE`, `AMT`, `AMT_F`, `VAT`, `REMARKS`, `EST_DATE`, `EST_NO`, `DEL_GUBUN`, `P_AMT1`부터 `P_AMT3`,
  `P_REMARKS1`부터 `P_REMARKS4`, `REL_PRG_NM`, `SERIAL_IDX`, `SERIAL_KEY`, `SERIAL_DATE`, `IO_TYPE`,
  `GB_TYPE`, `BOM_NO`, `SUB_PROD_DATA`, `TIME_DATE`, `SER_NO_OLD`, `PRICE_DISCOUNT_STAND`,
  `PRICE_VAT_DISCOUNT_STAND`, `Key.SER_NO`, `SerialList`, `UseUiSerial`.
- `AddDto`: `AddTxt`, `AddLTxt`, `AddNum`, `AddDate`, `AddCd`, `BizzClasCds`.
  별도 이벤트에서 채우며 세부 직렬화는 미확정이다. 그리드의 `ADD_TXT_01`을 기본 `Details`에
  그대로 넣는다고 가정해서는 안 된다.

F7도 먼저 같은 저장 흐름을 거친 뒤 `saveAfterShowSlipPrint`가 반환된 `IoDate`, `IoNo`, `IoType`을
전표 팝업 요청에 사용한다. 팝업 경로는 `/ECERP/SVC/ESD/ESD005R`이며, 메뉴 화면 이동의 POST 형식으로
`Request.Slips`와 `Request.FORM_TYPE`, `BASIC_TYPE`, `cs_flag`, `allP_Flag`, `fax_Flag`,
`FromProgramId`, `TAX_FLAG`, `Data`, `WMS_ID` 등을 넘기는 구조다.
`Slips` 각 행에는 `IO_DATE`, `IO_NO`, `SER_NO`, `IO_TYPE`, `GB_TYPE`, `CUST`, `SALE_PRG_ID`가 있다.
거래처 포털은 `cs_flag`를 덮어쓴다. 팝업 요청도 보내지 않았으므로 실제 메서드·응답은 미검증이다.
모듈에는 저장 함수·전표 함수가 없으며, 저수준 요청 허용 목록에서도 두 주소를 막았다.

### 마지막 읽기 확인과 남은 검증

주문서조회는 `POST /ECAPI/SVC/Common/SlipTransfer/GetListXFormSlipCommon`을 사용했다.
본문은 `Request.Data`이고 주요 필드는 `MENU_SEQ`, `FORM_SER`, `PRG_ID`, `FORM_TYPE`, `FORM_SEQ`,
`BASE_DATE_FROM`, `BASE_DATE_TO`, `PAGE_CURRENT`, `PAGE_SIZE`, `P_FLAG`, `GB_TYPE`, `PARAM`,
`SEARCH_CRITERIA`, `QUICK_SEARCH_TYPE`, `PROD_CD`, `REMARKS` 및 추가 날짜·검색 조건이다.
응답 구조는 `Status`, `Data.TotalCount`, `Data.Data`이며, 오늘을 포함한 기본 조회 기간에서 자료가 없었다.
사전 목록을 수집한 뒤의 비교는 아니므로 과거 전체 기간의 불변까지 증명하는 것은 아니다.

남은 일은 **주문서입력 최초 요청의 메서드·본문 직접 포착, 조회 함수의 HTTP 단독 재현,
업체별 배송 양식과 추가문자 직렬화·가격·정책 검증**이다. 현재 로그인 상한을 넘겨 이를 추가 시험하지 않는다.
새 주문을 저장하지 않았으며 workflow·운영 데이터·커밋·푸시도 변경하지 않았다.

시간표의 **발주마감**은 그 시각까지 들어온 내부 주문을 처리하는 기준이다.
**접수마감**은 제조사에 실제 발주를 넣어야 하는 시각이다.
에이엠이 사이트 공지의 오후 세 시는 접수마감에 해당하며, 시간표의 내부 발주마감과 모순되지 않는다.

### 추가 모의 시험

`python -m unittest test_ecount_http -v`로 네트워크 없는 시험 29개가 통과했다.
화면 XOR 해독·JavaScript 비실행, JSON/Base64 응답, 검색 문맥 복사와 중복 필드, 로그인·조회 실패 중단,
허용하지 않은 저장·전표·삭제 경로 차단, 신규 주소·비고 원문·항상 제출 불가 초안 등을 확인했다.
실제 회사코드·ID·비밀번호·쿠키·토큰·세션·품목·수취인 값은 시험 파일과 증거 파일에 넣지 않았다.

## 1차 조사 결론 (추가 관찰 전, 2026-11-11)

| 항목 | 결과 |
|---|---|
| 브라우저 없는 로그인 | **성공.** 세비앙 2회, 에이엠이 1회 모두 302로 포털에 진입했다. 모듈은 `worker/order-runner/ecount_http.py` |
| 3사 공통 구조 | 같은 포털·같은 로그인 흐름이다. 서버 구역(zone)만 다르다(세비앙·명성실버케어 CC, 에이엠이 CB) |
| 주문 입력 화면 | 로그인 직후 첫 화면이 `주문서입력`이다(에이엠이에서 Aside로 확인). 화면 구조는 아래 |
| 주문 입력의 HTTP 요청 구조 | **미확정.** 품목 검색·선택·저장이 부르는 API 주소와 필드를 확인하지 못했다 |
| 명성실버케어 로그인 | **실패.** 사이트가 "일치하는 비밀번호 정보를 찾을 수 없습니다"를 표시했다. 저장된 비밀번호 오독 가능성이 높다. 추가 시도하지 않았다 |
| 저장·전송 | 누른 적 없다. 주문서·전표는 만들지 않았다 |

## 로그인 흐름 (브라우저 없이 재현됨)

화면 스크립트 `login/external/cs_login.*.js`를 읽어 확정했다.

1. `GET https://c-portal.ecount.com/` — 로그인 화면(쿠키 시작).
2. `POST /ec56/api/login/action/GetZoneAction` JSON `{com_code, service:"CS"}` — 응답 `Data`에 `ZONE`, `COM_CODE`, `DOMAIN`. 회사코드가 없으면 `EMPTY_ZONE`.
3. `POST /ec56/api/login/action/GetZoneInfoAction` JSON `{}` — 응답 `Data.ts`(서버가 30초 창으로 검증하는 HMAC).
4. `POST https://c-portal{ZONE}.ecount.com/ec56/view/login/cs_login_processor` 폼(urlencoded). 필드: `cs_com_code`(입력한 회사코드), `com_code`(2단계 `COM_CODE`), `id`, `spasswd`, `loginck`, `ts`, `login_type=C`, `domain`, `lan_type`, `zone`, `error_code`, `error_msg`, `platformVersion`.
5. 성공은 `302`이고 `Location`이 `https://c-portal{zone}.ecount.com/ec5/view/c_portal?ec_req_sid=...`다. 쿠키 이름은 `ECOUNT_SessionId`, `EcNewDeviceKey`, `SVID`, `cslogin_info_cookie`. 실패는 `200`으로 로그인 화면을 다시 돌려준다(Aside에서 오류 문구 확인).

비밀번호 변환은 화면 스크립트의 `ecProtHPr.AX`다. 토큰은 `(Date.now()+'')`의 앞 7자리이고, 비밀번호 UTF-8 바이트를 토큰 글자와 순환 XOR해 16진수로 만든 뒤 `토큰길이 + 토큰 + 16진수`를 `spasswd`로 보낸다. 서버가 평문을 받지 않으므로 별도 암호 라이브러리가 필요 없다(표준 라이브러리만 쓴다).

구현 메모:
- 로그인 이후 **모든 요청은 쿼리 `ec_req_sid`가 필요하다.** 쿠키만으로는 로그인 화면(302)으로 돌려보낸다. 화면 스크립트도 현재 주소의 `ec_req_sid`를 모든 API 주소에 붙인다.
- 로그인 요청은 객체당 한 번만 보낸다. 캡차·잠금·OTP 문구가 보이면 멈춘다(`check_stop_signal`). 쿠키는 메모리에만 둔다.
- 요청 대상은 `https://*.ecount.com`으로 제한하고 리다이렉트는 따라가지 않는다.

## 포털 화면 구조 (Aside 관찰, 에이엠이)

- 로그인 직후 화면은 `주문서입력`이다. 상단 메뉴: 기본그룹 / 공지사항 / 주문서입력 / 주문서조회 / 주문서현황 / 판매조회 / 판매현황 / 거래처관리대장 / 설치의뢰(설치의뢰서 입력·조회). 업체마다 그룹 공지(주문 마감 안내 문구 등)가 화면 위쪽에 표시된다.
- 입력 칸: `일자`, `납기일자`, `특이사항`, `이름(상호)`, `연락처`, `주소`(옆에 `찾기(F3)`), 품목 그리드(`품목코드`, `품목명`, `규격`, `수량`, `단가`, `공급가액`, `부가세`, `합계액`). 수취인 정보는 별도 칸이 아니라 `이름(상호)`·`연락처`·`주소`·`특이사항`에 들어가는 구조로 보인다.
- 버튼: `저장(F8)`, `저장/전표(F7)`, `다시 작성`, `리스트`, `관심품목`, `견적`, `바코드`, `검증`. **모두 누르지 않았다.** 입력칸에서 Enter·F7·F8도 쓰지 않았다.
- 같은 페이지 틀(`/ec5/view/c_portal`)에서 메뉴로 SPA가 화면을 바꾼다. 화면 정의 목록에는 거래처 포털 전용으로 `IQuotationCPortalListPage`(주문서조회, 프로그램 N000136)와 `IQuotationCPortalOutstandingStatusPage`(주문서현황, N000139)가 있다. 주문서입력 페이지 식별자는 이번에 확정하지 못했다.

## 요청 구조 — 확인된 것과 못 찾은 것

확인됨:
- 화면 메뉴는 JSONP `GET /ECERP/SVC/Popup/GetListCacheTopMenuCsV2?jsonp=eccb&v=...`, `GetListCacheMyPageCsV2`, `GetAllMenuCacheVersion`에서 오고, `v`는 사용자 정보 JSON(`ComInfo`, `ComCode`, `UserId`, `DomainType`, `LanType`, `Version`)을 키 `ecount`로 XOR한 16진수다. JSON 직렬화는 `Object.toJSON` 형식(`", "`와 `": "` 구분)이다. 이 방식으로 보낸 요청은 `ec_req_sid` 없이 500, 붙인 뒤에는 로그아웃 주소(`ERPLogout`)로 302가 나와 **재현에 실패했다.** 필드 구성이 서버와 다르다. 잘못된 호출이 세션을 끊을 수 있어 중단했다.
- `/ec5/api/...` 경로 API는 화면 프레임워크가 본문 암호화 옵션을 갖고 있다(`v5rqa` 계열, `xce=none` 표지). `/ec56/api/...`(로그인 쪽)는 평문 JSON이었다. 주문 입력 화면이 어느 쪽을 쓰는지는 미확인이다.

못 찾음(남은 일의 핵심):
1. 품목 검색·선택, 수량 입력, 거래처 정보 입력, 저장(F8) 각각의 요청 주소·메서드·필드·토큰 의존성·응답 형식.
2. 주문서조회·주문서현황의 조회 API (읽기 전용이라 분석하기 쉬운 첫 대상).
3. 저장 후 주문번호(전표번호)가 응답에 어떻게 나오는지.

## 막힌 이유와 절차

- 정적 분석(스크립트 읽기)만으로는 주문서입력 페이지 모듈과 API를 특정하지 못했다. 네트워크 요청을 직접 관찰하는 것이 가장 빠르다.
- Aside 관찰은 `aside repl` 호출이 끝나면 연 탭이 닫혀 한 번의 호출(120초)에서 끝내야 한다. 업체당 로그인 상한(2회) 때문에 반복할 수 없었다. 사용 현황: 세비앙 HTTP 2회, 에이엠이 HTTP 1회+Aside 1회, 명성실버케어 Aside 1회(비밀번호 불일치). 이 업체들은 더 시도하지 않았다.
- 다음 시도의 조건: (a) 명성실버케어의 올바른 비밀번호를 사용자에게 확인(그러면 업체 1회가 남는다), (b) 한 번의 로그인 안에서 `주문서입력` 첫 화면의 품목 칸에 키 입력(자동완성 조회)과 `주문서조회`를 열어 요청 로그를 모두 남기는 일회성 스크립트를 준비해 둔다. 저장 계열 키는 쓰지 않는다.

## 판정

- 로그인과 포털 진입은 **브라우저 없이 가능하다**(검증됨).
- 주문 입력·조회 요청의 HTTP 재현 가능성은 **판단 보류**다. 같은 포털이고 화면이 SPA라 API가 있을 가능성이 높지만, 암호화 옵션 때문에 확정할 수 없다.
- 세 업체가 구조를 공유한다는 판정은 로그인(3사 중 zone 조회 3사 확인, 로그인 성공 2사)과 화면 틀에서만 확인했다. 업체별 차이(그룹 공지, 메뉴 구성, 가격·품목 범위)는 이 1차 조사에서는 에이엠이만 봤다. 마감 용어의 해석과 명성실버케어의 추가 확인은 위 최신 결과를 따른다.

## 시험

`worker/order-runner/test_ecount_http.py`: 비밀번호 변환, 토큰, zone 주소 검증, 평문 비밀번호 미포함, 중단 신호, 허용 호스트, 로그인 1회 제한(재시도 금지), 실패 로그인 구조, 회사코드 없음, `ec_req_sid` 부착을 네트워크 없이 시험한다. 실행: `cd worker/order-runner && python -m unittest test_ecount_http`.
