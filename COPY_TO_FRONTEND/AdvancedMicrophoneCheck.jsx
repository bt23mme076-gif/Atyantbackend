import { useEffect, useState, useRef } from 'react';
import './MicrophoneCheck.css';

/**
 * Advanced Microphone Check with Real Audio Level Detection
 * Smart detection - only warns when mic is actually needed
 * 
 * Place inside LiveKitRoom component
 */
export default function AdvancedMicrophoneCheck({ room, localParticipant }) {
  const [micStatus, setMicStatus] = useState('checking');
  const [audioLevel, setAudioLevel] = useState(0);
  const [showWarning, setShowWarning] = useState(false);
  const [silentDuration, setSilentDuration] = useState(0);
  const [canDismiss, setCanDismiss] = useState(false);
  const [userIntentToSpeak, setUserIntentToSpeak] = useState(false);
  
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameRef = useRef(null);
  const lastUnmuteTimeRef = useRef(Date.now());
  const otherParticipantSpeakingRef = useRef(false);

  useEffect(() => {
    if (!room || !localParticipant) return;

    let checkTimer;
    let dismissTimer;

    const setupAudioAnalysis = async () => {
      const audioTracks = Array.from(localParticipant.audioTracks.values());
      
      if (audioTracks.length === 0) {
        // Only warn if user recently unmuted (intent to speak)
        const timeSinceUnmute = Date.now() - lastUnmuteTimeRef.current;
        if (timeSinceUnmute < 5000) { // Within 5 seconds of unmuting
          setMicStatus('muted');
          setShowWarning(true);
        } else {
          // User is in listening mode - no warning
          setMicStatus('listening');
          setShowWarning(false);
        }
        return;
      }

      const audioPublication = audioTracks[0];
      const track = audioPublication.track;

      if (!track || !audioPublication.isEnabled) {
        const timeSinceUnmute = Date.now() - lastUnmuteTimeRef.current;
        if (timeSinceUnmute < 5000) {
          setMicStatus('muted');
          setShowWarning(true);
        } else {
          setMicStatus('listening');
          setShowWarning(false);
        }
        return;
      }

      // Track unmute time
      lastUnmuteTimeRef.current = Date.now();

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

        // Monitor audio levels continuously
        let lastSoundTime = Date.now();
        let silentSeconds = 0;
        
        const detectSound = () => {
          if (!analyserRef.current) return;
          
          const bufferLength = analyserRef.current.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          
          analyserRef.current.getByteFrequencyData(dataArray);
          
          // Calculate average amplitude
          const sum = dataArray.reduce((a, b) => a + b, 0);
          const average = sum / bufferLength;
          
          setAudioLevel(Math.min(100, average * 2.5)); // Scale to 0-100
          
          // Detect if audio is present (threshold: 3 for very sensitive detection)
          if (average > 3) {
            lastSoundTime = Date.now();
            silentSeconds = 0;
            setSilentDuration(0);
            setShowWarning(false);
            setMicStatus('working');
          } else {
            const silentTime = (Date.now() - lastSoundTime) / 1000;
            const timeSinceUnmute = (Date.now() - lastUnmuteTimeRef.current) / 1000;
            
            // Only warn if:
            // 1. Mic was recently unmuted (intent to speak)
            // 2. AND silent for 20+ seconds
            // 3. AND other participant is not speaking
            if (silentTime >= 1) {
              silentSeconds = Math.floor(silentTime);
              setSilentDuration(silentSeconds);
              
              // Warn only if user unmuted recently (within 30 seconds)
              if (timeSinceUnmute < 30 && silentSeconds >= 20 && !otherParticipantSpeakingRef.current) {
                setShowWarning(true);
                setMicStatus('silent');
              }
            }
          }
          
          animationFrameRef.current = requestAnimationFrame(detectSound);
        };
        
        detectSound();
        setMicStatus('working');
        
        // Auto-dismiss success banner after 8 seconds
        dismissTimer = setTimeout(() => setCanDismiss(true), 8000);
        
      } catch (err) {
        console.error('Audio analysis setup failed:', err);
        setMicStatus('blocked');
        setShowWarning(true);
      }
    };

    // Monitor other participants speaking
    const monitorOtherParticipants = () => {
      if (!room) return;
      
      const remoteParticipants = Array.from(room.participants.values());
      const anyoneSpeaking = remoteParticipants.some(p => 
        p.isSpeaking || Array.from(p.audioTracks.values()).some(t => t.isMuted === false)
      );
      
      otherParticipantSpeakingRef.current = anyoneSpeaking;
    };

    // Check every 2 seconds
    const speakingCheckInterval = setInterval(monitorOtherParticipants, 2000);

    // Wait 3 seconds after join before checking
    checkTimer = setTimeout(() => {
      setupAudioAnalysis();
    }, 3000);

    // Re-check when track changes
    if (localParticipant.on) {
      localParticipant.on('trackPublished', () => {
        lastUnmuteTimeRef.current = Date.now();
        setupAudioAnalysis();
      });
      localParticipant.on('trackUnpublished', () => {
        setupAudioAnalysis();
      });
      localParticipant.on('trackMuted', () => {
        setupAudioAnalysis();
      });
      localParticipant.on('trackUnmuted', () => {
        lastUnmuteTimeRef.current = Date.now();
        setupAudioAnalysis();
      });
    }

    return () => {
      clearTimeout(checkTimer);
      clearTimeout(dismissTimer);
      clearInterval(speakingCheckInterval);
      
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      
      if (localParticipant.off) {
        localParticipant.off('trackPublished', setupAudioAnalysis);
        localParticipant.off('trackUnpublished', setupAudioAnalysis);
        localParticipant.off('trackMuted', setupAudioAnalysis);
        localParticipant.off('trackUnmuted', setupAudioAnalysis);
      }
    };
  }, [room, localParticipant]);

  if (micStatus === 'checking') {
    return (
      <div className="mic-check-banner checking">
        🎤 Checking microphone...
      </div>
    );
  }

  if (showWarning && (micStatus === 'muted' || micStatus === 'blocked' || micStatus === 'silent')) {
    return (
      <div className="mic-check-banner warning" role="alert">
        <div className="warning-content">
          <span className="warning-icon">⚠️</span>
          <div className="warning-text">
            <strong>⚠️ Microphone Issue!</strong>
            <p>
              {micStatus === 'muted' && 'Your microphone is not enabled. '}
              {micStatus === 'blocked' && 'Browser blocked microphone access. '}
              {micStatus === 'silent' && `No audio detected for ${silentDuration} seconds. `}
              The other person cannot hear you.
            </p>
          </div>
          <button 
            className="fix-button"
            onClick={() => {
              let msg;
              if (micStatus === 'muted') {
                msg = '🎤 To enable your microphone:\n\n' +
                      '1. Click the microphone icon in the call\n' +
                      '2. Make sure it\'s NOT red/crossed out\n' +
                      '3. Speak and check if audio bars move';
              } else if (micStatus === 'blocked') {
                msg = '🔒 To fix permissions:\n\n' +
                      '1. Click the lock icon (🔒) in address bar\n' +
                      '2. Find "Microphone" → Change to "Allow"\n' +
                      '3. Refresh this page\n' +
                      '4. Allow when browser asks';
              } else {
                msg = '🔇 Your mic is on but silent:\n\n' +
                      '1. Check if correct mic is selected\n' +
                      '2. Increase mic volume in system settings\n' +
                      '3. Test mic: speak loudly and watch audio bars\n' +
                      '4. Try unplugging and reconnecting mic';
              }
              alert(msg);
            }}
          >
            How to Fix
          </button>
        </div>
      </div>
    );
  }

  if (micStatus === 'working' && !canDismiss) {
    return (
      <div className="mic-check-banner success">
        <div className="success-content">
          <span>✅ Microphone working</span>
          <div className="audio-level-container">
            <div className="audio-level-bar">
              <div 
                className="audio-level-fill" 
                style={{ 
                  width: `${audioLevel}%`,
                  transition: 'width 0.1s ease-out'
                }}
              />
            </div>
            <span className="audio-level-label">
              {audioLevel > 30 ? '🔊' : audioLevel > 10 ? '🔉' : '🔈'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return null; // Hide after 8 seconds if working
}
