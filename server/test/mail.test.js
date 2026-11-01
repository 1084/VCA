// mail.js: logs without a key; posts to Resend with one. node server/test/mail.test.js
const assert = require('assert');
const { makeMailer } = require('../mail');
(async () => {
  const logs = []; const calls = [];
  const dry = makeMailer({}, { log: (m) => logs.push(m) });
  assert.deepEqual(await dry.invited({ name: 'A', email: 'a@x.com', hasAccount: false }), { sent: false }); assert.match(logs[0], /not sent/);
  const live = makeMailer({ RESEND_API_KEY: 'k', MAIL_FROM: 'Cove <hello@johnhubert.llc>', CLIENT_ORIGIN: 'https://cove.test' }, { log: () => {}, fetchFn: async (url, o) => { calls.push([url, JSON.parse(o.body), o.headers.authorization]); return { ok: true }; } });
  assert.deepEqual(await live.invited({ name: 'Alicia', email: 'a@x.com', hasAccount: false }), { sent: true });
  const [url, body, auth] = calls[0];
  assert.equal(url, 'https://api.resend.com/emails'); assert.equal(auth, 'Bearer k'); assert.deepEqual(body.to, ['a@x.com']); assert.match(body.text, /https:\/\/cove\.test/); assert.match(body.text, /a@x\.com/); assert.match(body.html, /<p>Hi Alicia,<\/p>/);
  await live.applicationNotice({ name: 'A <b>', email: 'a@x.com', tier: 'studio', teaches: 'Spanish' });
  assert.equal(calls[1][1].to[0], 'support@johnhubert.llc'); assert.match(calls[1][1].html, /&lt;b&gt;/, 'html-escaped');
  const failing = makeMailer({ RESEND_API_KEY: 'k' }, { log: () => {}, fetchFn: async () => ({ ok: false, status: 422 }) });
  assert.deepEqual(await failing.invited({ name: 'A', email: 'a@x.com' }), { sent: false });
  console.log('mail.test: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
