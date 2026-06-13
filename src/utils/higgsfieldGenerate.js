async function hfGenerate(prompt) {
  const res = await fetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Generation failed: ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`)
  }

  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

// ── Pending generation persistence (kept for compatibility) ──────
const PENDING_KEY = 'hf_pending_gens'
const PENDING_VIDEO_KEY = 'hf_pending_videos'
const PENDING_PHOTO_KEY = 'hf_pending_photos_v2'
const PHOTO_SESSION_KEY = 'hf_photo_gen_session'

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

export function savePendingVideo(influencerId, jobIds, count) {
  const list = JSON.parse(localStorage.getItem(PENDING_VIDEO_KEY) || '[]')
  const next = list.filter(j => j.influencerId !== influencerId)
  next.push({ influencerId, jobIds, count, startedAt: Date.now() })
  localStorage.setItem(PENDING_VIDEO_KEY, JSON.stringify(next))
}

export function clearPendingVideo(influencerId) {
  const list = JSON.parse(localStorage.getItem(PENDING_VIDEO_KEY) || '[]')
  localStorage.setItem(PENDING_VIDEO_KEY, JSON.stringify(
    list.filter(j => j.influencerId !== influencerId)
  ))
}

export function getPendingVideo(influencerId) {
  const list = JSON.parse(localStorage.getItem(PENDING_VIDEO_KEY) || '[]')
  return list.find(j => j.influencerId === influencerId) || null
}

export function savePendingPhoto(influencerId, jobIds) {
  const list = JSON.parse(localStorage.getItem(PENDING_PHOTO_KEY) || '[]')
  const next = list.filter(j => j.influencerId !== influencerId)
  next.push({ influencerId, jobIds, startedAt: Date.now() })
  localStorage.setItem(PENDING_PHOTO_KEY, JSON.stringify(next))
}

export function clearPendingPhoto(influencerId) {
  const list = JSON.parse(localStorage.getItem(PENDING_PHOTO_KEY) || '[]')
  localStorage.setItem(PENDING_PHOTO_KEY, JSON.stringify(list.filter(j => j.influencerId !== influencerId)))
}

export function getPendingPhoto(influencerId) {
  const list = JSON.parse(localStorage.getItem(PENDING_PHOTO_KEY) || '[]')
  return list.find(j => j.influencerId === influencerId) || null
}

export function markPhotoGenSession() { try { sessionStorage.setItem(PHOTO_SESSION_KEY, '1') } catch {} }
export function hasPhotoGenSession()  { try { return !!sessionStorage.getItem(PHOTO_SESSION_KEY) } catch { return false } }

export async function resumeVideoJob(jobIds, count, onProgress, onPartialResults, isCancelled) {
  throw new Error('Video generation is not available with HuggingFace free API')
}

export async function initSession() {}

export async function pollAllJobs() {
  return []
}

// ── Image generation ──────────────────────────────────────────────

export async function generateThreeImages({ prompts, onProgress, onPartialResults }) {
  onProgress?.(5)
  const urls = []
  for (let i = 0; i < prompts.length; i++) {
    const url = await hfGenerate(prompts[i])
    urls.push(url)
    onProgress?.(22 + ((i + 1) / prompts.length) * 73)
    onPartialResults?.(urls.slice())
  }
  onProgress?.(100)
  return urls
}

export async function generateSingleImage({ prompt, onProgress, pendingKey, onJobIds, isCancelled }) {
  onProgress?.(5)
  const url = await hfGenerate(prompt)
  onProgress?.(100)
  return url
}

export async function generateNImages({ prompt, count = 1, onProgress, onResult, isCancelled, pendingKey }) {
  onProgress?.(5)
  const prompts = Array.isArray(prompt) ? prompt : Array.from({ length: count }, () => prompt)
  for (let i = 0; i < prompts.length; i++) {
    if (isCancelled?.()) throw new Error('CANCELLED')
    const url = await hfGenerate(prompts[i])
    onResult?.(url)
    onProgress?.(22 + ((i + 1) / count) * 73)
  }
  onProgress?.(100)
}

export async function generatePosePreviews(influencer, onPoseComplete, { stance = 'standing' } = {}) {
  const gender = influencer.gender === 'Male' ? 'man' : 'woman'
  const physDesc = (influencer.physicalDesc || '').trim()
  const subjectLine = physDesc ? `${gender}, ${physDesc}` : gender
  const POSE_IDS = ['plandid', 'candid', 'cute-posed', 'walking', 'mid-turn', 'front', 'hip-pop', 'triangle', 'over-shoulder', 'long-line', 'hands-pockets', 'crossed-arms', 'lean']
  const POSE_DESCS = {
    plandid: 'Body angled 25-30 degrees to camera, weight on back leg, relaxed candid look',
    candid: 'Mid-laugh, genuine joy, head slightly back, animated',
    'cute-posed': 'Three-quarter turn, warm smile, hand near face, approachable',
    walking: 'Mid-stride, relaxed arms, confident gaze forward',
    'mid-turn': 'Body turned 45 degrees away, head back over shoulder, soft smile',
    front: 'Squared to lens, hip shifted, confident direct gaze',
    'hip-pop': 'Weight on one leg, hand on hip, full body',
    triangle: '45 degrees to camera, arm at hip creating triangle gap',
    'over-shoulder': '50-60 degrees away, head back over shoulder, soft surprise',
    'long-line': 'Erect posture, one leg extended toward camera',
    'hands-pockets': '30-45 degrees, thumbs in pockets, relaxed',
    'crossed-arms': '30 degrees, arms crossed, chin slightly down',
    lean: 'Shoulder against wall, 60-70 degrees, relaxed',
  }

  for (const poseId of POSE_IDS) {
    const stancedId = `${stance}_${poseId}`
    const prompt = `${subjectLine}. Pure white seamless studio backdrop. Clean flat even lighting. ${POSE_DESCS[poseId]}. Photorealistic, 4K.`
    try {
      const url = await hfGenerate(prompt)
      onPoseComplete(stancedId, url)
    } catch (e) {
      console.warn(`[HF] pose preview failed (${stancedId}):`, e.message)
    }
  }
}

export async function generateVideo({ prompt, onProgress, onPartialResults, isCancelled }) {
  onProgress?.(5)
  const url = await hfGenerate(prompt)
  onProgress?.(100)
  return { urls: [url], shareUrls: [] }
}
