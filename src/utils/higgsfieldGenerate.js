import { getHFToken, refreshHFToken } from './higgsfieldAuth'

const MCP_URL = '/api/hf/mcp'
const PENDING_KEY = 'hf_pending_gens'

let _sessionId = null

// Persistent media cache — survives page reloads so reference images are never re-uploaded
const MEDIA_CACHE_KEY = 'hf_media_cache'
const _mediaCache = (() => {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(MEDIA_CACHE_KEY) || '{}'))) }
  catch { return new Map() }
})()
function _mediaCacheSave() {
  try { localStorage.setItem(MEDIA_CACHE_KEY, JSON.stringify(Object.fromEntries(_mediaCache))) }
  catch { /* quota full — cache in memory only */ }
}

function mediaFingerprint(dataUrl) {
  return `${dataUrl.length}:${dataUrl.slice(0, 48)}:${dataUrl.slice(-24)}`
}

// ── Pending generation persistence ──────────────────────────────
export function savePendingGen(influencerId, slot, jobIds) {
  const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
  const filtered = list.filter(j => !(j.influencerId === influencerId && j.slot === slot))
  filtered.push({ influencerId, slot, jobIds, startedAt: Date.now() })
  localStorage.setItem(PENDING_KEY, JSON.stringify(filtered))
}

export function clearPendingGen(influencerId, slot) {
  const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
  localStorage.setItem(PENDING_KEY, JSON.stringify(
    list.filter(j => !(j.influencerId === influencerId && j.slot === slot))
  ))
}

export function getPendingGens() {
  return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
}

