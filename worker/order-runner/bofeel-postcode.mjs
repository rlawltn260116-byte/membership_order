// 보필 우편번호 검색 응답의 오프라인 판정. 조회·저장·주문 기능 없음.
// 접두어 유사성으로 지역을 추측하지 않는다. 이 표에 적힌 별칭만 같은 지역이다.
export const provinceAliases = Object.freeze({
  서울특별시: '서울', 서울: '서울', 부산광역시: '부산', 부산: '부산', 대구광역시: '대구', 대구: '대구',
  인천광역시: '인천', 인천: '인천', 광주광역시: '광주', 광주: '광주', 대전광역시: '대전', 대전: '대전',
  울산광역시: '울산', 울산: '울산', 세종특별자치시: '세종', 세종: '세종', 경기도: '경기', 경기: '경기',
  강원도: '강원', 강원특별자치도: '강원', 강원: '강원', 충청북도: '충북', 충북: '충북',
  충청남도: '충남', 충남: '충남', 전라북도: '전북', 전북특별자치도: '전북', 전북: '전북',
  전라남도: '전남', 전남: '전남', 경상북도: '경북', 경북: '경북', 경상남도: '경남', 경남: '경남',
  제주특별자치도: '제주', 제주도: '제주', 제주: '제주',
});
const clean = value => typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
const region = name => Object.hasOwn(provinceAliases, name) ? provinceAliases[name] : name;
const hold = reason => ({ decision: 'HOLD', reason: `우편번호 보류: ${reason}`, postcode: '', roadAddress: '', detail: '' });

function splitAddress(address, kind) {
  const tokens = clean(address).split(' ');
  for (let i = 1; i < tokens.length - 1; i++) {
    const location = tokens[i];
    if (!(kind === 'road' ? /^[가-힣A-Za-z0-9.·]+(?:로|길)$/ : /^[가-힣A-Za-z0-9.·]+(?:동|리)$/).test(location)) continue;
    // 지번의 산 표시는 본번·부번과 별도로 정확히 대조한다.
    const mountain = kind === 'ground' && (tokens[i + 1] === '산' || tokens[i + 1].startsWith('산'));
    const offset = mountain && tokens[i + 1] === '산' ? 2 : 1;
    const number = /^(\d+)(?:-(\d+))?($|[,(].*)/.exec((tokens[i + offset] || '').replace(mountain ? /^산/ : /^$/, ''));
    if (!number || Number(number[1]) < 1) continue;
    const head = tokens.slice(0, i);
    // 지역이 빠졌거나 시·군·구가 아닌 토큰이 섞이면 자동 확정하지 않는다.
    if ((!Object.hasOwn(provinceAliases, head[0]) && !/(?:도|특별시|광역시|특별자치시)$/.test(head[0])) ||
        head.slice(1).some(token => !/(?:시|군|구|읍|면)$/.test(token))) continue;
    head[0] = region(head[0]);
    if (head.length < 2 && head[0] !== '세종') continue;
    if (![Number(number[1]), Number(number[2] || 0)].every(Number.isSafeInteger)) continue;
    return { kind, head, location, main: Number(number[1]), sub: Number(number[2] || 0), mountain,
      detail: clean([number[3], ...tokens.slice(i + offset + 1)].join(' ')).replace(/^[, ]+/, '') };
  }
  return null;
}

const same = (left, right) => left && right && JSON.stringify(left.head) === JSON.stringify(right.head) &&
  left.location === right.location && left.main === right.main && left.sub === right.sub && left.mountain === right.mountain;
const baseOnly = parsed => parsed && (!parsed.detail || /^\([^()]*\)$/.test(parsed.detail));

export function bofeelPostcodeKeyword(address) {
  const parsed = splitAddress(address, 'road') || splitAddress(address, 'ground');
  if (!parsed) return null;
  return [...parsed.head, parsed.location, `${parsed.mountain ? '산' : ''}${parsed.main}${parsed.sub ? '-' + parsed.sub : ''}`].join(' ');
}

export function resolveBofeelPostcode(address, response) {
  const source = splitAddress(address, 'road') || splitAddress(address, 'ground');
  if (!source) return hold('발주서의 시·군·구와 도로명·건물번호 또는 동·리·지번을 확정할 수 없습니다.');
  const data = response?.resultData;
  if (!data || String(data.codeData?.code) !== '0' || !Array.isArray(data.addressData) || data.addressData.length > 10000)
    return hold('검색 응답 구조 또는 성공 코드를 확인할 수 없습니다.');
  const candidates = data.addressData.filter(item => {
    if (!item || typeof item !== 'object') return false;
    const compared = splitAddress(source.kind === 'road' ? item.roadAddress : item.groundAddress, source.kind);
    return baseOnly(compared) && same(source, compared);
  });
  if (candidates.length !== 1) return hold(candidates.length > 1
    ? '시·군·구와 도로명·건물번호 또는 동·리·지번이 일치하는 결과가 2건 이상입니다.'
    : '시·도 별칭표와 시·군·구, 도로명·건물번호 또는 동·리·지번이 정확히 일치하는 결과가 없습니다.');
  const item = candidates[0], road = splitAddress(item.roadAddress, 'road');
  if (!baseOnly(road) || JSON.stringify(source.head) !== JSON.stringify(road.head) ||
      typeof item.zoneCode !== 'string' || !/^\d{5}$/.test(item.zoneCode))
    return hold('유일한 검색 결과의 5자리 우편번호 또는 같은 지역의 도로명 주소를 확인할 수 없습니다.');
  return { decision: 'USE', reason: '시·도 별칭표와 주소 본번·부번이 일치하는 검색 결과 1건을 확인했습니다.',
    postcode: item.zoneCode, roadAddress: clean(item.roadAddress), detail: source.detail };
}
