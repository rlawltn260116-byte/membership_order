"""과거 자료 분석도 시트를 임의로 선택하지 않는지 가짜 워크북으로 확인한다."""
import unittest
from openpyxl import Workbook
from analyze_thkc_orders import select_analysis_sheet


class AnalysisSheetTests(unittest.TestCase):
    def test_single_visible_sheet_ignores_hidden_first_sheet(self):
        book = Workbook()
        book.active.sheet_state = 'hidden'
        book.create_sheet('발주')
        book.create_sheet('매우숨김').sheet_state = 'veryHidden'
        self.assertEqual(select_analysis_sheet(book).title, '발주')
        book.close()

    def test_two_visible_or_no_visible_sheets_are_held(self):
        book = Workbook()
        book.create_sheet('추가')
        with self.assertRaises(ValueError):
            select_analysis_sheet(book)
        for sheet in book.worksheets:
            sheet.sheet_state = 'hidden'
        with self.assertRaises(ValueError):
            select_analysis_sheet(book)
        book.close()


if __name__ == '__main__':
    unittest.main()
