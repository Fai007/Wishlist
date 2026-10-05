// Shared "who's getting what" store for the wish list. No names are kept:
// a claim is just an item id plus a random token that lets the claimer undo it.
const WISH = ['tennis', 'watch', 'ipad', 'monitor', 'sun', 'body', 'flight', 'jewel', 'wig', 'suede'];
const SHAREABLE = new Set(['watch', 'ipad', 'monitor', 'flight', 'suede']);
const IDS = [
  ...WISH,
  ...Array.from({ length: 14 }, (_, i) => 'book-' + i),
  ...Array.from({ length: 5 }, (_, i) => 'shoe-' + i),
];

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_KEY = process.env.CLAIMS_ADMIN_KEY;

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
    if (action === 'reset') {
      if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
      await redis([['DEL', 'claim:' + id, 'share:' + id]]);
    } else {
      if (typeof token !== 'string' || !/^[\w-]{16,64}$/.test(token)) return res.status(400).json({ error: 'bad token' });
      if (action === 'take') {
        const [sharers] = await redis([['SCARD', 'share:' + id]]);
        if (sharers) status = 409;
        else {
          const [ok] = await redis([['SET', 'claim:' + id, token, 'NX']]);
          if (ok !== 'OK') status = 409;
        }
      } else if (action === 'share') {
        if (!SHAREABLE.has(id)) return res.status(400).json({ error: 'not shareable' });
        const [taken] = await redis([['EXISTS', 'claim:' + id]]);
        if (taken) status = 409;
        else await redis([['SADD', 'share:' + id, token]]);
      } else if (action === 'undo') {
        const [cur] = await redis([['GET', 'claim:' + id]]);
        if (cur === token) await redis([['DEL', 'claim:' + id]]);
        else await redis([['SREM', 'share:' + id, token]]);
      } else {
        return res.status(400).json({ error: 'unknown action' });
      }
    }
    return res.status(status).json({ ok: status === 200, ...(await snapshot()) });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