async function mcpPost(body, isRetry = false) {
  const token = getHFToken()
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
  }
  if (_sessionId) headers['Mcp-Session-Id'] = _sessionId

  let res
  try {
    res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch {
    throw new Error('Connection error — check your internet connection or reconnect Higgsfield in Settings')
  }

  if (res.status === 401) {
    if (isRetry) throw new Error('Higgsfield session expired — please reconnect in Settings')
    try {
      await refreshHFToken()
      _sessionId = null // force new session with fresh token
      return mcpPost(body, true)
    } catch {
      throw new Error('Higgsfield session expired — please reconnect in Settings')
    }
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Higgsfield API error ${res.status}: ${errText}`)
  }

  const sid = res.headers.get('Mcp-Session-Id')
  if (sid) _sessionId = sid

  const ct = res.headers.get('content-type') || ''
  console.log('[HF] content-type:', ct)

  // Stream SSE responses in real-time so we don't wait for the server to close
  // the stream — video generate_video calls can hold the stream open for minutes
  if (ct.includes('text/event-stream')) {
    return parseSSEStream(res)
  }

  const rawText = await res.text()
  console.log('[HF] raw body:', rawText.slice(0, 600))
  if (rawText.trimStart().startsWith('data:')) return parseSSEText(rawText)
  try { return JSON.parse(rawText) } catch { return rawText }
}

function parseSSEText(text) {
  let resultEvent = null
  let lastNonNull = null
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const raw = trimmed.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    try {
      const d = JSON.parse(raw)
      if (d !== null) {
        lastNonNull = d
        if (d.result !== undefined) resultEvent = d
      }
    } catch {}
  }
  return resultEvent ?? lastNonNull
}

// Stream SSE events in real-time — returns as soon as the first result event arrives,
// without waiting for the server to close the stream (which can take minutes for video jobs)
async function parseSSEStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastNonNull = null
  let resultEvent = null
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const raw = trimmed.slice(5).trim()
        if (!raw || raw === '[DONE]') continue
        try {
          const d = JSON.parse(raw)
          if (d !== null) {
            lastNonNull = d
            if (d.result !== undefined) {
              resultEvent = d
              reader.cancel().catch(() => {})
              return resultEvent
            }
          }
        } catch {}
      }
    }
  } catch {
    if (resultEvent) return resultEvent
  }
  return resultEvent ?? lastNonNull
}

export async function initSession() {
  _sessionId = null
  await mcpPost({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'AI Influencer Studio', version: '1.0' },
    },
  })
}

async function callTool(name, args) {
  const res = await mcpPost({
    jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
    params: { name, arguments: args },
  })
  const result = res?.result ?? res
  console.log(`[HF] callTool(${name}) =>`, JSON.stringify(result)?.slice(0, 500))
  return result
}

function unwrapMCP(result) {
  if (!result?.content) return result
  for (const item of result.content) {
    if (item.text) {
      try { return JSON.parse(item.text) } catch { return item.text }
    }
  }
  return result
}

function extractJobIds(result) {
  const data = unwrapMCP(result)

  if (typeof data === 'object' && data !== null) {
    if (Array.isArray(data.results)) {
      const ids = data.results.map(r => r?.id || r?.job_id).filter(id => id?.length >= 8)
      if (ids.length) return ids
    }
    if (data.job_id) return [data.job_id]
    if (data.jobId) return [data.jobId]
    if (typeof data.id === 'string' && data.id.length >= 8) return [data.id]
  }

  // Plain-text response: extract UUIDs embedded in the description
  const str = typeof data === 'string' ? data : JSON.stringify(data ?? '')
  const uuids = str.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []
  console.log('[HF] extracted UUIDs from text:', uuids)
  return [...new Set(uuids)]
}

function extractVideoUrls(result) {
  const data = unwrapMCP(result)
  // Structured path — rawUrl / minUrl are CDN video links (no extension filter needed)
  if (Array.isArray(data?.results)) {
    const urls = data.results
      .map(r => r?.results?.rawUrl || r?.results?.minUrl || r?.result_url)
      .filter(Boolean)
    if (urls.length) return [...new Set(urls)]
  }
  // Plain-text fallback — scan for video extensions
  const str = typeof data === 'string' ? data : JSON.stringify(data)
  const raw = str.match(/https:\/\/[^\s"\\]+\.(?:mp4|webm|mov)(?:[^\s"\\]*)?/g) || []
  return [...new Set(raw.map(u => u.replace(/[\\}"']+$/, '')))]
}

async function pollVideoJobs(jobIds, total, onProgress, onPartialResults, isCancelled) {
  let lastPartialCount = 0
  for (let i = 0; i < 360; i++) { // 360 × 1.5s = 9 minutes max
    if (isCancelled?.()) throw new Error('CANCELLED')
    if (i > 0) await new Promise(r => setTimeout(r, 1500))
    if (isCancelled?.()) throw new Error('CANCELLED')
    try {
      const display = await callTool('job_display', { ids: jobIds })
      const urls = extractVideoUrls(display)
      const terminal = countTerminalJobs(display)
      console.log(`[HF] video poll ${i} → ${urls.length} URLs, ${terminal}/${total} terminal`)
      onProgress?.(Math.min(35 + (urls.length / total) * 60, 95))
      // Fire partial results callback whenever new URLs arrive
      if (urls.length > lastPartialCount) {
        lastPartialCount = urls.length
        onPartialResults?.(urls.slice(0, total))
      }
      if (urls.length >= total) return urls.slice(0, total)
      if (terminal >= total) {
        if (urls.length > 0) return urls.slice(0, total)
        throw new Error('Video generation failed — all jobs ended without output')
      }
    } catch (e) {
      if (e.message.includes('failed')) throw e
      console.warn('[HF] video poll error:', e.message)
    }
  }
  throw new Error('Video generation timed out — check Higgsfield dashboard')
}

async function uploadAudioFile(dataUrl) {
  const fp = mediaFingerprint(dataUrl)
  if (_mediaCache.has(fp)) return _mediaCache.get(fp)

  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const contentType = blob.type || 'audio/mpeg'
  const ext = contentType.includes('wav') ? 'wav' : contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a' : 'mp3'
  const filename = `audio_${Date.now()}.${ext}`

  const uploadResult = await callTool('media_upload', { method: 'upload_url', filename, content_type: contentType })
  const uploadData = unwrapMCP(uploadResult)

  const f0 = uploadData?.uploads?.[0] ?? uploadData?.files?.[0] ?? uploadData?.data?.[0]
  let uploadUrl = uploadData?.upload_url || uploadData?.url || f0?.upload_url || f0?.url
  let mediaId   = uploadData?.media_id  || uploadData?.id  || f0?.media_id  || f0?.id

  if (!uploadUrl || !mediaId) {
    const text = typeof uploadData === 'string' ? uploadData : JSON.stringify(uploadData ?? '')
    const uuids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []
    if (uuids.length) mediaId = uuids[0]
    const urlMatch = text.match(/https:\/\/[^\s"'\\]+/)
    if (urlMatch) uploadUrl = urlMatch[0]
  }
  if (!uploadUrl || !mediaId) throw new Error(`Audio upload failed — got: ${JSON.stringify(uploadData)?.slice(0, 200)}`)

  const putRes = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': contentType } })
  if (!putRes.ok) throw new Error(`Audio file upload failed: ${putRes.status}`)

  const confirmResult = await callTool('media_confirm', { media_id: mediaId, type: 'audio' })
  const confirmed = unwrapMCP(confirmResult)
  const cdnUrl = confirmed?.url || confirmed?.media_url || confirmed?.rawUrl || confirmed?.cdn_url || mediaId
  _mediaCache.set(fp, cdnUrl); _mediaCacheSave()
  return cdnUrl
}

export async function generateVideo({ prompt, aspectRatio = '9:16', duration = 8, count = 1, referenceImages = [], audioRef = null, model = 'seedance_2_0', resolution = '1080p', onProgress, onPartialResults, isCancelled }) {
  await initSession()
  onProgress?.(5)

  // Upload audio first (becomes @audio_1), then images (@image_1, @image_2, ...)
  const medias = []

  if (audioRef) {
    try {
      const audioId = await uploadAudioFile(audioRef)
      medias.push({ value: audioId, role: 'audio' })
    } catch (e) {
      console.warn('[HF] audio upload failed, skipping:', e.message)
    }
  }

  // Upload all reference images in parallel — order preserved for correct @image_N mapping
  const imageMedias = (await Promise.all(
    referenceImages.filter(Boolean).map(async imgDataUrl => {
      try {
        return { value: await uploadRefImage(imgDataUrl), role: 'image' }
      } catch (e) {
        console.warn('[HF] video ref upload failed, skipping:', e.message)
        return null
      }
    })
  )).filter(Boolean)
  medias.push(...imageMedias)

  const params = {
    model,
    prompt,
    aspect_ratio: aspectRatio,
    duration,
    resolution,
    mode: 'std',
  }
  if (medias.length) params.medias = medias
  onProgress?.(25)

  // Higgsfield video API generates 1 per call — fire N sequential requests for count > 1
  // (parallel calls conflict over the shared MCP session)
  const results = []
  for (let i = 0; i < count; i++) {
    results.push(await callTool('generate_video', { params }))
  }
  onProgress?.(30)

  const directUrls = results.flatMap(r => extractVideoUrls(r))
  if (directUrls.length >= count) { onProgress?.(100); return directUrls.slice(0, count) }

  const jobIds = results.flatMap(r => extractJobIds(r)).filter(Boolean)
  if (!jobIds.length) throw new Error(`No job IDs returned. Response: ${JSON.stringify(unwrapMCP(results[0]))?.slice(0, 300)}`)

  const urls = await pollVideoJobs(jobIds, count, onProgress, onPartialResults, isCancelled)
  onProgress?.(100)
  return urls.slice(0, count)
}

function extractImageUrls(result) {
  const data = unwrapMCP(result)

  // Structured: results[].results.rawUrl  (job_display format)
  if (Array.isArray(data?.results)) {
    const urls = data.results
      .map(r => r?.results?.rawUrl || r?.results?.minUrl || r?.result_url)
      .filter(Boolean)
    if (urls.length) return [...new Set(urls)]
  }

  // Fallback: regex scan for any https image URL
  const str = typeof data === 'string' ? data : JSON.stringify(data)
  const raw = str.match(/https:\/\/[^\s"\\]+\.(?:jpg|jpeg|png|webp)(?:[^\s"\\]*)?/g) || []
  return [...new Set(raw.map(u => u.replace(/[\\}"']+$/, '')))]
}

function countTerminalJobs(result) {
  const data = unwrapMCP(result)
  if (!Array.isArray(data?.results)) return 0
  return data.results.filter(r => {
    if (r?.results?.rawUrl || r?.results?.minUrl || r?.result_url) return true
    const s = (r?.status || r?.job_status || '').toLowerCase()
    return ['done', 'completed', 'failed', 'error', 'nsfw', 'content_filtered', 'rejected', 'cancelled'].includes(s)
  }).length
}

// When the user's style ref note mentions pose or scene/location, replace those text prompt
// sections with a direct reference to the style image so the text no longer fights the image.
function applyStyleNoteOverrides(prompts, styleNote, styleImg) {
  if (!styleNote) return prompts
  const note = styleNote.toLowerCase()

  const wantsPose  = /\bpose\b|posing/.test(note)
  const wantsScene = /alley|location|scene|background|setting|café|cafe|park|rooftop|studio|hallway|corridor|street|outdoor|indoor|beach|forest|city|room|bar|restaurant|environment/.test(note)

  if (!wantsPose && !wantsScene) return prompts

  return prompts.map(p => {
    if (wantsPose)
      p = p.replace(
        /(\n\nPose: )[\s\S]+?(\n\nWardrobe & details:)/,
        `$1Follow ${styleImg} for the pose and body positioning.$2`
      )
    if (wantsScene) {
      p = p.replace(
        /(\n\nScene: )[\s\S]+?(\n\nSubject:)/,
        `$1Follow ${styleImg} for the location, background, and setting.$2`
      )
      p = p.replace(
        /(\n\nLighting: )[\s\S]+?(\n\nCamera & capture:)/,
        `$1Follow ${styleImg} for the lighting conditions and mood.$2`
      )
    }
    return p
  })
}

// Poll all jobs together in one job_display call.
// total = number of images we expect (prompts.length), used for termination — not jobIds.length,
// which can be inflated when Soul responses contain extra UUIDs.
export async function pollAllJobs(jobIds, total, onProgress, staleTolerance = 8) {
  let lastResponse = null
  let lastUrlCount = 0
  let stalePolls = 0

  for (let i = 0; i < 100; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 2500))
    try {
      const display = await callTool('job_display', { ids: jobIds })
      lastResponse = display
      const urls = extractImageUrls(display)
      const terminal = countTerminalJobs(display)
      console.log(`[HF] poll ${i} → ${urls.length} URLs, ${terminal}/${total} terminal, stale=${stalePolls}`)
      onProgress?.(Math.min(22 + (urls.length / total) * 73, 95))

      // All URLs back — done
      if (urls.length >= total) return urls

      // All jobs terminal — return successes or throw if none
      if (terminal >= total) {
        if (urls.length > 0) return urls
        throw new Error('All generation jobs failed — try regenerating')
      }

      // Stale: have ≥1 URL but count hasn't grown — wait before accepting partial results
      if (urls.length > lastUrlCount) { lastUrlCount = urls.length; stalePolls = 0 }
      else if (urls.length > 0) stalePolls++
      if (stalePolls >= staleTolerance) {
        console.warn(`[HF] stale after ${staleTolerance} polls — returning partial results`)
        return urls
      }
    } catch (e) {
      if (e.message.includes('All generation jobs failed')) throw e
      console.warn(`[HF] poll ${i} error:`, e.message)
    }
  }

  const partialUrls = lastResponse ? extractImageUrls(lastResponse) : []
  if (partialUrls.length > 0) return partialUrls
  console.error('[HF] timed out. Last display response:', JSON.stringify(lastResponse)?.slice(0, 400))
  throw new Error('Generation timed out — check browser console for details')
}

async function uploadRefImage(dataUrl) {
  const fp = mediaFingerprint(dataUrl)
  if (_mediaCache.has(fp)) {
    console.log('[HF] media cache hit — skipping upload')
    return _mediaCache.get(fp)
  }

  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const contentType = blob.type || 'image/jpeg'
  const ext = contentType.includes('png') ? 'png' : 'jpeg'
  const filename = `ref_${Date.now()}.${ext}`

  const uploadResult = await callTool('media_upload', { method: 'upload_url', filename, content_type: contentType })
  const uploadData = unwrapMCP(uploadResult)
  console.log('[HF] media_upload raw:', JSON.stringify(uploadData)?.slice(0, 500))

  // Real response shape: { uploads: [{ upload_url, media_id, url }] }
  const f0 = uploadData?.uploads?.[0] ?? uploadData?.files?.[0] ?? uploadData?.data?.[0]
  let uploadUrl = uploadData?.upload_url || uploadData?.url || f0?.upload_url || f0?.url
  let mediaId   = uploadData?.media_id  || uploadData?.id  || f0?.media_id  || f0?.id

  // Response is plain text (curl instructions) — extract via regex
  if (!uploadUrl || !mediaId) {
    const text = typeof uploadData === 'string' ? uploadData : JSON.stringify(uploadData ?? '')
    const uuids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []
    if (uuids.length) mediaId = uuids[0]
    const urlMatch = text.match(/https:\/\/[^\s"'\\]+/)
    if (urlMatch) uploadUrl = urlMatch[0]
  }

  if (!uploadUrl || !mediaId) {
    const debug = JSON.stringify(uploadData)?.slice(0, 300) ?? 'null'
    throw new Error(`media_upload failed — got: ${debug}`)
  }

  const putRes = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': contentType } })
  if (!putRes.ok) throw new Error(`Reference image upload failed: ${putRes.status}`)

  const confirmResult = await callTool('media_confirm', { media_id: mediaId, type: 'image' })
  const confirmed = unwrapMCP(confirmResult)
  console.log('[HF] media_confirm raw:', JSON.stringify(confirmed)?.slice(0, 500))

  // Structured response
  const cdnUrl = confirmed?.url || confirmed?.media_url || confirmed?.rawUrl || confirmed?.cdn_url
  if (cdnUrl) { _mediaCache.set(fp, cdnUrl); _mediaCacheSave(); return cdnUrl }

  // Text response — extract URL or fall back to media_id
  if (typeof confirmed === 'string') {
    const urlMatch = confirmed.match(/https:\/\/[^\s"'\\]+/)
    if (urlMatch) { _mediaCache.set(fp, urlMatch[0]); _mediaCacheSave(); return urlMatch[0] }
  }

  const fallback = confirmed?.media_id || confirmed?.id || mediaId
  _mediaCache.set(fp, fallback); _mediaCacheSave()
  return fallback
}

function modelBaseParams(model, aspectRatio) {
  if (model === 'soul_2') return { model, aspect_ratio: aspectRatio, quality: '2k' }
  if (model === 'gpt_image_2') return { model, aspect_ratio: aspectRatio, count: 1, quality: 'high', resolution: '2k' }
  return { model, aspect_ratio: aspectRatio, count: 1, resolution: '2k' }
}

export async function generateThreeImages({ prompts, aspectRatio = '9:16', model = 'gpt_image_2', faceRef = null, styleRef = null, physicalDesc = '', faceRefNote = '', styleRefNote = '', onProgress }) {
  await initSession()
  onProgress?.(5)

  const medias = []
  let refInstruction = ''

  if (faceRef) {
    console.log('[HF] uploading face reference...')
    medias.push({ value: await uploadRefImage(faceRef), role: 'image' })
    onProgress?.(12)
  }
  if (styleRef) {
    console.log('[HF] uploading style reference...')
    medias.push({ value: await uploadRefImage(styleRef), role: 'image' })
    onProgress?.(15)
  }

  const hasDesc = !!(physicalDesc?.trim())
  const faceNote = faceRefNote?.trim()
  const styleNote = styleRefNote?.trim()

  // Build face instruction — user note takes priority; falls back to note-free defaults
  function buildFaceInstruction(imgTag) {
    if (faceNote)
      return `${imgTag}: use specifically "${faceNote}" from this reference.${hasDesc ? ' Use the text description for all other identity attributes.' : ''}`
    return hasDesc
      ? `${imgTag} is a facial geometry reference — match the face proportions (eye spacing, jaw width, nose bridge, face shape) but defer to the text description for skin tone, hair, eye color, and identity. Ignore ${imgTag}'s clothing, background, and lighting.`
      : `${imgTag} is the appearance reference — faithfully recreate this person's face, skin tone, hair, eye color, and overall look exactly as shown.`
  }

  // Build style instruction — user note takes priority; falls back to full extraction list
  function buildStyleInstruction(imgTag) {
    if (styleNote)
      return `${imgTag}: use specifically "${styleNote}" from this reference. Do not copy the face or identity of any person in ${imgTag}.`
    return `${imgTag} is a visual style reference — do NOT copy the face or identity of any person in ${imgTag}. Match the pose and body positioning, outfit aesthetic (silhouette, layering, fabric, styling), color palette, scene and background, lighting mood, and overall photographic vibe.`
  }

  if (faceRef && styleRef) {
    refInstruction = ` ${buildFaceInstruction('@image1')} ${buildStyleInstruction('@image2')}`
  } else if (faceRef) {
    refInstruction = ` ${buildFaceInstruction('@image1')}`
  } else if (styleRef) {
    refInstruction = ` ${buildStyleInstruction('@image1')} The subject's face and identity come entirely from the text description above.`
  }

  const baseParams = modelBaseParams(model, aspectRatio)
  if (medias.length) baseParams.medias = medias

  // If the style note targets pose or scene/location, replace those text sections
  // so the detailed text descriptions no longer fight the style image reference
  const styleImg = (faceRef && styleRef) ? '@image2' : '@image1'
  const finalPrompts = styleRef ? applyStyleNoteOverrides(prompts, styleNote, styleImg) : prompts

  async function launchAndCollect(promptList) {
    const results = await Promise.all(
      promptList.map(prompt => callTool('generate_image', { params: { ...baseParams, prompt: prompt + refInstruction } }))
    )
    const directUrls = results.flatMap(r => extractImageUrls(r))
    if (directUrls.length >= promptList.length) return { urls: directUrls, jobIds: [] }
    // Take exactly 1 job ID per generate_image call — Soul responses often embed extra UUIDs
    // in descriptive text, which would inflate jobIds and break terminal counting
    const jobIds = results.map(r => extractJobIds(r)[0]).filter(Boolean)
    return { urls: directUrls, jobIds }
  }

  const { urls: directUrls, jobIds } = await launchAndCollect(finalPrompts)
  onProgress?.(22)

  if (directUrls.length >= finalPrompts.length) { onProgress?.(100); return directUrls.slice(0, finalPrompts.length) }

  if (!jobIds.length) throw new Error(`No job IDs found. Check browser console for details.`)
  console.log('[HF] job IDs:', jobIds)

  // With refs, generation takes ~60s longer and variance between jobs is higher
  const hasRef = !!(faceRef || styleRef)
  const staleTolerance = model === 'soul_2'
    ? (hasRef ? 30 : 20)   // Soul: 75s / 50s stale window
    : (hasRef ? 16 : 8)    // Others: 40s / 20s stale window
  const urls = await pollAllJobs(jobIds, finalPrompts.length, onProgress, staleTolerance)

  if (urls.length === 0) throw new Error('No images were generated — try regenerating')
  if (urls.length < finalPrompts.length) {
    console.warn(`[HF] got ${urls.length}/${finalPrompts.length} — returning partial results`)
  }

  onProgress?.(100)
  return urls.slice(0, prompts.length)
}

