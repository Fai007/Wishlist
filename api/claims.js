// Shared "who's getting what" store for the wish list. A claim is an item id plus a random
// token that lets the claimer undo it. A name is kept only if the claimer chose to give one,
// and it is only ever sent to Faith, never returned to visitors.
const WISH = {
  tennis: 'Wilson Envy XP tennis racket, with balls',
  watch: 'Apple Watch',
  ipad: 'iPad',
  monitor: 'Hisense 27-inch G6Q Pro monitor',
  sun: 'Sunflowers',
  body: 'Body & skin care from The Body Shop',
  flight: 'Return flight ticket to Nairobi',
  jewel: 'Necklace and bracelet pair from ÌTURA',
  wig: 'Wig from Hairs by Nii',
  suede: 'Cherry bag from Brags, in suede',
  camera: 'Fujifilm Instax Mini Evo hybrid instant camera, in black',
  cash: 'Monetary gift',
  perfume: 'Perfumes',
};
// Names of the individually claimed items, in the same order as the page (index.html) lists them.
const ITEMS = {
  tennis: ['Wilson Envy XP racket', 'Vermont tennis balls'],
  jewel: ['Necklace', 'Bracelet'],
  perfume: ['Zara Cherry Temptation, 90 ml', 'French Avenue Luscious, 100 ml', 'Zara Pink Flambe, 90 ml', 'Zara Fashionably London, 100 ml',
    'Atralia Sugar Mallow Pink Cloud, 100 ml'],
  suede: ['Black suede, maxi', 'Black suede, midi', 'Brown suede, maxi', 'Brown suede, midi'],
  book: ['The Romance Revival', 'Soft Landing in Kumasi', 'This Seat Is Taken', 'The Score', 'The Goal', 'The Mistake', 'The Night We Met',
    'Love at First Sighting', 'Love and Other Conspiracies', 'Losing Hope & Finding Cinderella', 'Beg, Borrow, or Steal', 'Beach Read',
    'Love and Other Words', 'Love on the Brain', 'My Week with Him', 'The Parlour Wife',
    'Broken: Not a Halal Love Story', 'A Thousand Splendid Suns'],
  shoe: ['Plum patent strappy sandal', 'Beige snake toe-ring stiletto', 'Black strappy, gold beads', 'Magenta suede slingback', 'Mustard suede slingback'],
};
const GROUP = { book: 'Book', shoe: 'Shoes', tennis: 'Tennis', jewel: 'ÌTURA jewellery', suede: 'Cherry bag from Brags', perfume: 'Perfume' };
// What a claim id means in words, e.g. "Book: Beach Read" or "Cherry bag from Brags, in suede: Black suede, maxi".
function labelOf(id) {
  const [p, k] = id.split('-');
  if (k === undefined) return WISH[p] || id;
  return (GROUP[p] || WISH[p] || p) + ': ' + ((ITEMS[p] || [])[+k] || 'item ' + (+k + 1));
}
const SHAREABLE = new Set(['watch', 'ipad', 'monitor', 'flight', 'cash']);
// The money wish stays open to everyone: it can be sent to any number of times but never taken outright.
const OPEN_ONLY = new Set(['cash']);
// Wishes made of several items are claimed item by item: racket + balls, necklace + bracelet, four bags.
const IDS = [
  'watch', 'ipad', 'monitor', 'sun', 'body', 'flight', 'wig', 'camera', 'cash',
  'tennis-0', 'tennis-1', 'jewel-0', 'jewel-1', 'perfume-0', 'perfume-1', 'perfume-2', 'perfume-3', 'perfume-4',
  'suede-0', 'suede-1', 'suede-2', 'suede-3',
  ...Array.from({ length: 18 }, (_, i) => 'book-' + i),
  ...Array.from({ length: 5 }, (_, i) => 'shoe-' + i),
];

// Where chip-ins are sent. Only returned to someone who has just chipped in.
const ACCOUNT = { number: '8003714351', name: 'Faith Oluokun', bank: process.env.CHIP_BANK || 'Providus Bank' };

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_KEY = process.env.CLAIMS_ADMIN_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const MAIL_TO = process.env.CHIP_NOTIFY_TO || 'faydev007@gmail.com';
const MAIL_FROM = process.env.CHIP_NOTIFY_FROM || 'Wish Quest <onboarding@resend.dev>';
// Where gifts are delivered. Kept in environment variables so it never sits in the repo, and only ever
// placed in Faith's own notification email, as a ready-to-send reply to a giver who asked for it.
const multiline = (v) => (v || '').replace(/\\n/g, '\n').trim();
const DELIVERY = {
  name: process.env.DELIVERY_NAME || 'Faith Oluokun',
  phone: (process.env.DELIVERY_PHONE || '').trim(),
  address: multiline(process.env.DELIVERY_ADDRESS),
  notes: multiline(process.env.DELIVERY_NOTES),
};

