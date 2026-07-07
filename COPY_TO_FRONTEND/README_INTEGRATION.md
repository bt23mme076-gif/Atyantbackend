# 🎤 Microphone Check Component - Integration Guide

## 📁 Files to Copy

Copy these files to your frontend project:

```
C:\Atyantfrontend\
  src\
    components\
      LiveKit\
        MicrophoneCheck.jsx       ← Copy from COPY_TO_FRONTEND/
        MicrophoneCheck.css       ← Copy from COPY_TO_FRONTEND/
```

---

## 🚀 Quick Integration (5 minutes)

### Step 1: Copy Files

```bash
# From backend folder, copy to frontend
cd C:\Atyantbackend\COPY_TO_FRONTEND

# Create folder if doesn't exist
mkdir C:\Atyantfrontend\src\components\LiveKit

# Copy files
copy MicrophoneCheck.jsx C:\Atyantfrontend\src\components\LiveKit\
copy MicrophoneCheck.css C:\Atyantfrontend\src\components\LiveKit\
```

### Step 2: Install Dependencies (if not already installed)

```bash
cd C:\Atyantfrontend
npm install @livekit/components-react livekit-client
```

### Step 3: Integrate in Your LiveKit Component

Find your existing LiveKit session component (probably named something like `SessionRoom.jsx`, `VideoCall.jsx`, or `LiveKitSession.jsx`).

**Add these imports:**

```jsx
import { useLocalParticipant } from '@livekit/components-react';
import MicrophoneCheck from './components/LiveKit/MicrophoneCheck';
```

**Add the component inside your LiveKitRoom:**

```jsx
import { LiveKitRoom, useLocalParticipant } from '@livekit/components-react';
import MicrophoneCheck from './components/LiveKit/MicrophoneCheck';

// Create inner component to access LiveKit context
function SessionRoomContent() {
  const { localParticipant } = useLocalParticipant();
  const room = localParticipant?.room;

  return (
    <div className="session-container">
      {/* Mic Check Component - Shows banner at top */}
      <MicrophoneCheck 
        room={room} 
        localParticipant={localParticipant} 
      />
      
      {/* Your existing LiveKit UI components */}
      <div className="video-area">
        {/* VideoTrack, AudioTrack, etc. */}
      </div>
      
      <div className="controls">
        {/* Mute button, end call, etc. */}
      </div>
    </div>
  );
}

// Main component
export default function SessionRoom({ sessionId, token, serverUrl }) {
  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect={true}
      audio={true}
      video={true} // or false if audio-only
    >
      <SessionRoomContent />
    </LiveKitRoom>
  );
}
```

---

## 📋 Complete Example

Here's a full example if you're building from scratch:

```jsx
// SessionRoom.jsx
import { useState, useEffect } from 'react';
import { 
  LiveKitRoom, 
  useLocalParticipant,
  useTracks,
  TrackToggle,
  DisconnectButton
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import MicrophoneCheck from '../components/LiveKit/MicrophoneCheck';
import '@livekit/components-styles';
import './SessionRoom.css';

function SessionRoomContent() {
  const { localParticipant } = useLocalParticipant();
  const room = localParticipant?.room;
  
  const tracks = useTracks([
    { source: Track.Source.Camera, withPlaceholder: false },
    { source: Track.Source.Microphone, withPlaceholder: false },
  ]);

  return (
    <div className="session-room">
      {/* Microphone Check Banner */}
      <MicrophoneCheck 
        room={room} 
        localParticipant={localParticipant} 
      />
      
      {/* Main Content */}
      <div className="room-content">
        <div className="participants">
          {tracks.map((track) => (
            <div key={track.participant.identity} className="participant">
              <div className="participant-name">
                {track.participant.name || track.participant.identity}
              </div>
              {/* Audio/Video rendering */}
            </div>
          ))}
        </div>
        
        {/* Controls */}
        <div className="controls">
          <TrackToggle source={Track.Source.Microphone} />
          <TrackToggle source={Track.Source.Camera} />
          <DisconnectButton />
        </div>
      </div>
    </div>
  );
}

export default function SessionRoom({ sessionId }) {
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch LiveKit token from your backend
    fetch(`/api/livekit/join/${sessionId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('atyant_token')}`
      }
    })
    .then(res => res.json())
    .then(data => {
      setToken(data.token);
      setLoading(false);
    })
    .catch(err => {
      console.error('Failed to get LiveKit token:', err);
      setLoading(false);
    });
  }, [sessionId]);

  if (loading) return <div>Loading session...</div>;
  if (!token) return <div>Failed to load session</div>;

  return (
    <LiveKitRoom
      token={token}
      serverUrl={process.env.REACT_APP_LIVEKIT_WS_URL || 'wss://meet.api.product.atyant.in'}
      connect={true}
      audio={true}
      video={true}
    >
      <SessionRoomContent />
    </LiveKitRoom>
  );
}
```

