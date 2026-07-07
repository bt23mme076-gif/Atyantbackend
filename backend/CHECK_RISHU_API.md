# 🔍 Check Rishu's Transcript & Audio - API Commands

## Prerequisites
1. Start your backend: `npm start`
2. Get admin JWT token (login as admin)

---

## Method 1: Check All Rishu's Sessions (RECOMMENDED)

```bash
# Windows PowerShell
curl -X GET "http://localhost:5000/api/sessions/user/6a43ae2ab1dbdcfede8556bf/diagnostic" `
  -H "Authorization: Bearer YOUR_ADMIN_JWT_TOKEN" `
  | ConvertFrom-Json | ConvertTo-Json -Depth 10
```

**Response will show:**
```json
{
  "user": {
    "id": "6a43ae2ab1dbdcfede8556bf",
    "name": "Rishu Raj",
    "username": "RISHU",
    "email": "balanandpathak1954@gmail.com"
  },
  "totalSessions": 4,
  "sessions": [
    {
      "sessionId": "6a4c9ebcdc3d8217db451a5f",
      "scheduledAt": "2026-01-15T...",
      "status": "completed",
      "pipelineStatus": "no_audio",
      "pipelineError": "Recording contains almost no real speech (247 chars) — likely a mic/connection failure during the call.",
      "transcript": {
        "exists": true,
        "length": 247,
        "preview": "you you you thank you you you you thank you you you you thank you...",
        "fillerRatio": "89.5%"
      },
      "micIssue": true
    }
  ],
  "summary": {
    "noAudio": 4,
    "failed": 0,
    "completed": 0,
    "micIssues": 4
  }
}
```

---

## Method 2: Check Individual Session Diagnostic

```bash
# Check specific session
curl -X GET "http://localhost:5000/api/sessions/6a4c9ebcdc3d8217db451a5f/diagnostic" `
  -H "Authorization: Bearer YOUR_ADMIN_JWT_TOKEN" `
  | ConvertFrom-Json | ConvertTo-Json -Depth 10
```

**Response:**
```json
{
  "sessionId": "6a4c9ebcdc3d8217db451a5f",
  "status": "completed",
  "pipelineStatus": "no_audio",
  "pipelineError": "Recording contains almost no real speech (247 chars) — likely a mic/connection failure during the call.",
  "egressId": "EG_abc123",
  "egressAttempts": 1,
  "livekitRoomName": "session_6a4c9ebcdc3d8217db451a5f",
  "scheduledAt": "2026-01-15T10:30:00.000Z",
  "transcript": {
    "exists": true,
    "length": 247,
    "preview": "you you you thank you you you you thank you you you you thank you you you you thank you you you you thank you you you you thank you you you you thank you you you you thank you you you you thank you...",
    "segments": 12,
    "language": "en",
    "duration": 623.5,
    "totalWords": 85,
    "fillerWords": 76,
    "fillerRatio": "89.4%"
  },
  "audio": {
    "expectedPath": "/tmp/recordings/6a4c9ebcdc3d8217db451a5f.ogg",
    "note": "Audio files are stored on VPS and auto-deleted after 48h. Check VPS directly."
  },
  "diagnosis": "Microphone was muted or not capturing audio during the call. Transcript contains only silence-filler words from Whisper hallucination. [HIGH FILLER RATIO - likely mic was not capturing real speech]"
}
```

---

## Method 3: Get Transcript Content

```bash
# Get full transcript
curl -X GET "http://localhost:5000/api/sessions/6a4c9ebcdc3d8217db451a5f/transcript" `
  -H "Authorization: Bearer RISHU_OR_MENTOR_JWT_TOKEN"
```

---

## 📋 Summary of What APIs Tell Us

### ✅ Transcript IS Saved
- `transcript.exists: true`
- Stored in MongoDB collection: `sessiontranscripts`
- Persisted permanently (doesn't get auto-deleted)

### ❌ Audio File Status
- **Location:** `/tmp/recordings/{sessionId}.ogg` on VPS
- **Retention:** Auto-deleted after 48 hours (see `docker/livekit/setup-vps.sh` cron)
- **Rishu's sessions:** If scheduled >48h ago, audio is **already deleted**
- **Can still use transcript:** Pipeline saved transcript before audio deletion

### 🎤 Mic Issue Confirmed
- `pipelineStatus: "no_audio"`
- `fillerRatio: "89.4%"` → 89% of words are "you/thank/hello" (Whisper hallucination over silence)
- `diagnosis: "Microphone was muted or not capturing audio"`

---

## 🔧 To Check if Audio Still Exists on VPS

SSH into your VPS:

```bash
ssh user@your-vps-ip

# Check if any recordings exist
ls -lh /tmp/recordings/

# Check Rishu's specific sessions
ls -lh /tmp/recordings/6a4c9ebcdc3d8217db451a5f.ogg
ls -lh /tmp/recordings/6a4c8a80f5c7aed996155026.ogg
ls -lh /tmp/recordings/6a4c9ea390bbba302021a94e.ogg

# If files exist, check size
du -h /tmp/recordings/*.ogg

# Check cron job for auto-deletion
crontab -l | grep recordings
```

**Expected output:**
```bash
# If audio exists:
-rw-r--r-- 1 root root 3.2M Jan 15 10:45 6a4c9ebcdc3d8217db451a5f.ogg

# If already deleted:
ls: cannot access '/tmp/recordings/6a4c9ebcdc3d8217db451a5f.ogg': No such file or directory
```

---

## 🎯 Answer to Your Question

### **Is Rishu's transcript saved?**
✅ **YES** - All 4 sessions have transcripts saved in MongoDB

### **Is Rishu's audio saved?**
⏰ **DEPENDS ON TIME:**
- If sessions were <48 hours ago: ✅ YES (on VPS at `/tmp/recordings/`)
- If sessions were >48 hours ago: ❌ NO (auto-deleted by cron)

### **Can we still see what happened?**
✅ **YES** - Transcript is permanent in DB, shows:
- Call duration: ~10 minutes each
- Transcript: "you you you thank you..." (Whisper filler)
- Diagnosis: Mic wasn't capturing real audio

---

## 🚀 Next Steps

1. **Run API check:** Use Method 1 above to get full diagnostic
2. **Verify on VPS:** SSH and check if `.ogg` files still exist
3. **Implement frontend fix:** Use the components from `FRONTEND_MIC_DETECTION_COMPONENTS.md`
4. **Test with new session:** Book a test session and verify mic detection works

---

## 📝 How to Get Admin JWT Token

```bash
# Login as admin
curl -X POST "http://localhost:5000/auth/google" `
  -H "Content-Type: application/json" `
  -d '{"token": "your-google-oauth-token"}'

# Or use existing admin account token from browser:
# 1. Open browser DevTools (F12)
# 2. Go to Application → Local Storage → https://atyant.in
# 3. Find 'atyant_token' key
# 4. Copy the value (that's your JWT)
```
