import type { SourceWorkbook } from "../worker/order-runner/workbook-policy.mjs";

export default function WorkbookSheetPicker({ source, selectedSheet, onSelect, disabled = false }: {
  source: SourceWorkbook; selectedSheet: string; onSelect: (sheet: string) => void; disabled?: boolean;
}) {
  const visible = source.sheets.filter(sheet => sheet.state === "visible");
  const hidden = source.sheets.length - visible.length;
  return <section aria-label="발주 시트 선택" className="space-y-3 border-b border-slate-200 bg-sky-50/50 p-4">
    <p className="text-sm font-semibold">{visible.length > 1 ? "처리할 시트 하나를 선택해 주세요" : "처리 시트 확인"}</p>
    {hidden ? <p className="text-sm text-amber-800">숨김 시트 {hidden}개가 있습니다. 숨김 시트는 선택·처리 대상에서 제외합니다.</p> : null}
    <label className="block text-sm">처리 시트
      <select aria-label="처리 시트" disabled={disabled} value={selectedSheet} onChange={event => onSelect(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 bg-white p-2">
        <option value="">시트를 선택해 주세요</option>
        {visible.map(sheet => <option key={sheet.name} value={sheet.name}>{sheet.name}</option>)}
      </select>
    </label>
    <ul className="space-y-2 text-sm text-slate-700">{visible.map(sheet => <li key={sheet.name} className="rounded-lg border border-slate-200 bg-white p-3">
      <strong>{sheet.name}</strong> · 사용 행 {sheet.rowCount}개 (머리글 포함)
      <p className="mt-1 break-words text-xs text-slate-500">머리글: {sheet.headers.join(", ") || "인식된 머리글 없음"}</p>
    </li>)}</ul>
    {!selectedSheet ? <p role="alert" className="text-sm text-amber-800">시트 선택 전에는 저장·서버 준비 요청을 할 수 없습니다.</p> : null}
  </section>;
}
