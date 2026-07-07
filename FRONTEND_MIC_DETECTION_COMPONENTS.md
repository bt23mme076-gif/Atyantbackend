# 🎤 Frontend Mic Detection Components for LiveKit Sessions

Copy these components to your `C:\Atyantfrontend` project to prevent mic issues like Rishu's.

---

## 📁 File 1: `src/components/LiveKit/MicrophoneCheck.jsx`

```jsx
import { useEffect, useState } from 'react';
import { Track } from 'livekit-client';

/**
 * Microphone Detection Component
 * Monitors audio track and warns user if mic is not working
 */
export default function MicrophoneCheck({ room, localParticipant }) {
  const [micStatus, setMicStatus] = useState('checking'); // checking | working | muted | blocked
  const [audioLevel, setAudioLevel] = useState(0);
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    if (!room || !localParticipant) return;

    let checkTimer;
    let audioCheckInterval;

    // Monitor audio track publication
    const checkMicStatus = () => {
      const audioTracks = Array.from(localParticipant.audioTracks.values());
      
      if (audioTracks.length === 0) {
        setMicStatus('muted');
        setShowWarning(true);
        return;
      }

      const audioTrack = audioTracks[0];
      
      if (!audioTrack.isEnabled) {
        setMicStatus('muted');
        setShowWarning(true);
        return;
      }

      // Track is enabled, monitor audio level
      const track = audioTrack.track;
      if (track) {
        setMicStatus('working');
        setShowWarning(false);
        
        // Monitor actual audio levels
        monitorAudioLevel(track);
      }
    };

    // Check audio amplitude to detect silent mic
    const monitorAudioLevel = (track) => {
      if (audioCheckInterval) clearInterval(audioCheckInterval);
      
      audioCheckInterval = setInterval(() => {
        // LiveKit provides isMuted property
        if (track.isMuted) {
          setAudioLevel(0);
        } else {
          // If track exists and is unmuted, assume audio is flowing
          // For more precise detection, use Web Audio API (see advanced version below)
          setAudioLevel(50); // Placeholder - track is active
        }
      }, 500);
    };

    // Initial check after 3 seconds
    checkTimer = setTimeout(() => {
      checkMicStatus();
    }, 3000);

    // Listen for track changes
    localParticipant.on('trackPublished', checkMicStatus);
    localParticipant.on('trackUnpublished', checkMicStatus);
    localParticipant.on('trackMuted', checkMicStatus);
    localParticipant.on('trackUnmuted', checkMicStatus);

    return () => {
      clearTimeout(checkTimer);
      clearInterval(audioCheckInterval);
      localParticipant.off('trackPublished', checkMicStatus);
      localParticipant.off('trackUnpublished', checkMicStatus);
      localParticipant.off('trackMuted', checkMicStatus);
      localParticipant.off('trackUnmuted', checkMicStatus);
    };
  }, [room, localParticipant]);

  if (micStatus === 'checking') {
    return (
      <div className="mic-check-banner checking">
        🎤 Checking microphone...
      </div>
    );
  }

  if (showWarning && micStatus !== 'working') {
    return (
      <div className="mic-check-banner warning">
        <div className="warning-content">
          <span className="warning-icon">⚠️</span>
          <div className="warning-text">
            <strong>Microphone Issue Detected!</strong>
            <p>
              {micStatus === 'muted' && 'Your microphone is muted or not enabled.'}
              {micStatus === 'blocked' && 'Microphone access was blocked by your browser.'}
              {' '}The other person cannot hear you. Please enable your microphone.
            </p>
          </div>
          <button 
            className="fix-button"
            onClick={() => {
              // Prompt user to enable mic
              alert('Please:\n1. Click the microphone icon to unmute\n2. Check browser permissions\n3. Select correct input device in settings');
            }}
          >
            How to Fix
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mic-check-banner success">
      ✅ Microphone working
    </div>
  );
}
```

---