export async function generateImages({ prompt, count = 3, aspectRatio = '9:16', referenceImage = null, onProgress }) {
  await initSession()
  onProgress?.(10)

  const params = { model: 'gpt_image_2', prompt, aspect_ratio: aspectRatio, count, quality: 'high', resolution: '4k' }
  if (referenceImage && referenceImage.startsWith('http')) {
    params.medias = [{ value: referenceImage, role: 'image' }]
  }

  const result = await callTool('generate_image', { params })
  onProgress?.(20)

  const directUrls = extractImageUrls(result)
  if (directUrls.length > 0) { onProgress?.(100); return directUrls }

  const jobIds = extractJobIds(result)
  console.log('[HF] job IDs to poll:', jobIds)
  if (!jobIds.length) {
    throw new Error(`No job IDs found. Response: ${JSON.stringify(unwrapMCP(result))?.slice(0, 300)}`)
  }

  const allUrls = await pollAllJobs(jobIds, count, onProgress)
  onProgress?.(100)
  return allUrls
}

// Single image generation — uploads base64 ref images properly before generating
export async function generateSingleImage({ prompt, aspectRatio = '16:9', referenceImage = null, onProgress, pendingKey = null }) {
  await initSession()
  onProgress?.(5)

  const params = { ...modelBaseParams('gpt_image_2', aspectRatio), prompt, resolution: '4k' }

  if (referenceImage) {
    try {
      console.log('[HF] uploading face reference...')
      const mediaId = await uploadRefImage(referenceImage)
      params.medias = [{ value: mediaId, role: 'image' }]
      onProgress?.(18)
    } catch (e) {
      console.warn('[HF] reference upload failed, generating without it:', e.message)
      // Continue — generation runs without face lock
    }
  }

  onProgress?.(20)
  const result = await callTool('generate_image', { params })

  const directUrls = extractImageUrls(result)
  if (directUrls.length > 0) { onProgress?.(100); return directUrls[0] }

  const jobIds = extractJobIds(result)
  if (!jobIds.length) throw new Error(`No job IDs found. Response: ${JSON.stringify(unwrapMCP(result))?.slice(0, 300)}`)

  if (pendingKey) savePendingGen(pendingKey.influencerId, pendingKey.slot, jobIds)
  try {
    const urls = await pollAllJobs(jobIds, 1, onProgress)
    onProgress?.(100)
    return urls[0] ?? null
  } finally {
    if (pendingKey) clearPendingGen(pendingKey.influencerId, pendingKey.slot)
  }
}
