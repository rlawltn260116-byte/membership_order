import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
function setup(overrides = {}) {
  const sent = [];
  const props = {EXTERNAL_MAIL_TOKEN: 'x'.repeat(40), EXTERNAL_MAIL_ALLOWED_RECIPIENTS: 'self@example.invalid', ...overrides};
  const context = vm.createContext({
    PropertiesService: {getScriptProperties: () => ({getProperty: k => props[k]})},
    Utilities: {
      newBlob: (v, mime, name) => ({getBytes: () => [...Buffer.from(v)], mime, name}),
      base64Decode: v => [...Buffer.from(v, 'base64')],
    },
    MailApp: {getRemainingDailyQuota: () => 10, sendEmail: m => sent.push(m)},
    LockService: {getScriptLock: () => ({tryLock: () => true, hasLock: () => true, releaseLock() {}})},
    ContentService: {MimeType: {JSON: 'json'}, createTextOutput: s => ({setMimeType: () => JSON.parse(s)})},
  });
  vm.runInContext(source, context);
  const call = (data = {}) => context.doPost({postData: {contents: JSON.stringify({
    token: props.EXTERNAL_MAIL_TOKEN, to: 'self@example.invalid', subject: '시험', body: '본문', ...data,
  })}});
  return {context, sent, call};
}

test('기본 드라이런은 크기와 할당량만 반환한다', () => {
  const {call, sent} = setup();
  const r = call(); assert.equal(r.ok, true); assert.equal(r.dryRun, true);
  assert.ok(r.messageBytes > 0); assert.equal(r.remainingDailyQuota, 10); assert.equal(sent.length, 0);
});
for (const [name, data, code, props] of [
  ['인증 실패', {token: 'bad'}, 'UNAUTHORIZED'],
  ['비밀 미설정', {}, 'UNAUTHORIZED', {EXTERNAL_MAIL_TOKEN: ''}],
  ['허용 목록 미설정', {}, 'ALLOWLIST_REQUIRED', {EXTERNAL_MAIL_ALLOWED_RECIPIENTS: ''}],
  ['수신자 불허', {to: 'other@example.invalid'}, 'RECIPIENT_NOT_ALLOWED'],
  ['참조 불허', {cc: 'other@example.invalid'}, 'RECIPIENT_NOT_ALLOWED'],
  ['숨은참조 불허', {bcc: ['other@example.invalid']}, 'RECIPIENT_NOT_ALLOWED'],
  ['헤더 주입', {to: 'self@example.invalid\r\nBcc: other@example.invalid'}, 'INVALID_RECIPIENT'],
  ['문자열 false', {dryRun: 'false'}, 'INVALID_DRY_RUN'],
  ['제목 개행', {subject: '시험\n추가'}, 'INVALID_SUBJECT'],
  ['첨부 형식 오류', {attachments: [{filename: 'a.txt', mimeType: 'text/plain', base64: '???='}]}, 'INVALID_ATTACHMENT'],
  ['발송 이중 잠금', {dryRun: false}, 'SEND_DISABLED'],
  ['크기 초과', {body: '가'.repeat(400000)}, 'MESSAGE_TOO_LARGE'],
]) test(name, () => {
  const {call, sent} = setup(props); assert.equal(call(data).code, code); assert.equal(sent.length, 0);
});
test('명시적 발송과 첨부 복원', () => {
  const {call, sent} = setup({EXTERNAL_MAIL_ENABLE_SEND: 'true'});
  assert.equal(call({dryRun: false, attachments: [{filename: 'test.txt', mimeType: 'text/plain', base64: 'aGk='}]}).sent, true);
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].attachments[0].getBytes(), [104, 105]);
});
test('JSON 오류에는 비밀값이 나오지 않는다', () => {
  const {context} = setup(); assert.equal(context.doPost({postData: {contents: '{'}}).code, 'INVALID_JSON');
});
test('할당량 부족은 발송 전에 거부한다', () => {
  const {context, call, sent} = setup({EXTERNAL_MAIL_ENABLE_SEND: 'true'});
  context.MailApp.getRemainingDailyQuota = () => 0;
  assert.equal(call({dryRun: false}).code, 'QUOTA_EXCEEDED'); assert.equal(sent.length, 0);
});
test('서비스 예외는 발송 불명으로 처리하며 원문을 노출하지 않는다', () => {
  const {context, call} = setup({EXTERNAL_MAIL_ENABLE_SEND: 'true'});
  context.MailApp.sendEmail = () => {throw new Error('민감한 서비스 오류');};
  const r = call({dryRun: false}); assert.equal(r.code, 'SEND_UNKNOWN'); assert.equal(r.sent, null);
  assert.ok(!JSON.stringify(r).includes('민감한'));
});
test('발송 뒤 할당량 조회 실패도 발송 성공을 유지한다', () => {
  const {context, call} = setup({EXTERNAL_MAIL_ENABLE_SEND: 'true'}); let calls = 0;
  context.MailApp.getRemainingDailyQuota = () => { if (++calls > 1) throw new Error(); return 10; };
  const r = call({dryRun: false}); assert.equal(r.sent, true); assert.equal(r.remainingDailyQuota, null);
});
