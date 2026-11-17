// 주문 행 화면 분류: 정상·보류·실패를 나누고 보류는 사유별로 묶는다. 화면 표시 전용이며 주문 판정은 바꾸지 않는다.

export const ROW_VIEWS = ["all", "hold", "failed", "ready"];

const norm = (value) => String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

// 행의 사유는 "; "로 이어 붙어 있다. 화면 묶음 기준은 첫 번째 사유다.
export function primaryReason(row) {
  return norm(row?.reason).split(";")[0].trim();
}

export function reasonGroupLabel(row) {
  return primaryReason(row) || "사유 없음";
}

export function splitRowsByStatus(rows = []) {
  const ready = [];
  const hold = [];
  const failed = [];
  for (const row of rows) {
    if (row?.status === "HOLD") hold.push(row);
    else if (row?.status === "FAILED") failed.push(row);
    else ready.push(row);
  }
  return { ready, hold, failed };
}

// 보류 행을 사유별로 묶는다. 건수가 많은 사유가 위, 같으면 이름순.
export function groupHoldRowsByReason(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const label = reasonGroupLabel(row);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }
  return [...groups.entries()]
    .map(([label, groupRows]) => ({ label, rows: groupRows }))
    .sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label, "ko"));
}

export function rowCounts(rows = []) {
  const { ready, hold, failed } = splitRowsByStatus(rows);
  return { all: rows.length, ready: ready.length, hold: hold.length, failed: failed.length };
}

// 선택한 보기에 맞는 구역을 돌려준다. 보류가 먼저, 행이 없는 구역은 뺀다.
export function rowSections(rows = [], view = "all") {
  const { ready, hold, failed } = splitRowsByStatus(rows);
  const wanted = (key) => view === "all" || view === key;
  const sections = [
    { key: "hold", title: "보류", rows: hold, groups: groupHoldRowsByReason(hold) },
    { key: "failed", title: "실패", rows: failed, groups: [] },
    { key: "ready", title: "정상", rows: ready, groups: [] },
  ];
  return sections.filter((section) => wanted(section.key) && section.rows.length > 0);
}
