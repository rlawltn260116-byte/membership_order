// 센터 대기열의 순수 상태 전이. 저장소 어댑터는 jobs와 center-queue의 공통 부모에서 트랜잭션한다.
import suppliers from './data/supplier-map.json' with { type: 'json' };
import { deliverySchedule, normalizeChannelName } from './schedule.mjs';
import { classifyOrderRow, PARTS_ORDER_KIND, PARTS_ORDER_LABEL } from './order-classification.mjs';
import { analyzeDestination, centerOrderContext } from './b2b-destination.mjs';
import { workbookProblem, worksheetMatrix } from './workbook-policy.mjs';
import { entryForJob, manualDonePatch, manualDoneUndoPatch, vendorAction } from './vendor-board.mjs';

const norm = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
export const koreaDay = (now = new Date()) => new Date(new Date(now).getTime() + 9 * 3600000).toISOString().slice(0, 10);
export function supplierChannel(supplier) {
  const vendors = [...new Set(suppliers.records.filter(row => row.supplier === supplier).map(row => row.scheduleVendor))];
  const vendor = vendors.length === 1 && vendors[0] !== '미정' ? vendors[0] : supplier;
  const channel = normalizeChannelName(vendor);
  return deliverySchedule.some(entry => entry.channel === channel) ? channel : null;
}
const channelFor = value => supplierChannel(value) || normalizeChannelName(value);
export function centerDeadline(supplier, now = new Date()) {
  const channel = supplierChannel(supplier);
  const entries = deliverySchedule.filter(entry => entry.channel === channel && entry.receiptDeadline).sort((a, b) => a.receiptDeadline.localeCompare(b.receiptDeadline));
  if (!entries.length) return { channel: null, label: '발주 시각·방식 미정', alert: false };
  const first = entries[0];
  const at = new Date(`${koreaDay(now)}T${first.receiptDeadline}:00+09:00`);
  return { channel, label: entries.map(entry => `${entry.round ? entry.round + ' ' : ''}${entry.receiptDeadline} 접수마감`).join(' / '),
    receiptDeadlineAt: at.toISOString(), alertAt: new Date(at.getTime() - 30 * 60000).toISOString(),
    alert: new Date(now).getTime() >= at.getTime() - 30 * 60000 && ![0, 6].includes(new Date(`${koreaDay(now)}T00:00:00Z`).getUTCDay()) };
}

// 품명 전체로 먼저 분류하며 부품의 본체 모델을 추정하지 않는다.
export function parseCenterSheet(sheet, { filename, sourceDate, sourceWorkbook }) {
  const matrix = worksheetMatrix(sheet);
  const columns = ['주문번호', '납품처', '납품처전화번호', '품명', '주문수량', '비고(내역)'];
  let mapping;
  const rows = [];
  matrix.forEach((cells, index) => {
    const headers = cells.map(value => norm(value).replace(/\s/g, ''));
    if (columns.every(name => headers.includes(name))) { mapping = Object.fromEntries(columns.map(name => [name, headers.indexOf(name)])); return; }
    if (!mapping) return;
    const value = name => String(cells[mapping[name]] ?? '');
    if (!columns.some(name => norm(value(name)))) return;
    const product = norm(value('품명'));
    let classification = classifyOrderRow({ productName: product });
    let productName = product, option = '';
    const parts = product.split(/\s+\/\s+/);
    if (classification.partsOrder && parts.length === 2 && !/부품|캡|발걸이|쿠션/.test(product)) {
      const base = classifyOrderRow({ productName: parts[0] });
      if (!base.partsOrder) { classification = base; productName = parts[0]; option = parts[1]; }
    }
    const channel = supplierChannel(classification.supplier);
    const memo = value('비고(내역)');
    const context = centerOrderContext({ filename, memo });
    const destination = value('납품처');
    const analysis = analyzeDestination(destination, channel === '보필' ? 'bofeel' : 'eroum', { filename, memo });
    const quantity = norm(value('주문수량'));
    const reasons = [classification.partsOrder ? PARTS_ORDER_LABEL : '', !context.centerOrder ? '파일명·비고에서 센터를 확인해야 합니다.' : '',
      analysis.reason, !/^[1-9]\d*$/.test(quantity) || !Number.isSafeInteger(Number(quantity)) ? '수량은 양의 정수여야 합니다.' : '',
      !/^\d{9,11}$/.test(norm(value('납품처전화번호')).replace(/[\s-]/g, '')) ? '수취인 연락처 형식 확인 필요' : ''].filter(Boolean);
    rows.push({ ...classification, ...context, centerOrder: true, sourceFile: filename, sourceDate: sourceDate.replaceAll('-', ''),
      sourceSheet: sheet.name, sourceLineNo: index + 1, lineNo: index + 1, sourceWorkbook, selectedSheet: sheet.name,
      sourceSystem: channel || classification.supplier || PARTS_ORDER_LABEL, orderId: norm(value('주문번호')), category: '급여판매',
      productName, option, quantity, expectedPrice: '', customerName: classification.supplier, destination,
      recipientName: analysis.name, recipientSource: analysis.recipientSource, normalizationNotes: analysis.normalizationNotes,
      recipientPhone: norm(value('납품처전화번호')), address: analysis.address, addressDetail: '', zipcode: '', memo,
      status: reasons.length ? 'HOLD' : 'READY', reason: reasons.join('; ') });
  });
  if (!rows.length) throw new Error('센터 공통 양식의 주문 행을 찾지 못했습니다. 필수 열 6개를 확인해 주세요.');
  if (rows.length > 5000) throw new Error('한 파일에서 처리할 수 있는 주문은 최대 5,000건입니다.');
  return rows;
}

