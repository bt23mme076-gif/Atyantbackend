import {
  AccessToken, RoomServiceClient, EgressClient, WebhookReceiver,
  EncodedFileOutput, EncodedFileType, S3Upload,
  EncodingOptions, AudioCodec,
} from 'livekit-server-sdk';

// Egress default (128 kbps OPUS) produced a 49.7 MB file for a 57-min session —
// well past Groq Whisper's per-file size limit, which is why that pipeline run
// failed. Speech-only audio transcribes fine at a much lower bitrate, so we pin
// a voice-optimized encoding: at 24 kbps a 90-min session is ~16 MB and a
// 2-hour session is ~22 MB, comfortably under the limit with room to spare.
const RECORDING_ENCODING = new EncodingOptions({
  audioCodec: AudioCodec.OPUS,
  audioBitrate: 24,
  audioFrequency: 16000,
});

class LiveKitService {
  _init() {
    if (this._ready) return;
    const host   = process.env.LIVEKIT_HOST       || 'http://localhost:7880';
    const key    = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!key || !secret) {
      console.warn('⚠️ LiveKit credentials not configured — meet features disabled');
      return;
    }
    this.roomService  = new RoomServiceClient(host, key, secret);
    this.egressClient = new EgressClient(host, key, secret);
    this.receiver     = new WebhookReceiver(key, secret);
    this._key    = key;
    this._secret = secret;
    this._host   = host;
    this._ready  = true;
    console.log('✅ LiveKit initialized:', host);
  }

  isConfigured() {
    this._init();
    return !!this._ready;
  }

  async createRoom(sessionId) {
    this._init();
    const roomName = `session_${sessionId}`;
    // Idempotent: LiveKit returns the existing room if it's already there, and
    // re-creates it if it was garbage-collected after emptyTimeout. Either way
    // the room is guaranteed to exist on the server when this resolves.
    await this.roomService.createRoom({
      name: roomName,
      // Nobody ever joins (mentor/student no-show): close the room after 5 min.
      emptyTimeout: 300,
      // Everyone LEFT: close 60 s later. This is the native auto-end — short
      // enough that a stuck recording can't run for 88 min like the July-6
      // session did, but long enough to survive a transient reconnect. The
      // participant_left webhook also force-closes empty rooms as a backstop.
      departureTimeout: 60,
      maxParticipants: 2,
    });
    return roomName;
  }

  // Force-end a room: disconnects any remaining participants and stops egress.
  // Used to auto-end a call the moment both real participants are gone, rather
  // than waiting on departureTimeout (which a hidden egress participant can
  // otherwise keep alive).
  async deleteRoom(roomName) {
    this._init();
    try {
      await this.roomService.deleteRoom(roomName);
      return true;
    } catch (err) {
      // "room not found" = already closed — treat as success.
      console.warn('deleteRoom warning (non-fatal):', err.message);
      return false;
    }
  }

  // role: 'participant' | 'admin'
  async generateToken(roomName, userId, participantName, role = 'participant') {
    this._init();
    const at = new AccessToken(this._key, this._secret, {
      identity: String(userId),
      name: participantName,
      ttl: 4 * 60 * 60,
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      roomAdmin: role === 'admin',
    });
    return at.toJwt();
  }

  // Build the file output for egress. If S3/R2 credentials are configured the
  // recording is uploaded to the bucket (required when egress runs on a
  // separate machine); otherwise it falls back to a server-local path.
  _buildFileOutput(sessionId) {
    const bucket = process.env.EGRESS_S3_BUCKET;
    // Cloud/object-storage output — works across machines (S3, Cloudflare R2, MinIO, GCS-S3).
    if (bucket && process.env.EGRESS_S3_ACCESS_KEY && process.env.EGRESS_S3_SECRET_KEY) {
      const key = `recordings/${sessionId}.ogg`;
      const output = new EncodedFileOutput({
        fileType: EncodedFileType.OGG,
        filepath: key,
        output: {
          case: 's3',
          value: new S3Upload({
            accessKey: process.env.EGRESS_S3_ACCESS_KEY,
            secret:    process.env.EGRESS_S3_SECRET_KEY,
            bucket,
            region:    process.env.EGRESS_S3_REGION || 'auto',          // 'auto' for Cloudflare R2
            endpoint:  process.env.EGRESS_S3_ENDPOINT || undefined,     // R2/MinIO custom endpoint
            forcePathStyle: !!process.env.EGRESS_S3_ENDPOINT,           // needed for R2/MinIO
          }),
        },
      });
      return { output, location: `s3://${bucket}/${key}` };
    }
    // Local fallback — only works when egress runs on this same machine.
    const filePath = `${process.env.RECORDINGS_PATH || '/tmp/recordings'}/${sessionId}.ogg`;
    const output = new EncodedFileOutput({ fileType: EncodedFileType.OGG, filepath: filePath });
    return { output, location: filePath };
  }

  async startAudioEgress(roomName, sessionId) {
    this._init();
    const { output, location } = this._buildFileOutput(sessionId);
    const egress = await this.egressClient.startRoomCompositeEgress(
      roomName,
      output,
      { audioOnly: true, encodingOptions: RECORDING_ENCODING }
    );
    return { egressId: egress.egressId, filePath: location };
  }

  async stopEgress(egressId) {
    this._init();
    try {
      await this.egressClient.stopEgress(egressId);
    } catch (err) {
      // "egress is not active" here is normal — it already stopped on its own.
      console.warn('stopEgress warning (non-fatal):', err.message);
    }
  }

  // True if the room still has real (non-hidden) participants. Egress/recorder
  // participants join hidden, so they don't count. Used to decide whether an
  // aborted recording is worth restarting mid-call.
  async roomHasParticipants(roomName) {
    this._init();
    try {
      const participants = await this.roomService.listParticipants(roomName);
      return participants.some(p => !p.permission?.hidden);
    } catch {
      return false; // room already closed
    }
  }

  receiveWebhook(rawBody, authHeader) {
    this._init();
    return this.receiver.receive(rawBody, authHeader);
  }
}

export default new LiveKitService();
