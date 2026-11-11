// 화면과 워커가 공유하는 시트 선택 규칙. 파일·네트워크 접근 없음.
const headerNames = new Set(['주문일자', '주문번호', '납품처', '납품처전화번호', '품명', '주문수량', '비고(내역)', '업체',
  'order_id', 'category', 'product_name', 'quantity', 'recipient_name', 'recipient_phone', 'address', 'source_system']);
export function inspectWorkbook(workbook, filename) {
  return { filename, sheets: workbook.worksheets.map(sheet => {
    let headers = [];
    sheet.eachRow(row => {
      const labels = Array.from({ length: sheet.columnCount }, (_, i) => row.getCell(i + 1).text.trim())
        .filter(value => headerNames.has(value));
      if (labels.length > headers.length) headers = labels;
    });
    return { name: sheet.name, state: sheet.state || 'visible', rowCount: sheet.actualRowCount, headers: [...new Set(headers)] };
  }) };
}

export function selectWorksheet(workbook, selectedSheet) {
  const visible = workbook.worksheets.filter(sheet => !sheet.state || sheet.state === 'visible');
  if (!visible.length) throw new Error('보이는 시트가 없습니다. 발주 대상을 확인해 주세요.');
  if (!selectedSheet && visible.length > 1) throw new Error('여러 시트: 사람이 처리할 시트를 선택해야 합니다.');
  const sheet = selectedSheet ? visible.find(sheet => sheet.name === selectedSheet) : visible[0];
  if (!sheet) throw new Error('선택한 시트가 파일에 없거나 숨김 상태입니다. 다시 선택해 주세요.');
  return sheet;
}

export function worksheetMatrix(sheet) {
  return Array.from({ length: sheet.rowCount }, (_, row) =>
    Array.from({ length: sheet.columnCount }, (_, col) => sheet.getRow(row + 1).getCell(col + 1).text));
}

export function workbookProblem(job) {
  const source = job?.sourceWorkbook;
  if (!source || typeof job.filename !== 'string' || !job.filename || source.filename !== job.filename || !Array.isArray(source.sheets) || !source.sheets.length)
    return '파일의 시트 정보가 없습니다. 엑셀을 다시 업로드하고 처리 시트를 확인해 주세요.';
  if (source.sheets.some(sheet => !sheet || typeof sheet.name !== 'string' || !sheet.name ||
      !['visible', 'hidden', 'veryHidden'].includes(sheet.state)) ||
      new Set(source.sheets.map(sheet => sheet.name)).size !== source.sheets.length)
    return '파일의 시트 목록이 올바르지 않습니다. 다시 업로드해 주세요.';
  if (typeof job.selectedSheet !== 'string' || !job.selectedSheet)
    return '처리 시트가 선택되지 않았습니다. 사람이 시트를 확인해야 합니다.';
  if (!source.sheets.some(sheet => sheet.name === job.selectedSheet && sheet.state === 'visible'))
    return '선택한 시트가 파일에 없거나 숨김 상태입니다. 다시 업로드해 주세요.';
  if (!Array.isArray(job.rows) || !job.rows.length || job.rows.some(row => row.sourceSheet !== job.selectedSheet))
    return '주문 행의 출처 시트와 선택한 시트가 다릅니다. 다시 업로드해 주세요.';
  return null;
}

export function orderFileDate(job) {
  const name = job.filename || '';
  const shortDate = /(?:^|\D)(\d{6})(?:\D|$)/.exec(name)?.[1];
  return String(job.sourceDate || '').replaceAll('-', '') || /(?:^|\D)(20\d{6})(?:\D|$)/.exec(name)?.[1] ||
    /(?:^|\D)(20\d{2})[-_.](\d{2})[-_.](\d{2})(?:\D|$)/.exec(name)?.slice(1).join('') ||
    (shortDate ? '20' + shortDate : '');
}

const vendorName = value => /^(THK|THKC|이로움|eroum)$/i.test(value || '') ? '이로움' : value;
const fileVendor = job => vendorName(job.sourceSystem || /직배\s*\(([^()]+)\)/.exec(job.filename || '')?.[1] ||
  (/보필/.test(job.filename || '') ? '보필' : ''));
export function duplicateOrderFiles(candidate, jobs) {
  const date = orderFileDate(candidate), vendor = fileVendor(candidate);
  if (!date || !vendor || vendor === '미지정') return [];
  return jobs.filter(job => (candidate.id === undefined || job.id !== candidate.id) && orderFileDate(job) === date && fileVendor(job) === vendor);
}
