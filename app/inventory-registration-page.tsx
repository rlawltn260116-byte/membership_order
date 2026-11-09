import { ClipboardList, PauseCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deliverySchedule } from "../worker/order-runner/schedule.mjs";

const procedure = [
  {
    title: "명세서 수신·검수 결과 확인",
    status: "결과 연동 전",
    text: "이메일 명세서는 Outlook ‘공급망혁신팀 공용’ 메일함의 검수 결과를 확인합니다. 다른 경로로 받은 명세서도 원본과 함께 확인합니다. 페이지 누락·반복, 품목·수량·단가·금액·합계를 대조합니다.",
  },
  {
    title: "기존 주문 연결",
    status: "규칙 확정",
    text: "해당 업체에 보낸 발주서의 수신자·주소·품목·수량을 명세서와 비교합니다. 네 값이 모두 맞는 기존 주문이 정확히 하나일 때만 자동 연결하며, 없거나 둘 이상이면 보류합니다. 자동 연결은 아직 구현 전입니다.",
  },
  {
    title: "가상 입고 등록",
    status: "입력 절차 미확정",
    text: "명세서 한 건당 재무 처리를 위한 가상 입고 1건을 등록합니다. 입고 금액에는 명세서 금액을 입력합니다. 실제 메뉴·필수값·입력 순서는 아마란스 화면 학습 후 확정합니다.",
  },
  {
    title: "기존 주문 출고 처리",
    status: "입력 절차 미확정",
    text: "연결한 아마란스 기존 주문을 출고 처리합니다. 출고처(수급자·소매점)는 기존 주문을 따릅니다. 출고 금액은 품목에 등록된 판매가로 자동 입력되므로 직접 입력하지 않고 대조만 합니다.",
  },
  {
    title: "입고·출고 전표 재조회·대조",
    status: "조회 절차 미확정",
    text: "입고와 출고의 날짜·품목·수량이 일치하는지 확인합니다. 입고 금액은 명세서와, 출고 금액은 품목 판매가와 대조합니다. 두 전표번호와 대조 결과를 확인한 뒤에만 입출고 완료로 기록합니다.",
  },
];

const holdReasons = [
  "일치하는 기존 주문이 없거나 둘 이상인 경우",
  "품목코드·규격·단위·포장수량 또는 입고·출고 수량이 다른 경우",
  "반품·음수·취소·정정 명세서",
  "동일 파일 또는 다른 수신 경로로 들어온 중복 명세서",
  "페이지 누락·반복, 읽지 못한 숫자, 단가·금액·합계 오류",
  "부분 납품·합배송·여러 주문이 섞인 명세서",
];

const channelNames = ["이메일", "카톡", "팩스", "B2B몰", "ERP"];

