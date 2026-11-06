"""사람이 취합한 엑셀을 읽어 로컬 발주 준비물만 생성한다. 외부 연결·제출 기능 없음."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation
import html
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local-analysis'
SCHEDULE = ROOT / 'worker/order-runner/data/direct-delivery-schedule.json'
# 발주서 파일명 표기와 시간표 표기가 다른 업체만 등록한다.
FILE_VENDOR_ALIASES = {'THKC': 'THK'}
FIELDS = ('주문번호', '납품처', '납품처전화번호', '품명', '주문수량', '비고(내역)')
REQUIRED = FIELDS[:5]


def text(value):
    return '' if value is None else str(value).strip()


def prepare(rows, filename, schedules, vendor=None, mapping=None, now=None):
    """명시된 머리글만 처리. 업체별 한 행이라도 보류이면 해당 업체 준비물 전체 보류."""
    now = now or datetime.now(timezone(timedelta(hours=9)))
    known = {e['vendor'] for e in schedules}
    match = re.search(r'직배\s*\(([^()]+)\)', Path(filename).name)
    file_name = FILE_VENDOR_ALIASES.get(match.group(1), match.group(1)) if match else None
    file_vendor = file_name if file_name in known else None
    report = {'mode': 'DRY_RUN', 'submissionAllowed': False,
              'source': Path(filename).name, 'createdAt': now.isoformat(),
              'vendorEvidence': {'explicit': vendor, 'filename': file_vendor,
                                 'filenamePattern': match.group(1) if match else None},
              'issues': [], 'groups': [], 'heldRows': []}
    if vendor is not None and vendor not in known:
        report['issues'].append('명시 업체가 시간표에 없음')
        return report
    mapping = mapping or {f: f for f in (*FIELDS, '업체')}
    if not isinstance(mapping, dict) or any(f not in mapping for f in REQUIRED):
        report['issues'].append('필수 열 매핑 누락')
        return report
    if any(not isinstance(v, str) or not v for v in mapping.values()) or len(set(mapping.values())) != len(mapping):
        report['issues'].append('열 매핑은 서로 다른 머리글 문자열이어야 함')
        return report
    candidates = []
    for i, row in enumerate(rows):
        labels = [text(v) for v in row]
        if all(mapping[f] in labels for f in REQUIRED):
            candidates.append((i, labels))
    if len(candidates) != 1:
        report['issues'].append('공통 양식 머리글을 하나로 확정할 수 없음: 업체 양식은 명시적 매핑 필요')
        return report
    header_index, labels = candidates[0]
    wanted = set(mapping.values())
    if any(labels.count(label) > 1 for label in wanted):
        report['issues'].append('중복 머리글: 열을 확정할 수 없음')
        return report
    indexes = {f: labels.index(label) for f, label in mapping.items() if label in labels}
    grouped = defaultdict(list)
    for index, cells in enumerate(rows[header_index + 1:], header_index + 2):
        if not any(text(v) for v in cells):
            continue
        values = {f: text(cells[c]) if c < len(cells) else '' for f, c in indexes.items()}
        column_vendor = values.get('업체', '')
        selected = vendor or column_vendor or file_vendor
        reasons = []
        if not selected or selected not in known:
            reasons.append('업체 미확정 또는 시간표 미등록')
        if column_vendor and ((vendor and vendor != column_vendor) or
                              (file_vendor and file_vendor != column_vendor)):
            reasons.append('업체 열과 명시 업체/파일명 충돌')
        for f in REQUIRED:
            if not values.get(f):
                reasons.append(f'{f} 누락')
        if any(text(v).startswith(('=', '#REF!', '#VALUE!', '#N/A', '#DIV/0!')) for v in cells):
            reasons.append('수식 또는 오류 셀: 값으로 확정 필요')
        try:
            qty = Decimal(values.get('주문수량', ''))
            if not qty.is_finite() or qty <= 0 or qty != qty.to_integral_value():
                raise InvalidOperation
        except InvalidOperation:
            reasons.append('주문수량은 양의 정수여야 함')
        # 메모의 업무 의미를 자동 판정하지 않는다. 취합자가 확정한 값이므로 초안에 그대로 싣고 검토 표시만 한다.
        record = {'excelRow': index, 'vendor': selected, 'values': values,
                  'evidence': '명시 인자' if vendor else '업체 열' if column_vendor else '파일명',
                  'reasons': reasons, 'reviewNote': bool(values.get('비고(내역)'))}
        grouped[selected or '미확정'].append(record)
    for name, records in grouped.items():
        entries = [e for e in schedules if e['vendor'] == name]
        seen = Counter(tuple(r['values'].get(f, '') for f in REQUIRED[:-1]) for r in records)
        for record in records:
            if seen[tuple(record['values'].get(f, '') for f in REQUIRED[:-1])] > 1:
                record['reasons'].append('동일 주문·납품처·품목·수량 중복: 수정본 여부 확인')
        issues = []
        if not entries or any(not e.get('orderDeadline') for e in entries):
            issues.append('발주 마감 미확정')
        if any(e.get('note') and '별도 양식' in e['note'] for e in entries):
            issues.append('업체 별도 출력 양식 확인 필요')
        held = bool(issues or any(r['reasons'] for r in records))
        group = {'vendor': name, 'status': 'HOLD' if held else 'PREPARED_DRY_RUN',
                 'issues': issues, 'schedule': entries, 'rows': records,
                 'rowsWithNotes': sum(r['reviewNote'] for r in records),
                 'notice': '시간표 참고용. 공휴일·회차·접수 여부는 사람이 확인. 실제 제출 승인 아님.'}
        report['groups'].append(group)
        report['heldRows'].extend(r for r in records if r['reasons'])
    if not grouped:
        report['issues'].append('발주 행 없음')
    return report


def read_workbook(path, sheet):
    if path.suffix.lower() != '.xlsx':
        raise ValueError('현재 .xlsx만 지원. 원본을 보존하고 별도 .xlsx로 저장해 주세요')
    import openpyxl
    book = openpyxl.load_workbook(path, read_only=False, data_only=False, keep_links=False)
    try:
        if sheet is None:
            if len(book.sheetnames) != 1:
                raise ValueError('여러 시트: --sheet로 처리할 시트를 명시하세요')
            sheet = book.sheetnames[0]
        if sheet not in book.sheetnames:
            raise ValueError('지정한 시트가 없음')
        ws = book[sheet]
        if ws.sheet_state != 'visible':
            raise ValueError('숨김 시트는 처리할 수 없음')
        if any(dim.hidden for dim in ws.row_dimensions.values()):
            raise ValueError('숨김 행이 있음: 발주 대상 행을 별도 시트에 확정해 주세요')
        if any(dim.hidden for dim in ws.column_dimensions.values()):
            raise ValueError('숨김 열이 있음: 발주 대상 열을 별도 시트에 확정해 주세요')
        return list(ws.iter_rows(values_only=True)), sheet
    finally:
        book.close()


def write_bundle(report, output):
    output = Path(output).resolve()
    if not output.is_relative_to(LOCAL.resolve()) or output == LOCAL.resolve():
        raise ValueError('결과는 프로젝트 .local-analysis 하위 새 폴더에만 저장 가능')
    output.mkdir(parents=True, exist_ok=False)
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    for number, group in enumerate(report['groups'], 1):
        if group['status'] == 'HOLD':
            continue
        folder = output / f'vendor-{number:03}'
        folder.mkdir()
        lines = ['[드라이런 / 미발송 / 담당자 최종 확인 필요]', group['vendor']]
        lines.extend(json.dumps(r['values'], ensure_ascii=False) for r in group['rows'])
        body = '\n'.join(lines)
        methods = {s['method'] for s in group['schedule']}
        if '이메일' in methods:
            (folder / 'email-draft.txt').write_text('받는 사람: [로컬에서 확인]\n제목: 발주 검토 초안\n' + body, encoding='utf-8')
        if methods & {'카톡', '카톡친구'}:
            (folder / 'kakao-draft.txt').write_text(body, encoding='utf-8')
        if '팩스' in methods:
            (folder / 'fax-print.html').write_text('<!doctype html><meta charset="utf-8"><title>미발송 팩스 검토본</title><pre style="white-space:pre-wrap">' + html.escape(body) + '</pre>', encoding='utf-8')
        if methods & {'B2B몰', 'ERP'}:
            payload = {'mode': 'DRY_RUN', 'vendor': group['vendor'], 'rows': group['rows'],
                       'manualChecks': ['상품·옵션 일치', 'ERP 품목코드/B2B 상품 매핑', '납품처와 연락처', '가격·배송비', '제출 전 기존 승인 절차']}
            (folder / 'input-values.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--sheet')
    parser.add_argument('--vendor')
    parser.add_argument('--mapping', type=Path, help='표준 필드명→엑셀 머리글 JSON')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    schedules = json.loads(SCHEDULE.read_text(encoding='utf-8'))['schedule']
    try:
        rows, sheet = read_workbook(args.input, args.sheet)
        mapping = json.loads(args.mapping.read_text(encoding='utf-8')) if args.mapping else None
        report = prepare(rows, args.input.name, schedules, args.vendor, mapping)
        report['sheet'] = sheet
    except (ValueError, OSError) as exc:
        report = {'mode': 'DRY_RUN', 'submissionAllowed': False, 'issues': [str(exc)], 'groups': []}
    write_bundle(report, args.output)
    held = bool(report['issues'] or any(g['status'] == 'HOLD' for g in report['groups']))
    print('보류 항목 있음: 로컬 report.json 확인' if held else '드라이런 준비물 생성 완료: 실제 제출 없음')
    return 2 if held else 0


if __name__ == '__main__':
    raise SystemExit(main())
