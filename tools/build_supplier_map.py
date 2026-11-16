"""공급가격표의 허용된 세 열만 읽어 공개 가능한 발주처 학습 자료를 만든다."""

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import unicodedata

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "worker/order-runner/data/supplier-map.json"
DEFAULT_SCHEDULE = ROOT / "worker/order-runner/data/direct-delivery-schedule.json"
SHEETS = {
    "급여 상품 공급 가격표": ("급여", "매입처(제조처)"),
    "비급여 상품 공급 가격표": ("비급여", "매입처(공급처)"),
    "중고 상품 공급 가격표": ("중고", "매입처(공급처)"),
}
ALIASES = {"티에치케이컴퍼니": "티에이치케이컴퍼니", "사과나무COP": "사과나무코퍼레이션"}
REVERSED_PAIRS = {
    ("닛신", "티에이치케이컴퍼니"),
    ("미라클메디", "티에이치케이컴퍼니"),
    ("해련", "안앤락"),
}
IGNORED_PAIR = ("조아", "시호넨스")


def normalize_model(model):
    """공백·대소문자·괄호 기호만 흡수하고 괄호 안의 모델 정보는 보존한다."""
    value = unicodedata.normalize("NFKC", model).lower()
    return re.sub(r"[\s()\[\]{}]", "", value)


def parse_supplier(raw):
    """사용자 확정 규칙을 적용한다. 제외 행은 None으로 반환한다."""
    rules = []
    value = unicodedata.normalize("NFKC", raw).strip()
    without_delivery = re.sub(r"\s*/\s*직배\s*$", "", value)
    if without_delivery != value:
        rules.append("끝 직배 표기 제거")
    match = re.fullmatch(r"([^()]+?)(?:\s*\(([^()]+)\))?", without_delivery)
    if not match:
        raise ValueError("매입처 괄호 표기를 확인해야 합니다")
    supplier, manufacturer = (part.strip() if part else "" for part in match.groups())
    if not supplier:
        raise ValueError("발주처가 비어 있습니다")
    pair = (supplier, manufacturer)
    if pair == IGNORED_PAIR:
        return None
    normalized = tuple(ALIASES.get(part, part) for part in pair)
    if normalized != pair:
        rules.append("업체명 별칭 통합")
    supplier, manufacturer = normalized
    if normalized in REVERSED_PAIRS:
        supplier, manufacturer = manufacturer, supplier
        rules.append("발주처·제조처 역전 보정")
    return supplier, manufacturer, rules


def summarize(records, ignored_rows):
    groups = defaultdict(list)
    for record in records:
        groups[record["modelKey"]].append(record)
    ambiguous = []
    for key, matches in sorted(groups.items()):
        suppliers = sorted({row["supplier"] for row in matches})
        if len(suppliers) > 1:
            ambiguous.append({
                "modelKey": key,
                "models": sorted({row["model"] for row in matches}),
                "suppliers": suppliers,
            })
    suppliers = {row["supplier"] for row in records}
    matched = {row["supplier"] for row in records if row["scheduleVendor"] != "미정"}
    return {
        "recordCount": len(records),
        "modelCount": len(groups),
        "modelSpellingCount": len({row["model"] for row in records}),
        "categoryCounts": dict(Counter(row["category"] for row in records)),
        "supplierCount": len(suppliers),
        "scheduleMatchedSupplierCount": len(matched),
        "scheduleUnresolvedSuppliers": sorted(suppliers - matched),
        "ignoredRows": ignored_rows,
        "exceptionRowCount": sum(bool(row["appliedRules"]) for row in records),
        "ruleCounts": dict(Counter(rule for row in records for rule in row["appliedRules"])),
        "ambiguousModels": ambiguous,
    }


def build_supplier_map(source, schedule_path=DEFAULT_SCHEDULE):
    schedule = json.loads(Path(schedule_path).read_text(encoding="utf-8"))
    schedule_vendors = {item["vendor"] for item in schedule["schedule"]}
    if "THK" not in schedule_vendors:
        raise ValueError("시간표에 THK가 없습니다")
    records = []
    ignored_rows = 0
    book = load_workbook(source, read_only=True, data_only=True)
    try:
        for sheet_name, (category, supplier_header) in SHEETS.items():
            if sheet_name not in book.sheetnames:
                raise ValueError(f"필수 시트가 없습니다: {sheet_name}")
            sheet = book[sheet_name]
            if sheet.sheet_state != "visible":
                raise ValueError(f"허용 시트가 숨김 상태입니다: {sheet_name}")
            # 가격·급여코드·ERP 품번 등 나머지 열은 추출하지 않는다.
            rows = sheet.iter_rows(min_col=2, max_col=4, values_only=True)
            header_found = False
            for row_number, row in enumerate(rows, 1):
                if not header_found:
                    if row == ("품명", "모델명", supplier_header):
                        header_found = True
                    continue
                product_name, model, raw_supplier = row
                if all(value is None or value == "" for value in row):
                    continue
                if not all(isinstance(value, str) and value.strip() for value in row):
                    raise ValueError(f"필수 문자 열이 비었습니다: {sheet_name} {row_number}행")
                parsed = parse_supplier(raw_supplier)
                if parsed is None:
                    ignored_rows += 1
                    continue
                supplier, manufacturer, rules = parsed
                schedule_vendor = "THK" if supplier == "티에이치케이컴퍼니" else supplier
                if schedule_vendor == "THK":
                    rules.append("시간표 THK 연결")
                if schedule_vendor not in schedule_vendors:
                    schedule_vendor = "미정"
                model = model.strip()
                if not normalize_model(model):
                    raise ValueError(f"모델 키가 비었습니다: {sheet_name} {row_number}행")
                records.append({
                    "model": model,
                    "modelKey": normalize_model(model),
                    "category": category,
                    "productName": product_name.strip(),
                    "supplier": supplier,
                    "manufacturer": manufacturer,
                    "scheduleVendor": schedule_vendor,
                    "scheduleStatus": "발주 시각·방식 미정" if schedule_vendor == "미정" else "시간표 연결",
                    "rawSupplier": raw_supplier,
                    "appliedRules": rules,
                })
            if not header_found:
                raise ValueError(f"필수 머리글이 없습니다: {sheet_name}")
    finally:
        book.close()
    return {
        "schemaVersion": 1,
        "rulesConfirmedAt": "2026-11-16",
        "source": "2026년 11월 상품 공급가격표의 지정된 보이는 시트 3개",
        "sheets": list(SHEETS),
        "records": records,
        "summary": summarize(records, ignored_rows),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="읽기 전용 원본 xlsx 경로")
    parser.add_argument("--schedule", type=Path, default=DEFAULT_SCHEDULE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    result = build_supplier_map(args.source, args.schedule)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
