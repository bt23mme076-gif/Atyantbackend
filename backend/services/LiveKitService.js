import {
  AccessToken, RoomServiceClient, EgressClient, WebhookReceiver,
  EncodedFileOutput, EncodedFileType, S3Upload, TrackSource,
} from 'livekit-server-sdk';

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
      emptyTimeout: 300,
      maxParticipants: 2,
    });
    return roomName;
  }

  // role: 'participant' | 'admin'
  // callType: 'audio' | 'video' — 'audio' locks publish to microphone only (server-enforced)
  async generateToken(roomName, userId, participantName, role = 'participant', callType = 'video') {
    this._init();
    const at = new AccessToken(this._key, this._secret, {
      identity: String(userId),
      name: participantName,
      ttl: 4 * 60 * 60,
    });
    const grant = {
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      roomAdmin: role === 'admin',
    };
    if (callType === 'audio') {
      grant.canPublishSources = [TrackSource.MICROPHONE];
    }
    at.addGrant(grant);
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
      { audioOnly: true }
    );
    return { egressId: egress.egressId, filePath: location };
  }

  async stopEgress(egressId) {
    this._init();
    try {
      await this.egressClient.stopEgress(egressId);
    } catch (err) {
      console.warn('stopEgress warning (non-fatal):', err.message);
    }
  }

  receiveWebhook(rawBody, authHeader) {
    this._init();
    return this.receiver.receive(rawBody, authHeader);
  }
}

export default new LiveKitService();
