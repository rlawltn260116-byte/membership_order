const norm = (v) => String(v ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
export const DESTINATION_HOLD_REASON = "납품처에서 수취인 이름을 확정할 수 없음";
// 한글 이름 후보 끝 내부 표기 한 글자만 제거하며 원문은 보존한다.
const recipient = (candidate) => candidate.replace(/^([가-힣]+)[Dd]$/, "$1");
const result = (candidate, address) => {
  const name = recipient(candidate);
  return { name, address, ...(name !== candidate ? { normalizationNotes: ["수취인 끝 내부 표기 D 제거"] } : {}) };
};
export function splitDestination(value, vendor = "eroum") {
  const text = norm(value);
  const underscore = text.lastIndexOf("_");
  if (underscore >= 0) {
    const address = text.slice(0, underscore).trim(), candidate = text.slice(underscore + 1).trim();
    const name = recipient(candidate);
    // 기존 밑줄 규칙을 우선한다. 이름 안 구분자는 중복 수취인일 수 있다.
    if (!address || !name || name.length > 40 || /[_/\r\n]/.test(name)) return null;
    return result(candidate, address);
  }
  const slash = text.lastIndexOf("/");
  if (slash > 0) {
    const address = text.slice(0, slash).trim(), candidate = text.slice(slash + 1).trim();
    const name = recipient(candidate);
    // 주소 안 동/호 표기는 보존하고 마지막 구분자 뒤의 한글 이름만 확정한다.
    if (address && /^[가-힣]{2,5}$/.test(name)) return result(candidate, address);
    // 이름처럼 적힌 불완전한 뒷부분을 끝 이름 규칙으로 다시 추측하지 않는다.
    // 동/호 숫자·쉼표·닫는 괄호가 있으면 주소 일부일 수 있어 기존 보필 규칙으로 확인한다.
    if (!/[\d,)]/.test(name)) return null;
  }
  if (vendor === "bofeel") {
    // 건물명 괄호 안 쉼표는 주소의 일부다. 수취인 구분자로 쓰지 않는다.
    let comma = -1, depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      else if (text[i] === "," && depth === 0) comma = i;
      if (depth < 0) return null;
    }
    if (depth !== 0) return null;
    const match = comma < 0 ? /^(.*\S)\s+([가-힣]{2,4}[Dd]?)$/.exec(text) : null;
    const address = comma >= 0 ? text.slice(0, comma).trim() : match?.[1];
    const candidate = comma >= 0 ? text.slice(comma + 1).trim() : match?.[2];
    const name = recipient(candidate ?? "");
    if (!address || !name || (comma < 0 ? !/^[가-힣]{2,4}$/.test(name) : name.length > 40 || /[_/,]/.test(name)) || /(?:호|동|층|가|로|길|건물|아파트|빌라|주택|센터|병원|상가)$/.test(name) ||
        !/\d/.test(address) || (address.match(/\(/g)?.length ?? 0) !== (address.match(/\)/g)?.length ?? 0)) return null;
    return result(candidate, address);
  }
  return null;
}