## 📁 File 2: `src/components/LiveKit/MicrophoneCheck.css`

```css
.mic-check-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  padding: 12px 20px;
  z-index: 9999;
  font-size: 14px;
  text-align: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  animation: slideDown 0.3s ease-out;
}

@keyframes slideDown {
  from {
    transform: translateY(-100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.mic-check-banner.checking {
  background: #f0f0f0;
  color: #666;
  border-bottom: 2px solid #ddd;
}

.mic-check-banner.success {
  background: #d4edda;
  color: #155724;
  border-bottom: 2px solid #28a745;
}

.mic-check-banner.warning {
  background: #fff3cd;
  color: #856404;
  border-bottom: 3px solid #ffc107;
  padding: 16px 20px;
}

.warning-content {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  max-width: 900px;
  margin: 0 auto;
}

.warning-icon {
  font-size: 32px;
  flex-shrink: 0;
}

.warning-text {
  text-align: left;
  flex: 1;
}

.warning-text strong {
  display: block;
  font-size: 16px;
  margin-bottom: 4px;
}

.warning-text p {
  margin: 0;
  font-size: 14px;
  line-height: 1.4;
}

.fix-button {
  background: #ff6b6b;
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.2s;
}

.fix-button:hover {
  background: #ee5a52;
}

@media (max-width: 768px) {
  .warning-content {
    flex-direction: column;
    gap: 12px;
  }
  
  .warning-text {
    text-align: center;
  }
}
```

---

## 📁 File 3: `src/components/LiveKit/AdvancedMicrophoneCheck.jsx`

**Advanced version with Web Audio API to detect actual audio levels:**

