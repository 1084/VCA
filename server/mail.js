// Outbound email, kept deliberately small: a few plain messages sent through
// Resend's API (https://resend.com). No templates engine, no tracking pixels,
// no marketing. Without RESEND_API_KEY the messages are logged, not sent, so
// nothing else depends on mail working.
//
// Env: RESEND_API_KEY, MAIL_FROM ("Cove <hello@johnhubert.llc>"), MAIL_NOTIFY
//      (where "new application" notes go, e.g. support@johnhubert.llc), CLIENT_ORIGIN.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function makeMailer(env, { log = console.log, fetchFn = globalThis.fetch } = {}) {
  const key = env.RESEND_API_KEY || '';
  const from = env.MAIL_FROM || 'Cove <hello@johnhubert.llc>';
  const notify = env.MAIL_NOTIFY || 'support@johnhubert.llc';
  const origin = (env.CLIENT_ORIGIN || 'https://cove.johnhubert.llc').split(',')[0].trim();

  // One message: text first (what people actually read), a plain HTML twin.
  const send = async ({ to, subject, text, replyTo }) => {
    if (!key) { log(`mail (not sent, no RESEND_API_KEY): to ${to} · ${subject}`); return { sent: false }; }
    const html = `<div style="font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b2326;max-width:560px">${text.split('\n\n').map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    try {
      const r = await fetchFn('https://api.resend.com/emails', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) })
      });
      if (!r.ok) { log(`mail: ${subject} to ${to} failed (${r.status})`); return { sent: false }; }
      return { sent: true };
    } catch (e) { log(`mail: ${subject} to ${to} failed: ${e.message}`); return { sent: false }; }
  };

  return {
    send,
    // the applicant, the moment their application lands
    applicationReceived: ({ name, email, tier }) => send({
      to: email, subject: 'We have your Cove application', replyTo: notify,
      text: `Hi ${name},\n\nThanks for applying for a ${tier === 'studio' ? 'Studio' : 'Room'}. A person reads every application, usually within a few days, and will reply from this address to set up a short call in a Cove room.\n\nIf you have a question in the meantime, just reply.\n\n— Cove, by John Hubert LLC`
    }),
    // the owner, so nothing sits unseen
    applicationNotice: ({ name, email, tier, teaches, where }) => send({
      to: notify, subject: `New application: ${name} (${tier})`, replyTo: email,
      text: `${name} <${email}> applied for a ${tier}.\n\nTeaches: ${teaches}\nWhere now: ${where || '—'}\n\nReview: ${origin}/rooms/admin`
    }),
    // the invitation, when the owner presses Invite
    invited: ({ name, email, hasAccount }) => send({
      to: email, subject: "You're invited to Cove", replyTo: notify,
      text: hasAccount
        ? `Hi ${name},\n\nYou're in. Your account is now a host account: sign in at ${origin} and you'll find "My rooms" in the lobby. Create your room, pick a link, and choose Room or Studio when you rent it. The first month is on us.\n\nIf anything is unclear, reply to this email and a person will help.\n\n— Cove, by John Hubert LLC`
        : `Hi ${name},\n\nYou're in. Create your account at ${origin} using this email address (${email}) and it will open as a host account: you'll find "My rooms" in the lobby. Create your room, pick a link, and choose Room or Studio when you rent it. The first month is on us.\n\nIf anything is unclear, reply to this email and a person will help.\n\n— Cove, by John Hubert LLC`
    })
  };
}

module.exports = { makeMailer };