export default function InventoryRegistrationPage() {
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200/70 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><ClipboardList className="h-5 w-5 text-teal-700" />명세서 검수 후 아마란스 입출고</h2>
          <Badge className="border-amber-200 bg-amber-50 text-amber-800">절차 안내 · 실제 등록 미연동</Badge>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-600">직배는 제조사가 고객에게 바로 배송하므로 실물 입고가 없습니다. 검수한 명세서 한 건을 가상 입고 1건 + 출고 1건의 한 쌍으로 처리하며, 창고 검수·재고 실사 단계는 없습니다.</p>
        <p className="mt-2 text-sm leading-6 text-slate-600">현재는 업무 절차와 준비 상태를 보여줍니다. 명세서 검수 결과와 전표 이력은 아직 연동되지 않았으며, 이 화면에서 실제 아마란스 저장이나 발주를 실행하지 않습니다.</p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["명세서 검수 결과", "미연동"],
            ["가상 입고", "등록 미연동"],
            ["기존 주문 출고", "등록 미연동"],
            ["전표 재조회·대조", "미연동"],
          ].map(([label, state]) => (
            <div key={label} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <dt className="text-sm text-slate-600">{label}</dt>
              <dd className="mt-2 font-semibold text-slate-800">{state}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs leading-5 text-slate-500">위 상태는 연동 준비 상태입니다. 주문 관리의 ‘주문 완료’는 발주 접수 완료이며, 명세서 검수나 입출고 등록 완료를 뜻하지 않습니다.</p>
      </section>

      <section className="rounded-2xl border border-slate-200/70 bg-white p-5">
        <h2 className="text-lg font-semibold">업무 절차</h2>
        <p className="mt-1 text-sm text-slate-500">확정된 업무 규칙을 순서대로 확인합니다. 실제 아마란스 메뉴와 입력 순서는 학습 전입니다.</p>
        <ol className="mt-5 space-y-4">
          {procedure.map((step, index) => (
            <li key={step.title} className="flex gap-3 rounded-xl border border-slate-200 p-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-sm font-semibold text-indigo-600">{index + 1}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{step.title}</h3>
                  <Badge className={step.status === "규칙 확정" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}>{step.status}</Badge>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-600">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid items-start gap-4 xl:grid-cols-2">
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-amber-900"><PauseCircle className="h-5 w-5" />보류·별도 검토 기준</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">
            {holdReasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
          <p className="mt-3 text-sm leading-6 text-slate-700">불일치 값은 추측하거나 자동 보정하지 않습니다. 보류 사유와 원본을 확인한 뒤 별도 검토합니다.</p>
        </div>
        <div className="rounded-2xl border border-slate-200/70 bg-white p-5">
          <h2 className="text-lg font-semibold">완료 판정과 남은 준비</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-600">
            <li>입고·출고 상태를 각각 기록하고, 두 전표의 재조회·대조가 끝나야 한 쌍을 완료로 처리합니다.</li>
            <li>한쪽만 성공하면 성공한 전표를 다시 만들지 않습니다. 저장 후 응답이 끊겨도 재제출 전에 기존 전표부터 조회합니다.</li>
            <li>실제 등록 메뉴·필수값·입력 순서·재조회 방법은 미확정입니다. 공식 API·엑셀 업로드 지원 여부도 확인해야 합니다.</li>
            <li>검수 결과와 등록 이력 연결, 대표 명세서와의 대조, 실제 화면 학습이 남아 있습니다.</li>
          </ul>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200/70 bg-white p-5">
        <h2 className="text-lg font-semibold">업체별 명세서 수신 경로</h2>
        <p className="mt-1 text-sm leading-6 text-slate-500">직배 시간표의 명세서 수신 경로 기준입니다. 발주 수단과 다를 수 있으며, 같은 업체의 여러 회차를 각각 셉니다.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {channelNames.map((channel) => (
            <Badge key={channel} className="border-slate-200 bg-slate-50 text-slate-700">{channel} {deliverySchedule.filter((entry) => entry.statementChannel === channel).length}회차</Badge>
          ))}
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-600">이메일: Outlook ‘공급망혁신팀 공용’ 메일함. 아래 경로 표는 자동 수신이나 검수 완료 상태를 나타내지 않습니다.</p>
        <details className="mt-4 rounded-xl border border-slate-200">
          <summary className="cursor-pointer p-4 text-sm font-semibold text-teal-800">전체 {deliverySchedule.length}개 회차의 수신 경로 보기</summary>
          <div className="overflow-x-auto border-t border-slate-200">
            <Table>
              <TableHeader><TableRow><TableHead>업체</TableHead><TableHead>발주 회차</TableHead><TableHead>발주 수단</TableHead><TableHead>명세서 수신 경로</TableHead></TableRow></TableHeader>
              <TableBody>
                {deliverySchedule.map((entry, index) => (
                  <TableRow key={`${entry.vendor}-${index}`}>
                    <TableCell className="font-medium">{entry.vendor}</TableCell>
                    <TableCell>{entry.round || entry.orderDeadline}</TableCell>
                    <TableCell>{entry.method}</TableCell>
                    <TableCell>{entry.statementChannel || "확인 필요"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </details>
      </section>
    </div>
  );
}
