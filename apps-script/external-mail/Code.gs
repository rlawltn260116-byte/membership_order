// 비밀값과 실제 주소는 프로젝트 설정의 스크립트 속성에만 저장한다.
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;

function mailError_(code) { throw new Error(code); }

function addresses_(value) {
  if (value === undefined || value === '') return [];
  const items = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(items)) mailError_('INVALID_RECIPIENT');
  return items.map(function (item) {
    if (typeof item !== 'string') mailError_('INVALID_RECIPIENT');
    const address = item.trim().toLowerCase();
    // 표시 이름, 헤더 개행, 세미콜론, 와일드카드는 허용하지 않는다.
    if (!/^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(address)) {
      mailError_('INVALID_RECIPIENT');
    }
    return address;
  });
}

function bytes_(value) { return Utilities.newBlob(value).getBytes().length; }

function doPost(e) {
  let size = null;
  let quota = null;
  let attempted = false;
  let lock = null;
  try {
    const raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || bytes_(raw) > MAX_REQUEST_BYTES) mailError_('INVALID_REQUEST');
    let data;
    try { data = JSON.parse(raw); } catch (_) { mailError_('INVALID_JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) mailError_('INVALID_REQUEST');
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('EXTERNAL_MAIL_TOKEN');
    if (!secret || secret.length < 32 || typeof data.token !== 'string' || data.token !== secret) {
      mailError_('UNAUTHORIZED');
    }
    const allowed = addresses_(props.getProperty('EXTERNAL_MAIL_ALLOWED_RECIPIENTS') || '');
    if (!allowed.length) mailError_('ALLOWLIST_REQUIRED');
    const to = addresses_(data.to);
    const cc = addresses_(data.cc);
    const bcc = addresses_(data.bcc);
    const recipients = to.concat(cc, bcc);
    if (!to.length || recipients.length > 10) mailError_('INVALID_RECIPIENT');
    if (recipients.some(function (a) { return allowed.indexOf(a) < 0; })) mailError_('RECIPIENT_NOT_ALLOWED');
    if (data.dryRun !== undefined && typeof data.dryRun !== 'boolean') mailError_('INVALID_DRY_RUN');
    const dryRun = data.dryRun !== false;
    if (typeof data.subject !== 'string' || !data.subject.trim() || data.subject.length > 200 || /[\r\n]/.test(data.subject)) mailError_('INVALID_SUBJECT');
    if (typeof data.body !== 'string') mailError_('INVALID_BODY');
    const attachments = data.attachments === undefined ? [] : data.attachments;
    if (!Array.isArray(attachments) || attachments.length > 10) mailError_('INVALID_ATTACHMENT');
    size = bytes_(data.subject) + bytes_(data.body) + bytes_(recipients.join(','));
    const blobs = attachments.map(function (a) {
      if (!a || typeof a.filename !== 'string' || !a.filename || a.filename.length > 200 || /[\r\n/\\]/.test(a.filename) ||
          typeof a.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType) ||
          typeof a.base64 !== 'string' || a.base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.base64)) mailError_('INVALID_ATTACHMENT');
      const decoded = Utilities.base64Decode(a.base64);
      size += decoded.length;
      return Utilities.newBlob(decoded, a.mimeType, a.filename);
    });
    if (size > MAX_MESSAGE_BYTES) mailError_('MESSAGE_TOO_LARGE');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) mailError_('BUSY');
    quota = MailApp.getRemainingDailyQuota();
    if (!dryRun) {
      if (props.getProperty('EXTERNAL_MAIL_ENABLE_SEND') !== 'true') mailError_('SEND_DISABLED');
      if (quota < recipients.length) mailError_('QUOTA_EXCEEDED');
      const message = {to: to.join(','), subject: data.subject, body: data.body, attachments: blobs};
      if (cc.length) message.cc = cc.join(',');
      if (bcc.length) message.bcc = bcc.join(',');
      attempted = true;
      MailApp.sendEmail(message);
    }
    // 발송 후 할당량 조회 실패를 발송 실패로 오인하지 않도록 한다.
    try { quota = MailApp.getRemainingDailyQuota(); } catch (_) { quota = null; }
    return json_({ok: true, sent: !dryRun, dryRun: dryRun, messageBytes: size,
      remainingDailyQuota: quota, code: dryRun ? 'DRY_RUN' : 'SENT'});
  } catch (err) {
    const known = /^(INVALID_REQUEST|INVALID_JSON|UNAUTHORIZED|ALLOWLIST_REQUIRED|INVALID_RECIPIENT|RECIPIENT_NOT_ALLOWED|INVALID_DRY_RUN|INVALID_SUBJECT|INVALID_BODY|INVALID_ATTACHMENT|MESSAGE_TOO_LARGE|BUSY|SEND_DISABLED|QUOTA_EXCEEDED)$/;
    // 서비스 예외에는 주소 등이 섞일 수 있으므로 원문을 반환하거나 기록하지 않는다.
    return json_({ok: false, sent: attempted ? null : false, messageBytes: size,
      remainingDailyQuota: quota, code: attempted ? 'SEND_UNKNOWN' : (known.test(err.message) ? err.message : 'SERVICE_ERROR')});
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function json_(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
