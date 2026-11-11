# 이카운트 거래처 포털(ERP) 발주 분석

대상은 직배 시간표에서 발주 수단이 ERP인 업체 3곳(세비앙, 명성실버케어, 에이엠이)이다. 모두 이카운트 거래처 포털
`https://c-portal.ecount.com/`로 주문한다. 운영은 브라우저 없는 HTTP 요청이어야 하고, 실제 발주 금지는 해제되지 않았다.
회사코드, ID, 비밀번호, 세션 값, 업체 화면의 실제 데이터는 이 문서에 적지 않는다. 원본 응답과 스크립트는 `.local-analysis/ecount/`에만 있다.

## 세비앙 시험 결과 (2026-11-11, 읽기 전용 HTTP)

로그인은 이번 작업에서 3회(HTTP, 자동 재시도 없음)였고 모두 성공했다. 저장·저장/전표·전표·서버 임시저장 요청과
Aside 사용은 없었다. 마지막 로그인 세션에서 조회한 데이터를 `.local-analysis/ecount/`(git 제외)에 저장해 이후 분석은 오프라인으로 했다.

| 항목 | 결과 |
|---|---|
| 로그인 → 주문서입력 데이터 → 양식 → 품목 검색 → 주문서조회 | 성공 |
| 발주서 품목 검색 | `CP600`, `CV200`은 1건씩 일치. `CV-100`은 0건(표기 차이 가능, 다른 검색어 확인 필요). 직배설치 표기가 붙은 품목은 별도 코드 여부 미확인 |
| 입력 그리드 | 보이는 열은 품목코드·품명·규격·수량뿐. 숨은 열 중 `p_remarks1`(설치/택배)은 품목의 기본값(택배)을 받는다 |
| **배송지 칸 위치** | 그리드가 아니라 **상단(Master)의 `P_DES3~P_DES6`**로 보인다. 기존 세비앙 주문서 20건에서 `P_DES4`는 전화 형식 20/20, `P_DES5`는 주소 형식 19/20, `P_DES6`은 장문 설명, `P_DES3`은 이름형 14종이었다. `P_DES1`은 3종뿐인 분류형 값이다. 매핑은 **형태에서 추정한 것이고 화면 라벨은 확인하지 못했다.** `ADD_TXT_*`가 아닌 Master 필드라 AddDto는 비어 있다 |
| 금액 | 조회 응답의 단가·부가세 별도/포함 단가가 세율 10%로 서로 맞고, 수량 1 기준 공급가액·부가세·합계가 내부적으로 일치했다. **서버가 저장 시 계산하는 값과의 대조는 하지 못했다.** 저장 전 검증 요청이 조회 전용인지 불분명해 보내지 않았다 |
| 최소 주문수량 | 품목 값은 비어 있고(0) 계정 정책은 `N`(제한 없음)이다. 정책 확정 판정은 현재 함수가 빈 값을 거부해 `미확정`으로 남는다 |
| 저장 본문 대조 | `draft_save_projection`이 Master의 배송 필드와 Details를 투영한다. 전체 Request(권한·Master 전 필드·Details 전 필드)는 만들지 않으며 `complete`와 `submission_ready`는 계속 거짓이다 |
| 주문서조회 | 세비앙 기존 주문서가 있다(전체 건수 두 자리, 첫 페이지 20건). 작업 시작 시점 한 번만 조회했고 마지막 재조회는 로그인 상한 때문에 하지 못했다. 이 작업에서 주문을 만드는 요청을 보내지 않았으므로 새 주문 생성 가능성은 낮지만 **불변을 직접 확인한 것은 아니다** |

코드 변경: `SEBIAN_DELIVERY_FIELDS`(Master 매핑, 추정), `compute_line_amounts`(오프라인 계산, 서버 검증 아님),
`create_order_draft`의 Master 배송 지원. 모의 시험은 44개가 통과했다.

남은 일: 상단 `P_DES1~6`의 화면 라벨 확인(헤더 입력 양식 조회 또는 화면 1회 관찰), 전체 저장 본문 필드 대조,
서버 금액 대조, `CV-100`·직배설치 품목의 ERP 품목코드 연결표, 마지막 주문서조회 재확인.

## 최신 결과 (2026-11-11, 세 업체 HTTP 재현 — 일부 미완료)

