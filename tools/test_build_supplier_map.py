"""허용 시트·열 경계와 사용자 확정 발주처 규칙을 모의 자료로 검증한다."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from openpyxl import Workbook

from build_supplier_map import SHEETS, build_supplier_map, normalize_model, parse_supplier


class SupplierMapTests(unittest.TestCase):
    def test_confirmed_op5_supplier_survives_regeneration(self):
        from openpyxl import load_workbook
        with tempfile.TemporaryDirectory() as temporary:
            source, schedule = self.fixture(Path(temporary))
            book = load_workbook(source)
            book['급여 상품 공급 가격표'].append([None, '성인용보행기', '성인용보행기 ActiveFree OP5', '사과나무COP(SDF INTERNATIONAL CO.,LTD)'])
            book.save(source)
            book.close()
            schedule.write_text(json.dumps({'schedule': [{'vendor': 'THK'}, {'vendor': '안앤락'}]}), encoding='utf-8')
            data = build_supplier_map(source, schedule)
        record = next(row for row in data['records'] if row['model'] == '성인용보행기 ActiveFree OP5')
        self.assertEqual(record['supplier'], '안앤락')
        self.assertEqual(record['scheduleVendor'], '안앤락')
        self.assertEqual(record['scheduleStatus'], '시간표 연결')
        self.assertIn('사과나무COP', record['rawSupplier'])
        self.assertIn('사용자 확정 발주처 보정(2026-11-17)', record['appliedRules'])

    def test_reversed_pairs_and_ordinary_manufacturer(self):
        for raw, expected in (
            ("닛신(티에이치케이컴퍼니)", ("티에이치케이컴퍼니", "닛신")),
            ("미라클메디(티에이치케이컴퍼니)", ("티에이치케이컴퍼니", "미라클메디")),
            ("해련(안앤락)", ("안앤락", "해련")),
        ):
            with self.subTest(raw=raw):
                result = parse_supplier(raw)
                self.assertEqual(result[:2], expected)
                self.assertEqual(result[2], ["발주처·제조처 역전 보정"])
        self.assertEqual(parse_supplier("보필(네오텍)"), ("보필", "네오텍", []))
        self.assertEqual(parse_supplier("보필"), ("보필", "", []))

    def test_aliases_ignore_delivery_and_distinct_suppliers(self):
        self.assertIsNone(parse_supplier("조아(시호넨스) / 직배"))
        self.assertEqual(parse_supplier("티에치케이컴퍼니(아이온)")[:2], ("티에이치케이컴퍼니", "아이온"))
        self.assertEqual(parse_supplier("사과나무COP(성실)")[:2], ("사과나무코퍼레이션", "성실"))
        self.assertEqual(parse_supplier("엠씨텍 / 직배"), ("엠씨텍", "", ["끝 직배 표기 제거"]))
        self.assertNotEqual(parse_supplier("명성H")[0], parse_supplier("명성실버케어")[0])
        for raw in ("", "(제조처)", "보필(제조처", "보필(제조처)(추가)"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_supplier(raw)

    def test_model_key_preserves_parenthesis_contents_and_hyphens(self):
        self.assertEqual(normalize_model(" 수동휠체어　ＭｉＫｉ（Ｗ） [D] "), "수동휠체어mikiwd")
        self.assertEqual(normalize_model("A(B)"), normalize_model("ab"))
        self.assertNotEqual(normalize_model("A(B)"), normalize_model("A(C)"))
        self.assertNotEqual(normalize_model("AB-1"), normalize_model("AB1"))

    def fixture(self, directory):
        source = directory / "모의.xlsx"
        book = Workbook()
        book.remove(book.active)
        for index, (name, (_, header)) in enumerate(SHEETS.items()):
            sheet = book.create_sheet(name)
            sheet.append(["내부 ERP 코드", "품명", "모델명", header, "가격"])
            sheet.append(["내부표식", "모의 품목", "모의 M(1)", "티에치케이컴퍼니(아이온) / 직배" if index == 0 else "명성H", 987654321])
        book.worksheets[0].append([None, "제외 품목", "제외 모델", "조아(시호넨스)"])
        for name in ("Sheet1", "침대 부품 단가표", "부품 공급 가격표", "반품 청구비"):
            sheet = book.create_sheet(name)
            sheet.append([None, "품명", "모델명", "매입처(공급처)"])
            sheet.append([None, "제외표식", "제외표식", "제외표식"])
        book["Sheet1"].sheet_state = "hidden"
        book.save(source)
        book.close()
        schedule = directory / "시간표.json"
        schedule.write_text(json.dumps({"schedule": [{"vendor": "THK"}, {"vendor": "명성실버케어"}]}), encoding="utf-8")
        return source, schedule

    def test_only_allowed_sheets_and_columns_reproducible_without_source_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, schedule = self.fixture(Path(temporary))
            original = hashlib.sha256(source.read_bytes()).hexdigest()
            result = build_supplier_map(source, schedule)
            self.assertEqual(build_supplier_map(source, schedule), result)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original)
        serialized = json.dumps(result, ensure_ascii=False)
        for forbidden in ("내부표식", "제외표식", "987654321", "내부 ERP 코드", "제외 모델"):
            self.assertNotIn(forbidden, serialized)
        self.assertNotIn('"가격"', serialized)
        self.assertEqual(result["summary"]["recordCount"], 3)
        self.assertEqual(result["summary"]["ignoredRows"], 1)
        self.assertEqual(result["summary"]["scheduleMatchedSupplierCount"], 1)
        self.assertEqual(result["summary"]["scheduleUnresolvedSuppliers"], ["명성H"])
        self.assertEqual(result["summary"]["ambiguousModels"], [{
            "modelKey": "모의m1", "models": ["모의 M(1)"], "suppliers": ["명성H", "티에이치케이컴퍼니"],
        }])
        first, second, _ = result["records"]
        self.assertEqual(first["rawSupplier"], "티에치케이컴퍼니(아이온) / 직배")
        self.assertEqual(first["scheduleVendor"], "THK")
        self.assertEqual(second["scheduleVendor"], "미정")
        self.assertEqual(second["scheduleStatus"], "발주 시각·방식 미정")

    def test_required_sheet_hidden_missing_header_or_incomplete_row_is_rejected(self):
        from openpyxl import load_workbook
        for problem in ("숨김", "누락", "머리글", "빈 칸"):
            with self.subTest(problem=problem), tempfile.TemporaryDirectory() as temporary:
                source, schedule = self.fixture(Path(temporary))
                book = load_workbook(source)
                sheet = book[next(iter(SHEETS))]
                if problem == "숨김":
                    sheet.sheet_state = "hidden"
                elif problem == "누락":
                    book.remove(sheet)
                elif problem == "머리글":
                    sheet["D1"] = "다른 열"
                else:
                    sheet["D2"] = None
                book.save(source)
                book.close()
                with self.assertRaises(ValueError):
                    build_supplier_map(source, schedule)


if __name__ == "__main__":
    unittest.main()