// A mailto: link that opens Faith's mail app with the delivery-details reply already written.
function deliveryReply(email, name, wish) {
  if (!DELIVERY.address) return '';
  const body = [
    'Hi ' + (name || 'there') + ',',
    '',
    'Thank you so much for granting one of my birthday wishes (' + wish + "). You've made my day!",
    '',
    'Here is where to send it:',
    '',
    'Recipient: ' + DELIVERY.name,
    ...(DELIVERY.phone ? ['Phone: ' + DELIVERY.phone] : []),
    'Address:',
    DELIVERY.address.replace(/\r?\n/g, '\r\n'),
    ...(DELIVERY.notes ? ['', DELIVERY.notes] : []),
    '',
    "Thank you again. I'm so grateful.",
    '',
    'With love,',
    'Faith',
  ].join('\r\n');
  // the @ must stay unescaped or some mail apps (Gmail among them) leave the To field empty
  return 'mailto:' + encodeURIComponent(email).replace(/%40/g, '@') + '?subject=' + encodeURIComponent('Delivery details for my birthday gift') + '&body=' + encodeURIComponent(body);
}

async function redis(cmds) {
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map((x) => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}

async function snapshot() {
  const out = await redis(IDS.flatMap((id) => [['EXISTS', 'claim:' + id], ['SCARD', 'share:' + id]]));
  const taken = [];
  const shared = {};
  IDS.forEach((id, i) => {
    if (out[2 * i]) taken.push(id);
    else if (out[2 * i + 1]) shared[id] = out[2 * i + 1];
  });
  return { taken, shared };
}

const cleanName = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The giver's email is only used to ask Faith for her delivery details; it goes in her notification and is not stored.
const cleanEmail = (v) => (typeof v === 'string' && v.length <= 120 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(v.trim()) ? v.trim() : '');

const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');

// Retro arcade email: table layout and inline styles so it survives email clients.
function emailHtml({ heading, kicker, rows, footer, button }) {
  const mono = "'Courier New',Courier,monospace";
  const row = ([k, v]) =>
    `<tr><td style="padding:10px 14px;border-bottom:2px dashed #B9C8F5;font:bold 12px ${mono};color:#14215E;text-transform:uppercase;white-space:nowrap">${k}</td>` +
    `<td style="padding:10px 14px;border-bottom:2px dashed #B9C8F5;font:bold 16px Arial,Helvetica,sans-serif;color:#111111;text-align:right">${v}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#5C94FC">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#5C94FC"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border:4px solid #000000">
  <tr><td style="background:#000000;padding:12px 16px;font:bold 13px ${mono};color:#FFFFFF;letter-spacing:1px;text-transform:uppercase">World 1-1: Wish Quest</td></tr>
  <tr><td align="center" style="padding:26px 20px 6px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" width="64" height="64" style="background:#FAC000;border:4px solid #000000;font:bold 34px ${mono};color:#7C2800">?</td></tr></table>
  </td></tr>
  <tr><td align="center" style="padding:12px 20px 0;font:bold 12px ${mono};color:#E52521;letter-spacing:1px;text-transform:uppercase">${kicker}</td></tr>
  <tr><td align="center" style="padding:8px 20px 18px;font:bold 22px ${mono};color:#111111;text-transform:uppercase">${heading}</td></tr>
  <tr><td style="padding:0 18px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:3px solid #000000;background:#F4F7FF">${rows.map(row).join('')}</table></td></tr>
  ${button ? `<tr><td align="center" style="padding:0 20px 20px"><a href="${esc(button.href)}" style="display:inline-block;padding:14px 18px;background:#00A800;border:4px solid #000000;font:bold 13px ${mono};color:#FFFFFF;text-decoration:none;text-transform:uppercase;letter-spacing:1px">${button.label}</a></td></tr>` : ''}
  <tr><td style="padding:0 20px 22px;font:14px Arial,Helvetica,sans-serif;color:#14215E;text-align:center">${footer}</td></tr>
  <tr><td height="26" style="background:#C84C0C;border-top:4px solid #000000;font-size:0;line-height:0">&nbsp;</td></tr>
</table></td></tr></table></body></html>`;
}

async function notify(kind, id, amount, name, email) {
  if (!RESEND_KEY) return false;
  try {
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
    let subject, html;
    const from = ['From', name ? esc(name) : 'Anonymous'];
    if (kind === 'take') {
      const what = labelOf(id);
      subject = 'Wish taken: ' + what + (name ? ' (from ' + name + ')' : '') + (email ? ' — wants your delivery details' : '');
      const reply = email ? deliveryReply(email, name, what) : '';
      html = emailHtml({
        kicker: 'someone\'s on it',
        heading: 'Wish grabbed!',
        rows: [
          ['Wish', esc(what)],
          from,
          ...(id === 'flight' ? [] : [['Delivery', email ? 'Send details to ' + esc(email) : 'Already has your address']]),
          ['When', when + ' (Lagos)'],
        ],
        footer:
          (name
            ? esc(name) + ' tapped "I\'m getting this" and chose to tell you.'
            : 'Someone tapped "I\'m getting this" and chose to stay anonymous — it\'s a surprise.') +
          (email
            ? '<br><br><b>They asked for your delivery details.</b> ' +
              (reply
                ? 'Tap the button to open a reply to ' + esc(email) + ' with your details already filled in, then press Send. Or just reply to this email.'
                : 'Reply to this email to send your address to ' + esc(email) + '.')
            : ''),
        button: reply ? { href: reply, label: 'Reply with delivery details' } : null,
      });
    } else {
      const [vals, count] = await redis([['HVALS', 'amt:' + id], ['SCARD', 'share:' + id]]);
      const total = (vals || []).reduce((s, v) => s + (parseInt(v, 10) || 0), 0);
      const added = kind === 'share';
      const cash = OPEN_ONLY.has(id);
      const noun = cash ? 'cash gift' : 'chip-in';
      subject = (added ? 'New ' + noun + ': ' : (cash ? 'Cash gift' : 'Chip-in') + ' withdrawn: ') + naira(amount) + (cash ? '' : ' for ' + WISH[id]);
      html = emailHtml({
        kicker: added ? '+1 coin' : 'Coin returned',
        heading: added ? 'New ' + noun + '!' : (cash ? 'Cash gift' : 'Chip-in') + ' withdrawn',
        rows: [
          ['Wish', WISH[id]],
          from,
          [added ? 'Amount pledged' : 'Amount withdrawn', naira(amount)],
          [cash ? 'Cash gifts so far' : 'Players chipping in', String(count)],
          ['Total pledged so far', naira(total)],
          ['When', when + ' (Lagos)'],
        ],
        footer: added
          ? (name ? esc(name) : 'Someone') + ' tapped ' + (cash ? 'Send a cash gift' : 'Chip in') + ' and was shown your account details. ' +
            (name ? 'Check' : 'They chose to stay anonymous, so check') + ' your bank alerts for the transfer.'
          : 'Someone undid their ' + noun + ' on this wish.',
      });
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [MAIL_TO], subject, html, ...(email ? { reply_to: email } : {}) }),
    });
    clearTimeout(timer);
    if (!r.ok) console.error('notify failed', r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error('notify error', e && e.message);
    return false;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: 'storage not configured' });
  try {
    if (req.method === 'GET') return res.status(200).json(await snapshot());
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { id, action, token, key } = body;
    if (!IDS.includes(id)) return res.status(400).json({ error: 'unknown item' });

    let status = 200;
    const extra = {};
    if (action === 'reset') {
      if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
      await redis([['DEL', 'claim:' + id, 'share:' + id, 'amt:' + id, 'who:' + id]]);
    } else {
      if (typeof token !== 'string' || !/^[\w-]{16,64}$/.test(token)) return res.status(400).json({ error: 'bad token' });
      const name = cleanName(body.name);
      if (action === 'take') {
        if (OPEN_ONLY.has(id)) return res.status(400).json({ error: 'not claimable' });
        const [sharers] = await redis([['SCARD', 'share:' + id]]);
        if (sharers) status = 409;
        else {
          const [ok] = await redis([['SET', 'claim:' + id, token, 'NX']]);
          if (ok !== 'OK') status = 409;
          else {
            if (name) await redis([['HSET', 'who:' + id, token, name]]);
            const email = id === 'flight' ? '' : cleanEmail(body.email);
            const sent = await notify('take', id, 0, name, email);
            if (email && !sent) extra.delivery = 'failed';
          }
        }
      } else if (action === 'share') {
        if (!SHAREABLE.has(id)) return res.status(400).json({ error: 'not shareable' });
        const amount = Math.floor(Number(body.amount));
        if (!Number.isFinite(amount) || amount < 100 || amount > 50000000) return res.status(400).json({ error: 'bad amount' });
        const [taken] = await redis([['EXISTS', 'claim:' + id]]);
        if (taken) status = 409;
        else {
          await redis([['SADD', 'share:' + id, token], ['HSET', 'amt:' + id, token, String(amount)], name ? ['HSET', 'who:' + id, token, name] : ['HDEL', 'who:' + id, token]]);
          extra.account = ACCOUNT;
          extra.amount = amount;
          await notify('share', id, amount, name);
        }
      } else if (action === 'account') {
        const [member, amt] = await redis([['SISMEMBER', 'share:' + id, token], ['HGET', 'amt:' + id, token]]);
        if (!member) return res.status(403).json({ error: 'forbidden' });
        extra.account = ACCOUNT;
        extra.amount = parseInt(amt, 10) || 0;
      } else if (action === 'undo') {
        const [cur, amt, who] = await redis([['GET', 'claim:' + id], ['HGET', 'amt:' + id, token], ['HGET', 'who:' + id, token]]);
        if (cur === token) await redis([['DEL', 'claim:' + id], ['HDEL', 'who:' + id, token]]);
        else {
          const [removed] = await redis([['SREM', 'share:' + id, token], ['HDEL', 'amt:' + id, token], ['HDEL', 'who:' + id, token]]);
          if (removed) await notify('undo', id, parseInt(amt, 10) || 0, who || '');
        }
      } else {
        return res.status(400).json({ error: 'unknown action' });
      }
    }
    return res.status(status).json({ ok: status === 200, ...extra, ...(await snapshot()) });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