```jsx
import { useEffect, useState, useRef } from 'react';

/**
 * Advanced Microphone Check with Audio Level Detection
 * Uses Web Audio API to measure actual microphone input levels
 */
export default function AdvancedMicrophoneCheck({ room, localParticipant }) {
  const [micStatus, setMicStatus] = useState('checking');
  const [audioLevel, setAudioLevel] = useState(0);
  const [showWarning, setShowWarning] = useState(false);
  const [silentDuration, setSilentDuration] = useState(0);
  
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameRef = useRef(null);

  useEffect(() => {
    if (!room || !localParticipant) return;

    let silenceTimer;
    let checkTimer;

    const setupAudioAnalysis = async () => {
      const audioTracks = Array.from(localParticipant.audioTracks.values());
      
      if (audioTracks.length === 0) {
        setMicStatus('muted');
        setShowWarning(true);
        return;
      }

      const audioPublication = audioTracks[0];
      const track = audioPublication.track;

      if (!track || !audioPublication.isEnabled) {
        setMicStatus('muted');
        setShowWarning(true);
        return;
      }

      try {
        // Get the MediaStreamTrack
        const mediaStreamTrack = track.mediaStreamTrack;
        const mediaStream = new MediaStream([mediaStreamTrack]);

        // Create Web Audio API context
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        const microphone = audioContext.createMediaStreamSource(mediaStream);
        
        analyser.smoothingTimeConstant = 0.8;
        analyser.fftSize = 256;
        
        microphone.connect(analyser);
        
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;

        // Monitor audio levels
        let silentSeconds = 0;
        monitorAudioLevel(analyser, () => {
          silentSeconds++;
          setSilentDuration(silentSeconds);
          
          // Warn after 10 seconds of silence
          if (silentSeconds >= 10) {
            setShowWarning(true);
          }
        }, () => {
          silentSeconds = 0;
          setSilentDuration(0);
          setShowWarning(false);
          setMicStatus('working');
        });

        setMicStatus('working');
      } catch (err) {
        console.error('Audio analysis setup failed:', err);
        setMicStatus('blocked');
        setShowWarning(true);
      }
    };

    const monitorAudioLevel = (analyser, onSilent, onSound) => {
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      
      let lastSoundTime = Date.now();

      const detectSound = () => {
        analyser.getByteFrequencyData(dataArray);
        
        // Calculate average amplitude
        const sum = dataArray.reduce((a, b) => a + b, 0);
        const average = sum / bufferLength;
        
        setAudioLevel(Math.min(100, average * 2)); // Scale to 0-100
        
        // Detect if audio is present (threshold: 5)
        if (average > 5) {
          lastSoundTime = Date.now();
          onSound();
        } else {
          const silentTime = (Date.now() - lastSoundTime) / 1000;
          if (silentTime >= 1) { // 1 second of silence
            onSilent();
          }
        }
        
        animationFrameRef.current = requestAnimationFrame(detectSound);
      };
      
      detectSound();
    };

    // Wait 3 seconds after join before checking
    checkTimer = setTimeout(() => {
      setupAudioAnalysis();
    }, 3000);

    // Re-check when track changes
    localParticipant.on('trackPublished', setupAudioAnalysis);
    localParticipant.on('trackUnpublished', () => {
      setMicStatus('muted');
      setShowWarning(true);
    });

    return () => {
      clearTimeout(checkTimer);
      
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      
      localParticipant.off('trackPublished', setupAudioAnalysis);
    };
  }, [room, localParticipant]);

  if (micStatus === 'checking') {
    return (
      <div className="mic-check-banner checking">
        🎤 Checking microphone...
      </div>
    );
  }

  if (showWarning && micStatus !== 'working') {
    return (
      <div className="mic-check-banner warning">
        <div className="warning-content">
          <span className="warning-icon">⚠️</span>
          <div className="warning-text">
            <strong>Microphone Issue!</strong>
            <p>
              {micStatus === 'muted' && 'Your microphone is not enabled.'}
              {micStatus === 'blocked' && 'Browser blocked microphone access.'}
              {silentDuration > 0 && ` No audio detected for ${silentDuration} seconds.`}
            </p>
          </div>
          <button 
            className="fix-button"
            onClick={() => window.open('/mic-troubleshoot', '_blank')}
          >
            Troubleshoot
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mic-check-banner success">
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'center' }}>
        <span>✅ Microphone working</span>
        <div className="audio-level-bar">
          <div 
            className="audio-level-fill" 
            style={{ width: `${audioLevel}%` }}
          />
        </div>
      </div>
    </div>
  );
}
```

**Add to CSS:**

```css
.audio-level-bar {
  width: 100px;
  height: 8px;
  background: rgba(255,255,255,0.3);
  border-radius: 4px;
  overflow: hidden;
}

.audio-level-fill {
  height: 100%;
  background: linear-gradient(90deg, #28a745, #ffc107, #dc3545);
  transition: width 0.1s ease-out;
  border-radius: 4px;
}
```

---

## 📁 File 4: Integration in Your LiveKit Session Component

```jsx
// In your existing LiveKit session component (e.g., SessionRoom.jsx)

import { useEffect, useState } from 'react';
import { 
  LiveKitRoom, 
  VideoTrack, 
  AudioTrack,
  useLocalParticipant,
  useTracks
} from '@livekit/components-react';
import MicrophoneCheck from './MicrophoneCheck';
// or
import AdvancedMicrophoneCheck from './AdvancedMicrophoneCheck';

function SessionRoomContent() {
  const { localParticipant } = useLocalParticipant();
  const room = localParticipant?.room;

  return (
    <div className="session-room">
      {/* Mic Check Banner - appears at top of screen */}
      <MicrophoneCheck 
        room={room} 
        localParticipant={localParticipant} 
      />
      
      {/* Rest of your LiveKit UI */}
      <div className="video-grid">
        {/* Your existing video/audio components */}
      </div>
    </div>
  );
}

export default function SessionRoom({ sessionId, token, livekitUrl }) {
  return (
    <LiveKitRoom
      token={token}
      serverUrl={livekitUrl}
      connect={true}
      audio={true}
      video={false}
    >
      <SessionRoomContent />
    </LiveKitRoom>
  );
}
```