export async function prepareCenterEntries(rows, now = new Date()) {
  return Promise.all(rows.map(async row => {
    if (workbookProblem({ filename: row.sourceFile, selectedSheet: row.selectedSheet, sourceWorkbook: row.sourceWorkbook, rows: [row] })) throw new Error('센터 원본 시트 출처를 확인해 주세요.');
    const date = String(row.sourceDate || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^20\d{6}$/.test(row.sourceDate || '') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || !Number.isSafeInteger(row.sourceLineNo) || row.sourceLineNo < 1) throw new Error('원본 날짜·행 번호를 확인해 주세요.');
    const key = JSON.stringify(['center-row-v1', norm(row.sourceFile), row.sourceDate, row.sourceSheet, row.sourceLineNo,
      norm(row.destination), norm(row.productName), norm(row.option), Number.isFinite(Number(row.quantity)) ? Number(row.quantity) : norm(row.quantity)]);
    const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return { id: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''), supplier: row.supplier || PARTS_ORDER_LABEL,
      channel: supplierChannel(row.supplier), state: row.orderKind === PARTS_ORDER_KIND ? 'UNASSIGNED' : 'WAITING',
      row, uploadedAt: new Date(now).toISOString(), uploadedDay: koreaDay(now) };
  }));
}

const queue = root => root['center-queue'] ??= { entries: {}, firstJobs: {} };
const entries = root => queue(root).entries ??= {};
const jobs = root => root.jobs ??= {};
const firstJobs = root => queue(root).firstJobs ??= {};
const dayKey = (day, channel) => `${day}_${encodeURIComponent(channel).replaceAll('.', '%2E')}`;
const isManufacturer = job => job.orderKind !== PARTS_ORDER_KIND && job.orderOrigin !== 'CENTER_ONLY';
function firstManufacturer(root, channel, day) {
  return firstJobs(root)[dayKey(day, channel)] || Object.entries(jobs(root)).find(([, job]) =>
    isManufacturer(job) && job.createdAt && koreaDay(job.createdAt) === day && channelFor(job.sourceSystem) === channel)?.[0];
}
function summarize(job) {
  job.totalRows = job.rows.length;
  job.readyRows = job.rows.filter(row => row.status === 'READY').length;
  job.holdRows = job.rows.filter(row => row.status === 'HOLD').length;
  job.failedRows = job.rows.filter(row => row.status === 'FAILED').length;
}
function invalidate(job, now) {
  if (job.report) job.lastReport = job.report;
  job.report = null; job.submission = null; job.scheduledPreparation = null;
  job.dashboardApproval = null;
  job.dashboardReview = { state: 'QUEUED', required: true, finalSubmissionApproved: false, updatedAt: now };
  job.executionMode = 'PREPARE';
  job.status = job.rows.some(row => row.status !== 'READY') ? 'HOLD' : 'READY';
  summarize(job);
}
function reserve(root, job, channel, now, supplier) {
  let line = Math.max(0, ...(job.rows || []).map(row => Number(row.lineNo) || 0));
  for (const entry of Object.values(entries(root))) {
    if (entry.state !== 'WAITING' || entry.row.status !== 'READY' || entry.channel !== channel ||
        (supplier && entry.supplier !== supplier) || entry.uploadedDay > koreaDay(now)) continue;
    entry.state = 'RESERVED'; entry.jobId = job.id; entry.reservedAt = now;
    job.rows.push({ ...entry.row, lineNo: ++line, centerQueueId: entry.id, sourceSystem: channel });
  }
  summarize(job);
  if (job.holdRows || job.failedRows) job.status = job.failedRows ? 'FAILED' : 'HOLD';
}
export function uploadCenterEntries(root, prepared, partsJobId, now) {
  const addedParts = [];
  for (const entry of prepared) {
    const existing = entries(root)[entry.id];
    if (existing) {
      // 아직 예약하지 않은 검증 보류 행만 같은 키의 수정본으로 교체한다.
      // 예약·완료·검증 완료 행은 재업로드로 내용을 바꾸거나 재주문하지 않는다.
      if ((existing.state === 'WAITING' || (existing.state === 'EXCLUDED' && entry.row.status === 'READY')) && existing.row.status !== 'READY' && entry.state === 'WAITING')
        entries(root)[entry.id] = { ...entry, replacedAt: now };
      continue;
    }
    entries(root)[entry.id] = entry;
    if (entry.state === 'UNASSIGNED') addedParts.push(entry.row);
  }
  if (addedParts.length) {
    const row = addedParts[0];
    // 출처 검사는 각 센터 행의 파일·시트 목록으로 수행한다.
    jobs(root)[partsJobId] = { id: partsJobId, filename: row.sourceFile, selectedSheet: row.selectedSheet, sourceWorkbook: row.sourceWorkbook,
      sourceSystem: PARTS_ORDER_LABEL, orderKind: PARTS_ORDER_KIND, status: 'HOLD', rows: addedParts,
      createdAt: now, updatedAt: now, createdByName: '주문 운영자', updatedByName: '주문 운영자', createdByEmail: '', updatedByEmail: '' };
    summarize(jobs(root)[partsJobId]);
  }
  return root;
}
export function createJobWithCenters(root, id, input, now) {
  if (jobs(root)[id]) throw new Error('이미 저장한 작업입니다. 목록을 새로 불러오세요.');
  const job = { ...input, id, rows: [...(input.rows || [])], createdAt: now, updatedAt: now };
  const channel = supplierChannel(job.sourceSystem);
  if (channel && isManufacturer(job)) {
    const day = koreaDay(now);
    const first = firstManufacturer(root, channel, day);
    if (!first) {
      firstJobs(root)[dayKey(day, channel)] = id; reserve(root, job, channel, now);
      if (['HOLD', 'FAILED'].includes(job.status)) {
        release(root, job, job.rows.filter(row => row.centerQueueId).map(row => row.centerQueueId));
        job.status = job.failedRows ? 'FAILED' : job.holdRows ? 'HOLD' : 'READY';
      }
    }
  }
  jobs(root)[id] = job;
  return root;
}
export function createCenterOnlyJob(root, id, supplier, now) {
  if (jobs(root)[id]) throw new Error('이미 저장한 작업입니다. 목록을 새로 불러오세요.');
  const channel = supplierChannel(supplier);
  if (!channel) throw new Error('발주 시각·방식 미정 업체입니다. 시간표를 먼저 확인해 주세요.');
  const pending = Object.values(entries(root)).filter(entry => entry.state === 'WAITING' && entry.row.status === 'READY' && entry.supplier === supplier && entry.uploadedDay <= koreaDay(now));
  if (!pending.length) throw new Error('검증 완료된 대기 센터 상품이 없습니다. 보류 사유를 확인해 주세요.');
  const row = pending[0].row;
  const job = { id, orderOrigin: 'CENTER_ONLY', orderKind: 'STANDARD', filename: row.sourceFile, selectedSheet: row.selectedSheet,
    sourceWorkbook: row.sourceWorkbook, sourceSystem: channel, status: 'READY', rows: [], createdAt: now, updatedAt: now,
    createdByName: '주문 운영자', updatedByName: '주문 운영자', createdByEmail: '', updatedByEmail: '' };
  reserve(root, job, channel, now, supplier);
  jobs(root)[id] = job;
  return root;
}
const uncertain = job => Object.values(job.submission?.rows || {}).some(row => ['SUBMITTING', 'UNKNOWN', 'SUBMITTED'].includes(row?.state)) ||
  job.report?.details?.some(row => row?.orderNumber || ['SUBMITTING', 'UNKNOWN', 'SUBMITTED'].includes(row?.submissionState));
