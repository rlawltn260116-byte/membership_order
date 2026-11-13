"""보필의 우편번호 조회 전용 파이프. 고객 원문·응답·쿠키를 파일이나 로그에 남기지 않는다."""
import gzip
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from http_login_draft import LoginError, NoRedirect, check_stop_signal

ORIGIN = 'https://bofeelmall.com'


def lookup(keywords, env, opener=None, pause=time.sleep):
    if env.get('ENABLE_B2B_HTTP_CART') != 'true':
        return []
    if (not isinstance(keywords, list) or not 1 <= len(keywords) <= 30 or
            any(not isinstance(key, str) or not key.strip() or len(key) > 300 for key in keywords) or
            len(set(keywords)) != len(keywords)):
        raise LoginError('우편번호 조회 범위 불일치')
    opener = opener or urllib.request.build_opener(NoRedirect())

    def read(path, fields=None):
        request = urllib.request.Request(ORIGIN + path,
            data=urllib.parse.urlencode(fields).encode() if fields is not None else None,
            headers={'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                     'X-Requested-With': 'XMLHttpRequest', 'Origin': ORIGIN,
                     'Referer': ORIGIN + '/share/postcode_search.php'})
        with opener.open(request, timeout=15) as response:
            if response.code != 200:
                raise LoginError('우편번호 조회 응답 실패')
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                raise LoginError('우편번호 응답 한도 초과')
            if response.headers.get('Content-Encoding', '').lower() == 'gzip':
                raw = gzip.decompress(raw)
            text = raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
            check_stop_signal(text)
            return text

    if 'postcode_search_ps.php' not in read('/share/postcode_search.php'):
        raise LoginError('우편번호 조회 폼 변경')
    results = []
    for keyword in keywords:
        pause(1)
        data = json.loads(read('/share/postcode_search_ps.php', {'keyword': keyword}).lstrip('\ufeff'))
        result = data.get('resultData', {})
        items = result.get('addressData')
        if str(result.get('codeData', {}).get('code')) != '0' or not isinstance(items, list) or len(items) > 1000:
            raise LoginError('우편번호 응답 구조 변경')
        results.append({'resultData': {'codeData': {'code': '0'}, 'addressData': [
            {key: item.get(key, '') for key in ('roadAddress', 'groundAddress', 'zoneCode')} for item in items]}})
    return results


if __name__ == '__main__':
    try:
        result = lookup(json.loads(sys.stdin.readline(100_001)), os.environ)
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        # 실패·중단 신호 뒤에는 다음 주소를 요청하거나 재시도하지 않는다.
        print('[]')
        raise SystemExit(1)