세비앙·명성실버케어·에이엠이 모두 브라우저 없는 HTTP로 로그인, 주문서입력 HTML,
품목 양식, 일반 검색, 정확한 품목 선택과 주문서조회를 재현했다. 응답과 초안은 메모리에서만
사용했다. **전체 목표는 미완료**다. 세비앙·에이엠이의 입력 화면 배송 필드 매핑과 전체 저장 본문의
오프라인 일치, 금액·정책 검증은 남아 있으며 초안의 제출 가능 여부는 모두 꺼져 있다.

| 대상 | 세비앙 | 명성실버케어 | 에이엠이 |
|---|---|---|---|
| HTTP 로그인·입력 화면·품목 양식 | 성공 | 성공 | 성공 |
| HTTP 검색·정확한 코드 선택 | 성공 | 성공 | 성공 |
| 가격·세금 필드 존재 확인 | 확인 | 확인 | 확인 |
| 신규 배송 정보로 메모리 초안 생성 | 성공, 필드 미배치 | 성공, 기존 관찰 매핑 사용 | 성공, 필드 미배치 |
| 추가문자 오프라인 투영 | 매핑 보류 | 구조 대조 성공 | 매핑 보류 |
| 전체 저장 요청 본문 일치 | 미완료 | 미완료 | 미완료 |
| 금액·최소수량·업체별 정책 승인 | 보류 | 보류 | 보류 |

이번 로그인은 업체마다 HTTP와 Aside를 합쳐 세 번씩이며 자동 로그인 재시도는 없었다.
최종 HTTP 검증은 업체마다 한 세션에서 진행했다. Aside 관찰 스크립트는 별도 프로세스로
종료돼 하나의 REPL을 끝까지 유지한다는 절차를 충족하지 못했다.
업체별 조회 스냅샷의 최종 비교 판정은 로컬 증거 파일
.orca-routing/tasks/ecount-3/evidence.json에 기록한다.
마지막 HTTP 주문서조회에서 세 업체 모두 오늘을 포함하는 기본 기간의 전체 건수와
첫 페이지 주문 식별자 집합이 이전 스냅샷과 같았고 새 식별자가 없었다.
모든 페이지·과거 전체 기간의 불변을 검증한 결과는 아니다.

### 직접 확인한 입력 화면 요청

명성실버케어에서 주문서조회 메뉴를 연 뒤 주문서입력을 다시 열어 다음 요청의
메서드·본문 필드·성공 응답을 직접 관찰했다. **로그인 직후 자동으로 열리는 첫 요청 자체를
계측한 것은 아니다.** 이 구분을 유지한다.

- POST /ECERP/SVC/CSA/ESD004M
- JSON 본문: alreadyIncludedLayout(불리언), requestKey(문자열), viewer_id(문자열),
  panel_id(문자열), is_from_left_menu(불리언), PRG_ID(문자열).
- 프로그램은 E040203, 조회 메뉴는 E040204다. 생성한 ESD004M_… 화면 식별자를
  requestKey로 보내면 응답의 viewBag에서 같은 식별자를 사용한다.
- 응답은 HTTP 200 HTML이며 초기 JSON과 XOR 부분은 기존 파서 방식으로 읽는다.
- 독립 GET에는 화면 식별자가 빈 응답도 있었다. 빈 식별자는 프로그램 식별자까지
  일치할 때만 허용한다. 세 업체의 주 검증은 메뉴 이동 POST를 사용했다.

load_order_input_data()는 관찰한 여섯 필드를 스스로 만들며 현재 세션의 초기 데이터를
읽는다. 브라우저에서 계정 문맥을 복사해 주입할 필요가 없다.

### 품목 양식·검색의 HTTP 보완

POST /ECAPI/Common/Form/GetFormView는 화면의 DefaultOption.FormKey에서
입력 양식과 차수를 읽어 열 정의를 반환했다. 본문 필드는 FormType, FormSeq,
FormTypeMaster, ReturnType, BasicType, IsConvertColumnCode, ViewType다.
이 경로로 얻은 열 정의만으로 추가문자나 모든 상단 배송 입력의 매핑까지 확정할 수는 없다.

품목 검색 API는 이전 관찰과 같다. 다만 **실제 검색어는 PARAM에도 넣어야 한다.**
keyword만 바꾸고 PARAM을 비워 두면 품목코드로 검색해도 필터링되지 않은 여러 행이
돌아왔다. 공통 입력 컨트롤의 setRequestParameter, copyParamToRequestData를 대조한 뒤
PARAM과 keyword를 루트와 Request.Data에 반영했다. 세 업체 모두 정확히 일치하는
품목 한 행과 가격·세금 필드를 받았다.

