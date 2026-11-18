"""본인 회사 주소 한 곳으로만 실행하는 외부메일 시험 도구(기본 드라이런)."""
import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

RESULT_CODES = frozenset({
    'DRY_RUN', 'SENT', 'SEND_UNKNOWN', 'SERVICE_ERROR', 'INVALID_REQUEST',
    'INVALID_JSON', 'UNAUTHORIZED', 'ALLOWLIST_REQUIRED', 'INVALID_RECIPIENT',
    'RECIPIENT_NOT_ALLOWED', 'INVALID_DRY_RUN', 'INVALID_SUBJECT', 'INVALID_BODY',
    'INVALID_ATTACHMENT', 'MESSAGE_TOO_LARGE', 'BUSY', 'SEND_DISABLED', 'QUOTA_EXCEEDED',
})


def build_payload(environ, *, send=False, attachments=()):
    token = environ.get('EXTERNAL_MAIL_TOKEN', '')
    recipient = environ.get('EXTERNAL_MAIL_TEST_TO', '').strip()
    if len(token) < 32:
        raise ValueError('EXTERNAL_MAIL_TOKEN에 32자 이상의 토큰을 설정하세요.')
    if not re.fullmatch(r"[a-zA-Z0-9.!#$%&'+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", recipient):
        raise ValueError('EXTERNAL_MAIL_TEST_TO에 본인 회사 주소 하나만 설정하세요.')
    files = []
    for filename in attachments:
        path = Path(filename)
        if path.stat().st_size > 1024 * 1024:
            raise ValueError('첨부파일이 시험 크기 제한을 초과했습니다.')
        files.append({'filename': path.name, 'mimeType': mimetypes.guess_type(path.name)[0] or 'application/octet-stream',
                      'base64': base64.b64encode(path.read_bytes()).decode('ascii')})
    payload = {'token': token, 'to': recipient, 'subject': '[시험] 외부메일 연결 확인',
               'body': '본인 회사 주소로 보내는 외부메일 연결 시험입니다. 실제 발주가 아닙니다.',
               'dryRun': not send, 'attachments': files}
    if len(files) > 10 or len(json.dumps(payload).encode('utf-8')) > 2 * 1024 * 1024:
        raise ValueError('시험 요청 크기 또는 첨부 수 제한을 초과했습니다.')
    return payload


def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.netloc != 'script.google.com' or
            not re.fullmatch(r'/macros/s/[A-Za-z0-9_-]+/exec', parsed.path) or parsed.query or parsed.fragment):
        raise ValueError('EXTERNAL_MAIL_URL에 배포된 Google 웹앱의 /exec URL을 설정하세요.')
    return url


class GoogleRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != 'https' or parsed.netloc != 'script.googleusercontent.com':
            raise ValueError('예상하지 못한 리디렉션입니다. 배포 접근 권한을 확인하세요.')
        # ContentService 결과만 GET으로 읽으며 토큰이 든 POST 본문은 재전송하지 않는다.
        if code not in (301, 302, 303):
            raise ValueError('POST 재전송 리디렉션을 거부했습니다.')
        return urllib.request.Request(newurl, method='GET')


def send_request(url, payload):
    request = urllib.request.Request(validate_url(url), data=json.dumps(payload).encode('utf-8'),
                                     headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.build_opener(GoogleRedirectHandler()).open(request, timeout=30) as response:
        result = json.loads(response.read(65536).decode('utf-8'))
    if not isinstance(result, dict) or not isinstance(result.get('ok'), bool):
        raise ValueError('JSON 응답 형식이 올바르지 않습니다.')
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--send', action='store_true', help='본인 회사 주소로 실제 시험 발송(서버 속성도 필요)')
    parser.add_argument('--attachment', action='append', default=[], help='개인정보 없는 시험 첨부파일')
    args = parser.parse_args(argv)
    try:
        payload = build_payload(os.environ, send=args.send, attachments=args.attachment)
        result = send_request(os.environ.get('EXTERNAL_MAIL_URL', ''), payload)
        # 서버가 돌려준 임의 문자열이나 입력값은 출력하지 않는다.
        safe = {k: result.get(k) if type(result.get(k)) is bool else None
                for k in ('ok', 'sent', 'dryRun')}
        safe.update({k: result.get(k) if type(result.get(k)) is int else None
                     for k in ('messageBytes', 'remainingDailyQuota')})
        code = result.get('code')
        if isinstance(code, str) and code in RESULT_CODES:
            safe['code'] = code
        print(json.dumps(safe, ensure_ascii=False))
        if not result['ok']:
            print('요청이 거절되었거나 발송 결과가 불명확합니다. 자동 재시도하지 마세요.', file=sys.stderr)
        return 0 if result['ok'] else 1
    except (ValueError, OSError, urllib.error.URLError):
        print('시험 실패: 환경변수·배포·입력을 확인하세요. 발송을 요청했다면 보낸편지함 확인 전 재시도하지 마세요.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