function release(root, job, ids) {
  for (const id of ids) {
    const entry = entries(root)[id];
    if (!entry || entry.state !== 'RESERVED' || entry.jobId !== job.id) throw new Error('센터 예약이 작업과 다릅니다. 새로 불러오세요.');
    entry.state = 'WAITING'; delete entry.jobId; delete entry.reservedAt;
  }
  job.rows = job.rows.filter(row => !ids.includes(row.centerQueueId));
  summarize(job);
}
export function centerReservationProblem(root, job, expectedState = 'RESERVED') {
  const seen = new Set();
  const sourceSignature = source => JSON.stringify([source?.filename, (source?.sheets || []).map(sheet => [sheet?.name, sheet?.state])]);
  for (const row of job.rows || []) {
    if (!row.centerQueueId) continue;
    if (seen.has(row.centerQueueId)) return '같은 센터 상품이 작업에 중복되어 있습니다.';
    seen.add(row.centerQueueId);
    const entry = entries(root)[row.centerQueueId];
    if (!entry || entry.state !== expectedState || entry.jobId !== job.id || entry.channel !== channelFor(job.sourceSystem)) return '센터 상품 예약이 현재 작업과 일치하지 않습니다.';
    // 준비 중 우편번호 보완 이외에 센터 원본을 바꾸어 실행하지 않는다.
    for (const key of ['sourceFile', 'sourceDate', 'sourceSheet', 'sourceLineNo', 'selectedSheet', 'productName', 'option', 'quantity', 'destination', 'recipientName', 'recipientPhone', 'address', 'addressDetail', 'zipcode', 'memo']) {
      if (String(row[key] ?? '') !== String(entry.row[key] ?? '')) return '센터 예약 원본과 작업 행이 다릅니다.';
    }
    if (sourceSignature(row.sourceWorkbook) !== sourceSignature(entry.row.sourceWorkbook)) return '센터 예약의 시트 목록이 다릅니다.';
  }
  if (Object.values(entries(root)).some(entry => entry.state === expectedState && entry.jobId === job.id && !job.rows?.some(row => row.centerQueueId === entry.id))) return '예약된 센터 상품이 작업에서 누락되었습니다.';
  return null;
}
export function updateJobWithCenters(root, id, patch, now, worker = false) {
  const current = jobs(root)[id];
  if (!current) throw new Error('작업이 없습니다.');
  if (!worker && (current.status === 'RUNNING' || current.status === 'SUBMIT_QUEUED')) throw new Error('실행 중인 작업은 변경할 수 없습니다.');
  const job = { ...current, rows: [...(current.rows || [])] };
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.split('/'); let target = job;
    for (const key of keys.slice(0, -1)) target = target[key] = { ...(target[key] || {}) };
    target[keys.at(-1)] = value;
  }
  const ids = (current.rows || []).filter(row => row.centerQueueId).map(row => row.centerQueueId);
  const manualDone = ids.length && job.status === 'COMPLETED' && !current.vendorOrderDone?.doneAt && patch.vendorOrderDone?.doneAt;
  const manualUndo = ids.length && current.status === 'COMPLETED' && current.vendorOrderDone?.doneAt && patch.vendorOrderDone === null;
  if (manualDone || manualUndo) {
    const entry = entryForJob(current);
    if (worker || !vendorAction(entry)?.manualDone || channelFor(current.sourceSystem) !== entry?.channel || uncertain(current) || uncertain(job))
      throw new Error('이 작업은 수동 완료 표시로 센터 상태를 바꿀 수 없습니다.');
    // 완료 표시와 취소는 주문 내용을 함께 변경하는 통로가 아니다.
    const sourceFields = ['filename', 'sourceSystem', 'scheduleKey', 'selectedSheet', 'sourceDate'];
    if (sourceFields.some(key => String(current[key] ?? '') !== String(job[key] ?? '')) ||
        JSON.stringify(current.rows) !== JSON.stringify(job.rows) || JSON.stringify(current.sourceWorkbook) !== JSON.stringify(job.sourceWorkbook))
      throw new Error('수동 완료 표시·취소와 주문 내용 변경은 함께 할 수 없습니다.');
    if (manualDone) {
      const at = new Date(job.vendorOrderDone.doneAt);
      if (!Number.isFinite(at.getTime()) || !norm(job.vendorOrderDone.doneByName)) throw new Error('수동 발주 완료 시각·담당자 정보가 없습니다.');
      const expected = manualDonePatch(current, at, job.vendorOrderDone.doneByName).vendorOrderDone;
      if (['doneAt', 'doneByName', 'method', 'scheduleKey', 'previousStatus'].some(key => expected[key] !== job.vendorOrderDone[key]))
        throw new Error('수동 발주 완료 정보가 업체·회차·이전 상태와 다릅니다.');
    } else {
      const expected = manualDoneUndoPatch(current, new Date(now));
      if (job.status !== expected.status || ids.some(id => entries(root)[id]?.completedVia !== 'MANUAL'))
        throw new Error('사람이 완료 표시한 센터 작업만 이전 상태로 되돌릴 수 있습니다.');
    }
  }
  const reservationProblem = centerReservationProblem(root, job, manualUndo ? 'COMPLETED' : 'RESERVED');
  if (reservationProblem) throw new Error(reservationProblem);
  if (manualUndo) {
    for (const key of ids) {
      const entry = entries(root)[key]; entry.state = 'RESERVED';
      delete entry.completedAt; delete entry.completedVia;
    }
  } else if (manualDone) {
    for (const key of ids) { entries(root)[key].state = 'COMPLETED'; entries(root)[key].completedAt = job.vendorOrderDone.doneAt; entries(root)[key].completedVia = 'MANUAL'; }
  } else if (ids.length && job.status === 'COMPLETED') {
    if (job.executionMode !== 'SUBMIT' || job.report?.submittedRows !== job.rows.length ||
        job.report?.details?.length !== job.rows.length || new Set(job.report.details.map(row => row.lineNo)).size !== job.rows.length ||
        job.report.details.some(row => !job.rows.some(source => source.lineNo === row.lineNo) || row.status !== 'READY' || !row.orderNumber || !Number.isFinite(Date.parse(row.submittedAt)))) throw new Error('센터 발주 완료의 실제 제출 결과가 없습니다.');
    for (const key of ids) { entries(root)[key].state = 'COMPLETED'; entries(root)[key].completedAt = now; entries(root)[key].completedVia = 'SUBMIT'; }
  } else if (ids.length && ['HOLD', 'FAILED'].includes(job.status) && !uncertain(job)) {
    release(root, job, ids);
    // 보류·실패의 이력은 보존하되 이전 보고와 승인을 재사용하지 않는다.
    if (job.report) job.lastReport = job.report;
    job.report = null; job.dashboardReview = { state: 'ON_HOLD', required: true, finalSubmissionApproved: false, updatedAt: now };
    job.dashboardApproval = null; job.scheduledPreparation = null; job.executionMode = 'PREPARE';
  }
  jobs(root)[id] = job;
  return root;
}
export function removeCenterRow(root, id, centerId, now) {
  const job = jobs(root)[id];
  if (!job || !['READY', 'HOLD', 'FAILED', 'AWAITING_REVIEW', 'REVIEWED'].includes(job.status) || uncertain(job)) throw new Error('실행 중이거나 제출 이력이 있는 작업에서 센터 상품을 뺄 수 없습니다.');
  if (!(job.rows || []).some(row => row.centerQueueId === centerId)) throw new Error('해당 센터 상품이 작업에 없습니다.');
  release(root, job, [centerId]); invalidate(job, now); job.updatedAt = now;
  return root;
}
export function excludeHeldCenterEntry(root, id, now) {
  const entry = entries(root)[id];
  if (!entry || entry.state !== 'WAITING' || entry.row.status === 'READY' || entry.jobId) throw new Error('예약 전 검증 보류 센터 상품만 제외할 수 있습니다.');
  entry.state = 'EXCLUDED'; entry.excludedAt = now;
  return root;
}
export function deleteJobWithCenters(root, id) {
  const job = jobs(root)[id];
  if (!job) return root;
  if (['RUNNING', 'SUBMIT_QUEUED', 'COMPLETED'].includes(job.status) || uncertain(job)) throw new Error('실행·완료·제출 확인이 필요한 작업은 삭제할 수 없습니다.');
  release(root, job, (job.rows || []).filter(row => row.centerQueueId).map(row => row.centerQueueId));
  // 삭제해도 그날 첫 제조사 작업 이력을 유지한다.
  const channel = supplierChannel(job.sourceSystem);
  if (channel && isManufacturer(job)) firstJobs(root)[dayKey(koreaDay(job.createdAt), channel)] ||= id;
  delete jobs(root)[id];
  return root;
}
export function centerQueueGroups(root, now = new Date()) {
  const groups = new Map();
  for (const entry of Object.values(root?.['center-queue']?.entries || {})) {
    if (!groups.has(entry.supplier)) {
      const deadline = centerDeadline(entry.supplier, now);
      groups.set(entry.supplier, { supplier: entry.supplier, deadline, entries: [], alert: false });
    }
    groups.get(entry.supplier).entries.push(entry);
  }
  for (const group of groups.values()) group.alert = group.deadline.alert && group.entries.some(entry => entry.state === 'WAITING') &&
    !firstManufacturer(root, group.deadline.channel, koreaDay(now));
  return [...groups.values()].sort((a, b) => a.supplier.localeCompare(b.supplier, 'ko'));
}