검색 문맥은 같은 HTTP 입력 화면의 거래처·창고·일련번호 일자와 가격 소수 자릿수 설정에서
만든다. 응답의 X-Compression: ecbzip와 Base64 UTF-8 JSON 조합을 실서버에서 확인했다.
이 표지라도 JSON 해독이 되지 않으면 중단하며 다른 압축을 추측해 풀지 않는다.
암호 필드는 초안 작성에 필요하지 않아 화면 파서의 반환 데이터에서 제외한다.

추가로 시험한 양식 캐시 GET은 302로 거부돼 해당 세션을 중단했다. 실패 경로는 모듈의
허용 목록에서 제거했으며 우회나 같은 요청 재시도는 하지 않았다.

### AddDto 직렬화와 저장 구조의 오프라인 대조

입력 화면과 공통 그리드·상단 양식의 스크립트에서 다음 동작을 확인했다.
저장 함수를 실행해 얻은 본문이 아니라 **소스의 이벤트 처리 흐름**을 분석한 결과다.

- AddDto에는 AddTxt, AddLTxt, AddNum, AddDate, AddCd, BizzClasCds 배열이 있다.
- 상단 추가문자는 SLIP_CLAS_CD: M, 품목 행은 T를 사용한다.
- Key는 BIZZ_CLAS_CD, ADD_ITEM_ID, ADD_ITEM_NO, ADD_ITEM_SNO다.
  주문서는 업무 구분이 ORD, ID는 주문 일자, 신규 번호는 영이며,
  상단 행번호는 문자열 영, 품목은 표시 행번호다.
- 추가문자 컨트롤은 비어 있지 않은 ADD_TXT_01 등의 값을 AddTxt 행에 넣는다.
  저장 직전에는 빈 객체나 SLIP_CLAS_CD가 없는 행을 다섯 배열에서 제거한다.
  BizzClasCds는 별도로 남는다.
- 명성실버케어의 remarks, p_remarks1, p_remarks2는 기본 상세의
  REMARKS, P_REMARKS1, P_REMARKS2로 투영하고, 배송요청의 ADD_TXT_01은
  Details가 아니라 AddDto.AddTxt에 투영한다.

serialize_add_text_dto()와 draft_save_projection()은 이 **일부 필드의 투영만**
오프라인으로 만든다. 네트워크 요청, 저장 주소, 전체 Request는 생성하지 않는다.
전체 Master·Details와 권한·금액·세금·추가 유형까지 일치하는 완성된 저장 본문은
구현하지 않았고 투영의 complete는 항상 거짓이다.
세비앙·에이엠이 초안은 수취인·연락처·신규 주소·비고를 별도의 미배치 영역에 보관한다.

F8과 F7의 주소·메서드·필드 구조는 아래 이전 정적 분석을 유지한다.
이번에도 저장·저장/전표·전표 팝업·서버 임시저장 요청을 전송하지 않았다.

### 정책과 검증 한계

정확한 품목 선택에서 PRICE, PRICE_VAT_INCLUDE, PRICE_VAT_YN, VAT_YN,
VAT_RATE_BY, CS_MIN_ORDER_QTY 필드의 존재를 확인했다. 시험 품목의 최소수량은
유효한 숫자로 확정하지 못했으므로 충족 판정은 보류다. 필드가 있다는 이유로 금액이나
최소 주문수량 검증에 성공했다고 판정하지 않는다.

소스는 계정의 최소수량 정책이 기본값이면 회사 설정으로 대체하며, 저장 전 검증 단계에
MinOrderQtyDto의 CUST, EditFlag, IoNoTypeKey, IsMinOrderQty,
IsMinOrderQtyById, BottomDetail을 전달한다. 이 단계에는 문서번호 관련 검사도 섞여 있어
조회 전용이라고 확정하지 못했으며 요청하지 않았다. 단가 편집과 공급가액·세금 칸은 거래처
포털에서 제한하는 코드가 있다. 실제 운임·반올림·최종 금액·업체별 예외 정책은 미검증이다.

모의 시험 42개가 통과했다. 원래의 저장·전표 차단과 신규 주소·비고 원문 규칙을 유지하면서
화면 식별자, 실제 검색 조건, 양식·목록 조회, Base64 응답과 추가문자 직렬화를 보완했다.
운영 큐·Firebase·workflow는 연결하거나 실행하지 않았고 커밋·푸시는 하지 않았다.

## 이전 결과 (2026-11-11, 명성실버케어 추가 관찰)

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
