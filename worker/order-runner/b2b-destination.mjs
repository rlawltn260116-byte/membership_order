const norm = (v) => String(v ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
export function splitDestination(value, vendor = "eroum") {
  const text = norm(value);
  if (vendor === "bofeel" && !text.includes("_")) {
    // 건물명 괄호 안 쉼표는 주소의 일부다. 수취인 구분자로 쓰지 않는다.
    let comma = -1, depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      else if (text[i] === "," && depth === 0) comma = i;
      if (depth < 0) return null;
    }
    if (depth !== 0) return null;
    const match = comma < 0 ? /^(.*\S)\s+([가-힣]{2,4})$/.exec(text) : null;
    const address = comma >= 0 ? text.slice(0, comma).trim() : match?.[1];
    const name = comma >= 0 ? text.slice(comma + 1).trim() : match?.[2];
    if (!address || !name || (comma < 0 ? !/^[가-힣]{2,4}$/.test(name) : name.length > 40 || /[_/,]/.test(name)) || /(?:호|동|층|가|로|길|건물|아파트|빌라|주택|센터|병원|상가)$/.test(name) ||
        !/\d/.test(address) || (address.match(/\(/g)?.length ?? 0) !== (address.match(/\)/g)?.length ?? 0)) return null;
    return { name, address };
  }
  const underscore = text.lastIndexOf("_");
  const slash = [...text.matchAll(/\s+\/\s+/g)].at(-1);
  const index = underscore >= 0 ? underscore : slash?.index ?? -1;
  const width = underscore >= 0 ? 1 : slash?.[0].length ?? 0;
  if (index < 1) return null;
  const address = text.slice(0, index).trim(), name = text.slice(index + width).trim();
  // 구분자 잔여·중복 수취인·주소처럼 보이는 수취인은 자동 해석하지 않는다.
  if (!address || !name || name.length > 40 || /[_/\r\n]/.test(name)) return null;
  return { name, address };
}