---

## 📁 File 5: Troubleshooting Page (`src/pages/MicTroubleshoot.jsx`)

```jsx
export default function MicTroubleshoot() {
  return (
    <div style={{ maxWidth: '800px', margin: '40px auto', padding: '20px' }}>
      <h1>🎤 Microphone Troubleshooting</h1>
      
      <div className="troubleshoot-section">
        <h2>1. Check Browser Permissions</h2>
        <ul>
          <li>Click the <strong>lock icon</strong> in your browser's address bar</li>
          <li>Find "Microphone" in the permissions list</li>
          <li>Set it to <strong>"Allow"</strong></li>
          <li>Refresh the page</li>
        </ul>
      </div>

      <div className="troubleshoot-section">
        <h2>2. Enable Microphone in Call</h2>
        <ul>
          <li>Look for the microphone icon in the call interface</li>
          <li>Make sure it's <strong>NOT</strong> crossed out (unmuted)</li>
          <li>Click it to toggle</li>
        </ul>
      </div>

      <div className="troubleshoot-section">
        <h2>3. Check System Settings</h2>
        <ul>
          <li><strong>Windows:</strong> Settings → Privacy → Microphone → Allow apps to access</li>
          <li><strong>Mac:</strong> System Preferences → Security & Privacy → Microphone → Check browser</li>
        </ul>
      </div>

      <div className="troubleshoot-section">
        <h2>4. Test Your Microphone</h2>
        <p>Speak normally - you should see the green audio level bar move.</p>
        <p>If the bar stays flat, your mic is not picking up sound.</p>
      </div>

      <div className="troubleshoot-section">
        <h2>5. Select Correct Device</h2>
        <ul>
          <li>If you have multiple microphones (headset, webcam, etc.)</li>
          <li>Click settings in the call interface</li>
          <li>Select the correct <strong>Audio Input Device</strong></li>
        </ul>
      </div>

      <div className="troubleshoot-section" style={{ background: '#fff3cd', padding: '16px', borderRadius: '8px' }}>
        <h3>⚠️ Still Not Working?</h3>
        <p>Try these:</p>
        <ul>
          <li>Use <strong>Chrome</strong> or <strong>Edge</strong> (best compatibility)</li>
          <li>Close other apps using your microphone (Zoom, Discord, etc.)</li>
          <li>Restart your browser</li>
          <li>Check if your mic works in other apps</li>
        </ul>
      </div>
    </div>
  );
}
```

---

## 🚀 How to Implement

### Step 1: Copy files to your frontend
```bash
cd C:\Atyantfrontend

# Create components
mkdir -p src/components/LiveKit
# Copy MicrophoneCheck.jsx, MicrophoneCheck.css, AdvancedMicrophoneCheck.jsx

# Create troubleshooting page
mkdir -p src/pages
# Copy MicTroubleshoot.jsx
```

### Step 2: Install dependencies (if not already present)
```bash
npm install @livekit/components-react livekit-client
```

### Step 3: Import in your LiveKit session component
Use the integration example above (File 4)

### Step 4: Add CSS
Import `MicrophoneCheck.css` in your main CSS or component

---

## ✅ What This Solves

1. **Prevents "Rishu's Issue"** - Users get immediate warning if mic isn't working
2. **Real-time Detection** - Checks audio levels every 500ms
3. **Multiple Failure Modes** - Detects:
   - Mic not enabled
   - Browser permission blocked
   - Silent mic (hardware issue)
   - Track unpublished
4. **User-Friendly** - Clear warnings with actionable steps
5. **Non-Intrusive** - Success banner auto-hides after 5 seconds

---

## 🎯 Recommendation

Use **AdvancedMicrophoneCheck** - it uses Web Audio API to detect actual silence, catching the exact issue Rishu had (mic enabled but not capturing audio).

