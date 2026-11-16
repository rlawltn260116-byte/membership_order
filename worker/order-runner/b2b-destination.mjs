const norm = (v) => String(v ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
export const DESTINATION_HOLD_REASON = "납품처에서 수취인 이름을 확정할 수 없음";
export const RECIPIENT_EMPTY_REASON = "수취인 없음";
export const RECIPIENT_ADDRESS_REASON = "납품처 끝이 주소 조각이라 수취인을 확정할 수 없음";
// 저장된 보필 주문서 receiverName의 maxlength. 이로움에는 확인된 제한이 없다.
export const RECIPIENT_MAX_LENGTH = Object.freeze({ bofeel: 20 });

export function analyzeDestination(value, vendor = "eroum") {
  const originalDestination = String(value ?? "");
  const normalizationNotes = [];
  const note = (message) => { if (!normalizationNotes.includes(message)) normalizationNotes.push(message); };
  const clean = (value) => {
    const trimmed = value.trim();
    const cleaned = trimmed.replace(/^["\s]+|["\s]+$/g, "").trim();
    if (cleaned !== trimmed || /^\s*\t|\t\s*$/.test(value)) note("납품처 앞뒤 탭·큰따옴표 제거");
    return cleaned;
  };
  const text = norm(clean(originalDestination));
  // 괄호 안 쉼표는 건물명의 일부다. 주소 안 슬래시는 아래 끝 이름 보조 규칙도 확인한다.
  let separator = -1, separatorDepth = 0, depth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "(") depth++;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if ("_/".includes(character) || (depth === 0 && character === ",")) { separator = index; separatorDepth = depth; }
  }
  let address = separator >= 0 ? text.slice(0, separator).trim() : "";
  let candidate = separator >= 0 ? clean(text.slice(separator + 1)) : "";
  // 명시적 구분자가 없으면 기존 보필의 보수적인 끝 이름 분리만 사용한다.
  const balanced = (part) => (part.match(/\(/g)?.length ?? 0) === (part.match(/\)/g)?.length ?? 0);
  if (vendor === "bofeel" && balanced(text) && (separator < 0 ||
      (text[separator] === "/" && (/^\d+(?:동|호|층|가)\s+/.test(candidate) || (separatorDepth > 0 && separator < text.lastIndexOf(")")))))) {
    const match = /^(.*\S)\s+([가-힣*]{1,5}(?:님)?(?:\s*[DdHh])?(?:님)?)$/.exec(text);
    if (match && /\d/.test(match[1]) && !/(?:호|동|층|가|로|길|건물|아파트|빌라|주택|센터|병원|상가)(?:님)?(?:\s*[DdHh])?$/.test(match[2])) {
      address = match[1]; candidate = match[2];
    }
  }
  let name = candidate;
  // 한글 바로 뒤(공백 허용)의 내부 표기 한 글자만 제거한다. 영문 이름은 보존한다.
  for (let pass = 0; pass < 2; pass++) {
    const suffix = /[가-힣]\s*([DdHh])$/.exec(name);
    if (suffix) {
      name = name.slice(0, suffix.index + 1);
      note(`수취인 끝 내부 표기 ${suffix[1].toUpperCase()} 제거`);
    }
    if (name.endsWith("님")) { name = name.slice(0, -1).trim(); note("수취인 끝 호칭 님 제거"); }
  }
  let reason = "";
  if (!text || (separator >= 0 && !name)) reason = RECIPIENT_EMPTY_REASON;
  else if (separator >= 0 && /^\(?\s*(?:지하\s*)?\d/.test(name)) reason = RECIPIENT_ADDRESS_REASON;
  else if (!address || !name || !balanced(name)) reason = DESTINATION_HOLD_REASON;
  else if (RECIPIENT_MAX_LENGTH[vendor] && name.length > RECIPIENT_MAX_LENGTH[vendor]) reason = `수취인 길이가 사이트 제한 ${RECIPIENT_MAX_LENGTH[vendor]}자를 초과함`;
  return { status: reason ? "HOLD" : "READY", name, address, reason, originalDestination, normalizationNotes };
}

// 기존 호출부의 null 계약은 유지하고 상세 사유·원문은 analyzeDestination에서 제공한다.
export function splitDestination(value, vendor = "eroum") {
  const result = analyzeDestination(value, vendor);
  if (result.status === "HOLD") return null;
  return { name: result.name, address: result.address,
    ...(result.normalizationNotes.length ? { normalizationNotes: result.normalizationNotes } : {}) };
}