---

## 🎨 Styling (Optional Customization)

The banner uses fixed positioning at the top of the screen. If you need to adjust:

```css
/* Your custom CSS file */
.mic-check-banner {
  top: 60px; /* If you have a header navbar */
}

/* Or adjust colors */
.mic-check-banner.warning {
  background: #your-brand-color;
}
```

---

## ✅ Testing the Integration

### Test 1: Blocked Microphone
1. Join a session
2. When browser asks for mic permission, click **"Block"**
3. **Expected:** Red warning banner appears
4. **Expected:** "Microphone Issue Detected! Browser blocked..." message

### Test 2: Muted Microphone
1. Join session with mic enabled
2. Click the mute button
3. **Expected:** Yellow warning banner appears
4. Click unmute
5. **Expected:** Banner changes to green ✅ "Microphone working"

### Test 3: Working Microphone
1. Join session
2. Allow microphone permission
3. **Expected:** Green success banner appears briefly
4. **Expected:** Banner auto-hides after 5 seconds

---

## 🐛 Troubleshooting

### Banner doesn't appear
- **Check:** `localParticipant` and `room` are not null
- **Fix:** Make sure component is inside `<LiveKitRoom>` and using `useLocalParticipant()` hook

### Warning shows even when mic is working
- **Check:** Audio track is actually published
- **Debug:** Add `console.log(localParticipant.audioTracks)` to see tracks
- **Fix:** Ensure `audio={true}` in `<LiveKitRoom>` props

### CSS not loading
- **Check:** Import statement: `import './MicrophoneCheck.css';`
- **Fix:** Verify file path is correct relative to component

### TypeScript errors
If using TypeScript, add prop types:

```typescript
interface MicrophoneCheckProps {
  room: Room | undefined;
  localParticipant: LocalParticipant | undefined;
}

export default function MicrophoneCheck({ room, localParticipant }: MicrophoneCheckProps) {
  // ...
}
```

---

## 📊 Success Metrics

After integration, monitor these:

1. **No Audio Sessions:** Should drop from 20-30% to <5%
2. **User Feedback:** Fewer complaints about "other person can't hear me"
3. **Session Completion:** More sessions with usable transcripts

---

## 🔄 Next Steps

After basic integration works:

1. ✅ Test with real sessions
2. ✅ Add analytics tracking: `trackEvent('mic_warning_shown', { reason: micStatus })`
3. ✅ Optional: Add audio level visualization (see AdvancedMicrophoneCheck in main doc)
4. ✅ Optional: Add pre-call mic test page

---

## 📞 Support

If you encounter issues:

1. Check browser console for errors
2. Verify LiveKit SDK versions are compatible
3. Test in Chrome/Edge (best browser support)
4. Check `localParticipant.audioTracks` has values

**Need help?** The component is designed to fail gracefully - if it has errors, it simply won't render (won't break your app).

---

## ✨ What This Solves

**Before:**
- User joins call
- Mic is muted/blocked
- They talk for 30 minutes
- Session ends
- Pipeline detects `no_audio`
- Transcript is useless: "you you you thank you..."
- User discovers problem AFTER wasting time

**After:**
- User joins call
- Mic is muted/blocked
- Banner appears immediately: ⚠️ "Microphone Issue!"
- User fixes it DURING call
- Session completes successfully
- Transcript captures real conversation
- Everyone happy! 🎉

---

That's it! Copy the files, add 3 lines of code, and you're protected against mic issues.
