"""실제 업무 자료 없이 발주 준비/보류 경계를 검사한다."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from xml.sax.saxutils import escape
import zipfile

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare_direct_orders.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def fixture(path, sheets):
    """모의 OOXML fixture. 업무 파일이나 고객정보를 사용하지 않는다."""
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + ''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, len(sheets)+1)) + '</Types>')
        z.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + ''.join(f'<sheet name="{name}" sheetId="{i}" r:id="rId{i}"/>' for i, name in enumerate(sheets, 1)) + '</sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets)+1)) + '</Relationships>')
        for i, rows in enumerate(sheets.values(), 1):
            xml = ''.join('<row r="%d">%s</row>' % (n, ''.join(f'<c r="{chr(65+j)}{n}" t="inlineStr"><is><t>{escape(str(v))}</t></is></c>' for j, v in enumerate(row))) for n, row in enumerate(rows, 1))
            z.writestr(f'xl/worksheets/sheet{i}.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + xml + '</sheetData></worksheet>')


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.schedule = json.loads(p.SCHEDULE.read_text(encoding='utf-8'))['schedule']
        self.header = list(p.FIELDS)
        self.row = ['TEST-1', '모의 납품처', '모의 연락처', '모의 품목', '2', '']

    def run_rows(self, rows=None, filename='20261007_직배(미키코리아) 발주서.xlsx', **kw):
        return p.prepare(rows or [self.header, self.row], filename, self.schedule, **kw)

    def test_filename_evidence_and_exact_match(self):
        r = self.run_rows()
        self.assertEqual(r['groups'][0]['status'], 'PREPARED_DRY_RUN')
        self.assertEqual(r['groups'][0]['rows'][0]['evidence'], '파일명')
        self.assertEqual(self.run_rows(filename='직배(미키).xlsx')['groups'][0]['status'], 'HOLD')
        self.assertEqual(self.run_rows(filename='직배 (미키코리아).xlsx')['groups'][0]['status'], 'PREPARED_DRY_RUN')

    def test_explicit_priority_and_conflicts(self):
        self.assertEqual(self.run_rows(vendor='보필')['groups'][0]['vendor'], '보필')
        rows = [self.header + ['업체'], self.row + ['보필']]
        self.assertEqual(self.run_rows(rows)['groups'][0]['status'], 'HOLD')
        self.assertEqual(self.run_rows(rows, filename='입력.xlsx', vendor='세비앙')['groups'][0]['status'], 'HOLD')

    def test_multi_vendor_split_and_all_methods(self):
        names = ['보필', '세비앙', '나이스텍', '유광정밀', '미키코리아']
        rows = [self.header + ['업체']] + [[f'TEST-{i}', *self.row[1:], name] for i, name in enumerate(names)]
        r = self.run_rows(rows, filename='입력.xlsx')
        with tempfile.TemporaryDirectory(dir=p.LOCAL) as tmp:
            output = Path(tmp) / '결과'
            p.write_bundle(r, output)
            files = {f.name for f in output.rglob('*') if f.is_file()}
            self.assertTrue({'report.json', 'input-values.json', 'email-draft.txt', 'fax-print.html', 'kakao-draft.txt'} <= files)
            self.assertFalse(r['submissionAllowed'])

    def test_invalid_quantity_notes_formula_duplicates(self):
        for value in ['0', '-1', '1.5', 'NaN', 'Infinity', '=1+1']:
            row = self.row.copy()
            row[4] = value
            self.assertEqual(self.run_rows([self.header, row])['groups'][0]['status'], 'HOLD')
        self.assertEqual(self.run_rows([self.header, self.row, self.row])['groups'][0]['status'], 'HOLD')

    def test_note_is_kept_for_review_without_blocking(self):
        row = self.row.copy()
        row[5] = '모의 비고'
        group = self.run_rows([self.header, row])['groups'][0]
        self.assertEqual(group['status'], 'PREPARED_DRY_RUN')
        self.assertEqual(group['rowsWithNotes'], 1)
        self.assertEqual(group['rows'][0]['values']['비고(내역)'], '모의 비고')

    def test_thkc_filename_maps_to_schedule_vendor(self):
        group = self.run_rows(filename='20261007_직배(THKC)_오전 발주서.xlsx')['groups'][0]
        self.assertEqual((group['vendor'], group['status']), ('THK', 'PREPARED_DRY_RUN'))

    def test_unmapped_form_unknown_vendor_special_form(self):
        self.assertTrue(self.run_rows([['특수양식'], ['내용']])['issues'])
        self.assertEqual(self.run_rows(vendor='현대메딕스')['groups'][0]['status'], 'HOLD')
        self.assertTrue(self.run_rows(vendor='없는업체')['issues'])

    def test_updated_chat_vendors_prepare_dry_run(self):
        for vendor in ('그레이스케일', '엘에스케이화인텍스', '보림제작소'):
            with self.subTest(vendor=vendor):
                self.assertEqual(self.run_rows(vendor=vendor)['groups'][0]['status'], 'PREPARED_DRY_RUN')

    def test_mapping_and_missing_header(self):
        mapping = {f: f'열{i}' for i, f in enumerate(p.FIELDS)}
        self.assertEqual(self.run_rows([list(mapping.values()), self.row], mapping=mapping)['groups'][0]['status'], 'PREPARED_DRY_RUN')
        self.assertTrue(self.run_rows([self.header[:-2], self.row])['issues'])
        self.assertTrue(self.run_rows(mapping={f: '같은열' for f in p.FIELDS})['issues'])

    def test_changed_quantity_same_order_is_held(self):
        changed = self.row.copy()
        changed[4] = '3'
        self.assertEqual(self.run_rows([self.header, self.row, changed])['groups'][0]['status'], 'HOLD')

    def test_printable_html_escapes_input(self):
        row = self.row.copy()
        row[3] = '<script>모의</script>'
        r = self.run_rows([self.header, row], vendor='유광정밀')
        with tempfile.TemporaryDirectory(dir=p.LOCAL) as tmp:
            out = Path(tmp) / 'result'
            p.write_bundle(r, out)
            content = next(out.rglob('*.html')).read_text(encoding='utf-8')
            self.assertNotIn('<script>', content)
            self.assertIn('&lt;script&gt;', content)

    def test_no_partial_vendor_bundle(self):
        bad = self.row.copy()
        bad[0] = ''
        r = self.run_rows([self.header, self.row, bad])
        with tempfile.TemporaryDirectory(dir=p.LOCAL) as tmp:
            out = Path(tmp) / 'result'
            p.write_bundle(r, out)
            self.assertEqual([f.name for f in out.iterdir()], ['report.json'])

    def test_output_boundary_and_no_overwrite(self):
        with tempfile.TemporaryDirectory(dir=p.LOCAL) as tmp:
            with self.assertRaises(ValueError):
                p.write_bundle(self.run_rows(), p.ROOT / '잘못된위치')
            with self.assertRaises(FileExistsError):
                p.write_bundle(self.run_rows(), Path(tmp))

    def test_workbook_cli_and_multi_sheet(self):
        with tempfile.TemporaryDirectory(dir=p.LOCAL) as tmp:
            source = Path(tmp) / '직배(미키코리아).xlsx'
            fixture(source, {'발주': [self.header, self.row]})
            result = subprocess.run([sys.executable, str(Path(p.__file__)), str(source), '--output', str(Path(tmp) / '출력')], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            fixture(source, {'발주': [self.header, self.row], '복사': [self.header, self.row]})
            with self.assertRaises(ValueError):
                p.read_workbook(source, None)
            rows, name = p.read_workbook(source, '발주')
            self.assertEqual(name, '발주')
            self.assertEqual(rows[1][0], 'TEST-1')

    def test_hidden_sheets_are_excluded_and_wrong_selection_is_held(self):
        from openpyxl import Workbook
        with tempfile.TemporaryDirectory(dir=p.LOCAL) as tmp:
            source = Path(tmp) / '모의 발주서.xlsx'
            book = Workbook()
            book.active.title = '숨김'
            book.active.sheet_state = 'hidden'
            book.create_sheet('매우숨김').sheet_state = 'veryHidden'
            visible = book.create_sheet('발주')
            visible.append(self.header)
            visible.append(self.row)
            book.save(source)
            rows, selected = p.read_workbook(source, None)
            self.assertEqual(selected, '발주')
            self.assertEqual(rows[1][0], 'TEST-1')
            for selected in ('숨김', '매우숨김', '없는시트'):
                with self.subTest(selected=selected), self.assertRaises(ValueError):
                    p.read_workbook(source, selected)
            book.create_sheet('추가본').append(self.header)
            book.save(source)
            with self.assertRaises(ValueError):
                p.read_workbook(source, None)
            self.assertEqual(p.read_workbook(source, '추가본')[1], '추가본')
            book.close()


if __name__ == '__main__':
    p.LOCAL.mkdir(exist_ok=True)
    unittest.main()
