export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const token = process.env.HF_TOKEN
  if (!token) return res.status(500).json({ error: 'HF_TOKEN not configured on server' })

  let body
  try {
    body = req.body || await new Promise((resolve, reject) => {
      let data = ''
      req.on('data', c => data += c)
      req.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('Invalid JSON')) } })
      req.on('error', reject)
    })
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const { prompt } = body
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' })

  try {
    const upstream = await fetch(
      'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs: prompt }),
      }
    )

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      return res.status(upstream.status).json({ error: text.slice(0, 500) })
    }

    const arr = await upstream.arrayBuffer()
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg')
    res.status(200).end(Buffer.from(arr))
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Internal error' })
  }
}
