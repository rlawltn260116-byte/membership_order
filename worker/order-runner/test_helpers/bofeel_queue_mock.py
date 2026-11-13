"""통합 시험 전용 합성 HTTP. 실제 소켓·사이트 요청을 금지한다."""
import sys
import json
import os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import urllib.request
import urllib.parse
from unittest.mock import Mock, patch
import http_queue
from test_http_queue import FakeBofeel
from test_http_amounts import bofeel_case
from test_http_submission import response, history, OLD, NUMBER


class Session(FakeBofeel):
    def __init__(self, vendor):
        assert vendor == 'bofeel'
        super().__init__()
        self.vendor = vendor
        self.authenticated = False
        self.opener = Mock(open=self.result)
        self.posts = 0
        self.history_reads = 0

    def login(self, *args):
        super().login(*args)
        self.authenticated = True

    def read_amount(self, path, fields):
        assert path == '/order/cart_ps.php'
        return {'areaDelivery': 3}

    def open_order(self):
        return bofeel_case()[3]

    def result(self, request, **kwargs):
        path = urllib.parse.urlsplit(request.full_url).path
        if request.get_method() == 'POST':
            assert path == '/order/order_ps.php' and self.posts == 0
            self.posts += 1
            self.quantity = 0
            return response("<script>parent.location.replace('../order/order_end.php?orderNo=" + NUMBER + "');</script>")
        if path == '/mypage/order_list.php':
            self.history_reads += 1
            return response(history(OLD) if self.history_reads == 1 else history(OLD, NUMBER))
        assert path == '/order/order_end.php' and self.posts == 1
        return response('로그아웃 주문 완료 주문번호: ' + NUMBER)


if __name__ == '__main__':
    with patch.object(urllib.request.OpenerDirector, 'open', side_effect=AssertionError('실제 요청 금지')), \
            patch('http_queue.time.sleep'), \
            patch('http_amounts.render', side_effect=bofeel_case()[4]):
        payload = json.loads(sys.stdin.readline(1_000_001))
        http_queue.run('bofeel', payload['groups'], os.environ, session_factory=Session,
                       execution_mode=payload.get('executionMode', 'PREPARE'))
