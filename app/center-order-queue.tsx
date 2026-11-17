"use client";

import { useEffect, useRef, useState } from 'react';
import type { Workbook } from 'exceljs';
import { Button } from '@/components/ui/button';
import WorkbookSheetPicker from './workbook-sheet-picker';
import { inspectWorkbook, selectWorksheet, orderFileDate, type SourceWorkbook } from '../worker/order-runner/workbook-policy.mjs';
import { parseCenterSheet, prepareCenterEntries, centerQueueGroups, koreaDay, type CenterRow, type CenterRoot } from '../worker/order-runner/center-queue.mjs';
import { listCenterQueue, saveCenterUpload, makeCenterOnlyJob, excludeHeldCenter } from '@/lib/firebase-order-ops';

type UploadFile = { id: string; filename: string; workbook: Workbook; source: SourceWorkbook; selectedSheet: string; sourceDate: string; rows: CenterRow[]; error: string };
const stateLabel: Record<string, string> = { WAITING: '대기', RESERVED: '예약됨', COMPLETED: '발주 완료', UNASSIGNED: '보류 · 발주처 미정', EXCLUDED: '제외됨' };

export default function CenterOrderQueue({ jobs, onOpenJob, onChanged }: { jobs: Array<{ id: string; createdAt: string; sourceSystem: string }>; onOpenJob: (id: string) => void; onChanged: () => Promise<void> }) {
  const [uploads, setUploads] = useState<UploadFile[]>([]);
  const [queue, setQueue] = useState<CenterRoot>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(() => new Date());
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  async function refresh() { setQueue(await listCenterQueue()); setNow(new Date()); }
  useEffect(() => {
    let active = true;
    const update = async () => {
      try { const value = await listCenterQueue(); if (active) { setQueue(value); setNow(new Date()); } }
      catch { if (active) setMessage('센터 대기열 조회에 실패했습니다. 새로고침해 주세요.'); }
    };
    void update();
    const timer = window.setInterval(() => void update(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  function parse(upload: UploadFile, selectedSheet: string, sourceDate: string): UploadFile {
    try {
      if (!selectedSheet) return { ...upload, selectedSheet, sourceDate, rows: [], error: '처리 시트를 선택해 주세요.' };
      if (!/^20\d{2}-\d{2}-\d{2}$/.test(sourceDate) || new Date(`${sourceDate}T00:00:00Z`).toISOString().slice(0, 10) !== sourceDate) throw new Error('원본 날짜를 확인해 주세요.');
      return { ...upload, selectedSheet, sourceDate, rows: parseCenterSheet(selectWorksheet(upload.workbook, selectedSheet), { filename: upload.filename, sourceDate, sourceWorkbook: upload.source }), error: '' };
    } catch (error) { return { ...upload, selectedSheet, sourceDate, rows: [], error: error instanceof Error ? error.message : '센터 파일 해석 실패' }; }
  }
  async function loadFiles(files: File[]) {
    const token = ++generation.current;
    setBusy(true); setMessage(''); setUploads([]);
    try {
      const ExcelJS = (await import('exceljs')).default;
      const values: UploadFile[] = [];
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.xlsx') || file.size > 10 * 1024 * 1024) throw new Error('센터 파일은 10MB 이하의 .xlsx로 올려주세요.');
        const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await file.arrayBuffer());
        const source = inspectWorkbook(workbook, file.name);
        const visible = source.sheets.filter(sheet => sheet.state === 'visible');
        if (!visible.length) throw new Error(`${file.name}: 보이는 시트가 없습니다.`);
        const date = orderFileDate({ filename: file.name });
        const sourceDate = date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : '';
        const upload = { id: crypto.randomUUID(), filename: file.name, workbook, source, selectedSheet: '', sourceDate, rows: [], error: '' };
        values.push(parse(upload, visible.length === 1 ? visible[0].name : '', sourceDate));
      }
      if (token === generation.current) setUploads(values);
    } catch (error) { if (token === generation.current) setMessage(error instanceof Error ? error.message : '파일 읽기 실패'); }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function save() {
    if (!uploads.length || uploads.some(file => file.error || !file.rows.length)) return;
    setBusy(true);
    try {
      const prepared = await prepareCenterEntries(uploads.flatMap(file => file.rows));
      await saveCenterUpload(prepared);
      setUploads([]); setMessage('센터 발주를 저장했습니다. 기존 검증 보류 행은 수정본으로 교체하고 같은 행은 중복 저장하지 않았습니다.');
      await refresh(); await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : '센터 저장 실패'); }
    finally { setBusy(false); }
  }
  async function makeJob(supplier: string, scheduleKey?: string | null) {
    setBusy(true);
    try { const id = await makeCenterOnlyJob(supplier, scheduleKey || undefined); await refresh(); await onChanged(); onOpenJob(id); }
    catch (error) { setMessage(error instanceof Error ? error.message : '센터 작업 생성 실패'); }
    finally { setBusy(false); }
  }
  async function excludeHeld(id: string) {
    setBusy(true);
    try {
      await excludeHeldCenter(id); await refresh(); await onChanged();
      setMessage('보류 항목을 제외했습니다. 같은 원본 파일의 수정본을 다시 올리면 교체할 수 있습니다.');
    } catch (error) { setMessage(error instanceof Error ? error.message : '보류 항목 제외 실패'); }
    finally { setBusy(false); }
  }
  const root = { jobs: Object.fromEntries(jobs.map(job => [job.id, job])), 'center-queue': queue };
  const groups = centerQueueGroups(root, now);
  return <section aria-label="센터 발주 대기열" className="space-y-5">
    <div className="rounded-2xl border bg-white p-5">
      <h2 className="text-lg font-semibold">센터 발주 대기열</h2>
      <p className="my-3 text-sm text-slate-600">전날 센터 발주서를 다음 날 아침 한 번 올립니다. 발주처별 오늘 첫 제조사 작업에 자동으로 합칩니다. 이로움·안앤락은 품목이 속한 회차의 첫 작업에 합치며 회차 확인 필요 상품은 자동 포함하지 않습니다. 기준일: {koreaDay(now)} (한국시간)</p>
      <p className="my-3 text-sm text-slate-600">검증 완료된 상품만 작업에 포함합니다. 검증 보류 상품은 사유를 확인하고 같은 파일명·날짜·시트·행의 수정본을 다시 올리거나 아래에서 제외해 주세요.</p>
      <Button disabled={busy} onClick={() => input.current?.click()}>센터 발주 올리기</Button>
      <Button className="ml-2" disabled={busy} variant="outline" onClick={() => void refresh().catch(() => setMessage('센터 대기열 조회 실패'))}>대기열 새로고침</Button>
      <input ref={input} aria-label="센터 발주 파일 여러 개 선택" className="hidden" type="file" multiple accept=".xlsx" disabled={busy} onChange={event => { const files = Array.from(event.target.files || []); event.currentTarget.value = ''; if (files.length) void loadFiles(files); }} />
      {message ? <p role="status" className="mt-3 text-sm">{message}</p> : null}
    </div>
    {uploads.map(upload => <article key={upload.id} className="rounded-2xl border bg-white p-4">
      <h3 className="break-all font-semibold">{upload.filename}</h3>
      <label className="my-3 block text-sm">원본 발주 날짜 (업로드 날짜와 별도)
        <input aria-label={`${upload.filename} 원본 날짜`} className="ml-3 rounded border p-2" type="date" value={upload.sourceDate} disabled={busy} onChange={event => setUploads(current => current.map(file => file.id === upload.id ? parse(file, file.selectedSheet, event.target.value) : file))} />
      </label>
      <WorkbookSheetPicker source={upload.source} selectedSheet={upload.selectedSheet} disabled={busy} onSelect={sheet => setUploads(current => current.map(file => file.id === upload.id ? parse(file, sheet, file.sourceDate) : file))} />
      {upload.error ? <p role="alert" className="mt-3 text-amber-800">{upload.error}</p> : <><p className="my-3 text-sm">{upload.rows.length}행 · 저장할 발주처와 수취인을 확인해 주세요.</p>
        <div className="max-h-64 overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{['원본 행', '발주처', '품명', '수량', '수취인', '검증'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{upload.rows.map(row => <tr key={row.lineNo}><td className="p-2">{row.sourceLineNo}</td><td>{row.supplier || '부품 주문(발주처 미정)'}</td><td>{row.productName}</td><td>{row.quantity}</td><td>{row.recipientName || '미확정'}</td><td>{row.reason ? String(row.reason) : '검증 완료'}</td></tr>)}</tbody></table></div></>}
    </article>)}
    {uploads.length ? <Button disabled={busy || uploads.some(file => file.error || !file.rows.length)} onClick={() => void save()}>센터 대기열에 저장</Button> : null}
    {!groups.length ? <p className="rounded-2xl border bg-white p-5 text-sm">센터 발주 대기열이 비어 있습니다.</p> : null}
    {groups.map(group => <article key={group.key} className="overflow-hidden rounded-2xl border bg-white">
      <div className="p-5"><h3 className="font-semibold">{group.supplier}</h3><p className="mt-2 text-sm">오늘 {group.deadline.label} (한국시간)</p>
        {group.alert ? <div role="alert" className="mt-3 rounded-lg bg-amber-50 p-3"><strong>센터 상품 미발주</strong><p className="my-2 text-sm">해당 회차의 업체 발주마감 30분 전입니다. 오늘 해당 회차의 제조사 발주서가 없고 대기 중인 센터 상품이 있습니다. 검증 보류 행은 수정본을 올려 주세요.</p><Button disabled={busy || !group.entries.some(entry => entry.state === 'WAITING' && entry.row.status === 'READY')} onClick={() => void makeJob(group.supplier, group.scheduleKey)}>센터 상품만 따로 주문 만들기</Button></div> : null}
        {!group.alert && group.deadline.channel && group.entries.some(entry => entry.state === 'WAITING' && entry.row.status === 'READY') ? <Button className="mt-3" variant="outline" disabled={busy} onClick={() => void makeJob(group.supplier, group.scheduleKey)}>센터 상품만 따로 주문 만들기</Button> : null}
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm">
        <thead className="bg-slate-50"><tr>{['품명', '센터', '수량', '수취인(센터명)', '원본 파일', '상태'].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead>
        <tbody>{group.entries.map(entry => <tr key={entry.id} className="border-t">
          <td className="p-3">{entry.row.productName}</td><td className="p-3">{entry.row.centerName || '미확정'}</td><td className="p-3">{entry.row.quantity}</td><td className="p-3">{entry.row.recipientName || '미확정'}</td>
          <td className="max-w-64 break-all p-3">{entry.row.sourceFile}<span className="block text-xs text-slate-500">{entry.row.sourceDate} · {entry.row.sourceSheet} · {entry.row.sourceLineNo}행</span></td>
          <td className="p-3">{stateLabel[entry.state] || entry.state}{entry.state === 'WAITING' && entry.row.status !== 'READY' ? ' · 검증 보류' : ''}{entry.state === 'WAITING' && group.deadline.label.startsWith('회차 확인 필요') ? ' · 회차 확인 필요(표에 없음)' : ''}
            {entry.jobId ? <button className="mt-1 block break-all text-xs text-emerald-800 underline" onClick={() => onOpenJob(entry.jobId!)}>{entry.jobId}</button> : null}
            {entry.row.reason ? <span className="mt-1 block text-xs text-amber-800">{String(entry.row.reason)}</span> : null}
            {entry.state === 'WAITING' && (entry.row.status !== 'READY' || group.deadline.label.startsWith('회차 확인 필요')) ? <Button className="mt-2" variant="outline" disabled={busy} onClick={() => void excludeHeld(entry.id)}>{group.deadline.label.startsWith('회차 확인 필요') ? '회차 미확정 항목 제외' : '보류 항목 제외'}</Button> : null}
          </td>
        </tr>)}</tbody>
      </table></div>
    </article>)}
  </section>;
}
