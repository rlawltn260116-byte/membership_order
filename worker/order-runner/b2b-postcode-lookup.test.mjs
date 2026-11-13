import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { lookupBofeelPostcodes } from './b2b-postcode-lookup.mjs';

test('우편번호 파이프는 준비 스위치·범위 밖이면 실행하지 않는다', async () => {
  const execute = () => assert.fail('프로세스 생성 금지');
  assert.deepEqual(await lookupBofeelPostcodes(['모의 주소'], { env: {}, execute }), []);
  assert.deepEqual(await lookupBofeelPostcodes([], { env: { ENABLE_B2B_HTTP_CART: 'true' }, execute }), []);
  assert.deepEqual(await lookupBofeelPostcodes(Array(31).fill('모의 주소'), { env: { ENABLE_B2B_HTTP_CART: 'true' }, execute }), []);
});

test('우편번호 조회 자식에는 로그인·승인·원장·GitHub 비밀값을 보내지 않는다', async () => {
  const env = { ENABLE_B2B_HTTP_CART: 'true', PATH: 'mock-path', BOFEEL_LOGIN_PASSWORD: '출력 금지',
    GITHUB_TOKEN: '출력 금지', B2B_SUBMISSION_LEDGER_KEY: '출력 금지', FINAL_SUBMISSION_APPROVAL_KEY: '출력 금지' };
  let calls = 0;
  const result = await lookupBofeelPostcodes(['모의 주소'], { env, execute: (command, args, options, callback) => {
    calls++;
    assert.equal(options.env.PATH, 'mock-path');
    for (const key of ['BOFEEL_LOGIN_PASSWORD', 'GITHUB_TOKEN', 'B2B_SUBMISSION_LEDGER_KEY', 'FINAL_SUBMISSION_APPROVAL_KEY']) assert.equal(key in options.env, false);
    return { stdin: new Writable({ write(chunk, encoding, done) {
      assert.deepEqual(JSON.parse(chunk), ['모의 주소']);
      callback(null, '[{"resultData":{}}]'); done();
    } }) };
  } });
  assert.equal(calls, 1); assert.equal(result.length, 1);
});
