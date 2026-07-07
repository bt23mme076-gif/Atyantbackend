# 🔍 VPS Debugging Commands for Rishu's Audio Issue

## 1. Check if recordings exist on VPS
```bash
ssh your-vps
ls -lh /tmp/recordings/
```

Look for files matching Rishu's session IDs:
- `6a4c9ebcdc3d8217db451a5f.ogg`
- `6a4c8a80f5c7aed996155026.ogg`
- `6a4c9ea390bbba302021a94e.ogg`

## 2. Check file sizes (should be >1MB for a real 10+ min call)
```bash
du -h /tmp/recordings/*.ogg
```

If file is <100KB for a long call → audio never reached LiveKit

## 3. Check LiveKit egress logs
```bash
cd /path/to/livekit/docker
docker-compose logs egress | grep -A 20 "6a4c9ebcdc3d8217db451a5f"
```

Look for:
- `"Start signal not received"` → CPU/resource issue
- `"No active tracks"` → No one published audio
- `"Recording started"` → Egress worked, mic was the issue

## 4. Check LiveKit room logs
```bash
docker-compose logs livekit | grep "session_6a4c9ebcdc3d8217db451a5f"
```

Look for:
- `participant_joined` - Did Rishu join?
- `track_published` - Did his mic track publish?
- `track quality: 0` - Audio stream was silent/empty

## 5. Play the audio file to verify content
```bash
# Install ffmpeg if not present
apt install -y ffmpeg

# Check audio metadata
ffprobe /tmp/recordings/6a4c9ebcdc3d8217db451a5f.ogg

# Extract first 10 seconds and check waveform
ffmpeg -i /tmp/recordings/6a4c9ebcdc3d8217db451a5f.ogg -t 10 -filter_complex "showwavespic=s=1280x240" /tmp/wave.png

# Check if audio has actual amplitude (not silence)
ffmpeg -i /tmp/recordings/6a4c9ebcdc3d8217db451a5f.ogg -af volumedetect -f null - 2>&1 | grep mean_volume
```

If `mean_volume: -91.0 dB` or lower → effectively silence

## 6. Re-transcribe manually to verify Whisper output
```bash
# If you suspect Whisper failed, send the file again
curl -X POST https://api.groq.com/openai/v1/audio/transcriptions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -F "file=@/tmp/recordings/6a4c9ebcdc3d8217db451a5f.ogg" \
  -F "model=whisper-large-v3" \
  -F "response_format=verbose_json"
```

## 7. Check retention cron (recordings auto-delete after 48h)
```bash
crontab -l
# Should show: 0 */12 * * * find /tmp/recordings -name "*.ogg" -mtime +2 -delete
```

If recordings are already deleted → Can only use stored transcript from MongoDB

---

## Common Findings:

### ✅ Good Session (Audio Worked)
- File: 15-20 MB for 30 min call
- `track_published` events in logs
- `mean_volume: -25.0 dB` (clear speech)
- Whisper transcript: coherent sentences

### ❌ Mic Issue (What Rishu likely had)
- File: 2-5 MB for 30 min call (compressed silence)
- `track_published` events exist BUT...
- `mean_volume: -85.0 dB` (silence/background noise only)
- Whisper transcript: "you you you thank you hello"

### ❌ Egress Failure
- No file at all
- Egress logs: "Start signal not received" or "Room not found"
- Pipeline status: `failed` with specific error

---

## Quick Fix for Future Sessions:

Add this to your frontend LiveKit component:

```javascript
// After joining room
room.on(RoomEvent.TrackPublished, (publication, participant) => {
  if (publication.kind === Track.Kind.Audio) {
    console.log('🎤 Audio track published:', participant.identity);
    
    // Check if audio is actually flowing
    publication.track.on(TrackEvent.AudioPlaybackStarted, () => {
      console.log('✅ Audio playback confirmed');
    });
  }
});

// Warn user if no audio detected after 5 seconds
setTimeout(() => {
  const localTracks = room.localParticipant.audioTracks;
  if (localTracks.size === 0) {
    alert('⚠️ Your microphone is not connected. Please enable it.');
  }
}, 5000);
```

This will catch the issue DURING the call instead of discovering it afterward.
