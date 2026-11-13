// planned → voicing → ready. Records everything the interviewer will say from
// the plan before the candidate joins, in ONE voice for the whole interview:
// the main voice if its health check passes, otherwise the backup.
//
//   per interview  greeting, every planned question (founder must-asks
//                  included) and every planned follow-up → a private
//                  Cloudinary folder, deleted once the interview is scored
//   per voice      the fixed library lines (reactions, "go on", closing…),
//                  recorded once and reused (VoiceClip)
import crypto from 'crypto';
import cloudinary from '../../config/cloudinary.js';
import MockInterview from '../../models/MockInterview.js';
import User from '../../models/User.js';
import VoiceClip from '../../models/VoiceClip.js';
import { interviewDurationMs } from '../mockInterview/liveConfig.js';
import { synthesize, voiceProblem, wavFromPcm } from './openRouterSpeech.js';
import { LIBRARY, greetingText, interviewClips, voiceConfig, voiceId } from './voiceLines.js';
import { alertOps } from './opsAlert.js';

const CONCURRENCY = Number(process.env.TTS_PREP_CONCURRENCY) || 4;
const HEALTH_TEXT = 'Hi, good to meet you.';
const ROOT = 'atyant-voice';
// A ready interview nobody started in this long gives its audio back; it is
// recorded again when someone opens it.
const ABANDONED_MS = 14 * 24 * 60 * 60 * 1000;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const hash = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function uploadWav(buffer, { publicId, type }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', type, public_id: publicId, overwrite: true },
      (err, result) => (err ? reject(new Error(`Cloudinary upload failed: ${err.message}`)) : resolve(result))
    );
    stream.end(buffer);
  });
}

// Interview clips hold the candidate's name and the founder's questions, so they
// are 'authenticated' (unlisted) and reached through signed URLs only.
const signedUrl = result => cloudinary.url(result.public_id, {
  resource_type: 'raw', type: 'authenticated', sign_url: true, secure: true, version: result.version
});

const durationMs = (pcm, sampleRate) => Math.round((pcm.length / 2 / sampleRate) * 1000);

async function record(text, spec) {
  const { pcm, sampleRate, ms } = await synthesize(text, spec);
  return { wav: wavFromPcm(pcm, sampleRate), sampleRate, durationMs: durationMs(pcm, sampleRate), ms };
}

// Main voice unless it is misconfigured or fails a short test line.
async function pickVoice(log) {
  const { main, backup } = voiceConfig();
  for (const spec of [main, backup]) {
    const problem = await voiceProblem(spec);
    if (problem) {
      log.push(`${spec.role} voice skipped: ${problem}`);
      continue;
    }
    const t0 = Date.now();
    try {
      await synthesize(HEALTH_TEXT, spec, { timeoutMs: 10000, retryWaitsMs: [1000] });
      const healthMs = Date.now() - t0;
      log.push(`${spec.role} voice ${voiceId(spec)} healthy in ${healthMs}ms`);
      return { ...spec, healthMs };
    } catch (err) {
      log.push(`${spec.role} voice failed its health check: ${err.message}`);
      if (spec.role === 'main') alertOps('tts_main_down', `Main voice ${voiceId(spec)} failed its health check; interviews are using the backup. ${err.message}`);
    }
  }
  alertOps('tts_all_down', `No voice is working, interviews cannot be prepared. ${log.join(' | ')}`);
  throw new Error(`no working voice (${log.join('; ')})`);
}

// Records any library line this voice doesn't have yet. One run per voice at a time.
const libraryRuns = new Map();
export function ensureLibrary(spec, log = []) {
  const id = voiceId(spec);
  if (!libraryRuns.has(id)) {
    const run = (async () => {
      const have = await VoiceClip.find({ voiceId: id }).select('key text').lean();
      const known = new Set(have.map(c => `${c.key}\n${c.text}`));
      const missing = Object.entries(LIBRARY).filter(([key, text]) => !known.has(`${key}\n${text}`));
      await mapLimit(missing, CONCURRENCY, async ([key, text]) => {
        const clip = await record(text, spec);
        const up = await uploadWav(clip.wav, { publicId: `${ROOT}/library/${slug(id)}/${key}-${hash(text)}.wav`, type: 'upload' });
        await VoiceClip.updateOne(
          { voiceId: id, key, text },
          { $set: { url: up.secure_url, sampleRate: clip.sampleRate, durationMs: clip.durationMs } },
          { upsert: true }
        );
      });
      if (missing.length) log.push(`library: recorded ${missing.length} line(s) for ${id}`);
    })().finally(() => libraryRuns.delete(id));
    libraryRuns.set(id, run);
  }
  return libraryRuns.get(id);
}

async function candidateName(interview) {
  if (interview.mode === 'hiring') return interview.hire?.candidateName || '';
  const user = await User.findById(interview.userId).select('name').lean();
  return user?.name || '';
}

export async function voiceInterview(interviewId) {
  const interview = await MockInterview.findOneAndUpdate(
    { _id: interviewId, status: 'planned' },
    { $set: { status: 'voicing', failureReason: '' } },
    { new: true }
  );
  if (!interview) throw new Error(`Interview ${interviewId} is not in status "planned"`);

  const log = [];
  const t0 = Date.now();
  const folder = `${ROOT}/interviews/${interview._id}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    if (interview.voice?.folder) await deleteFolder(interview.voice.folder).catch(() => {});
    const spec = await pickVoice(log);
    const library = ensureLibrary(spec, log);

    const greeting = greetingText({
      candidateName: await candidateName(interview),
      role         : interview.role,
      company      : interview.company,
      minutes      : Math.round(interviewDurationMs(interview) / 60000)
    });
    const wanted = interviewClips({ questions: interview.plan.questions, greeting });
    const clips = await mapLimit(wanted, CONCURRENCY, async ({ key, text }) => {
      const clip = await record(text, spec);
      const up = await uploadWav(clip.wav, { publicId: `${folder}/${key}.wav`, type: 'authenticated' });
      return { key, text, url: signedUrl(up), sampleRate: clip.sampleRate };
    });
    await library;
    log.push(`recorded ${clips.length} interview clip(s) in ${Date.now() - t0}ms`);

    const done = await MockInterview.updateOne({ _id: interview._id, status: 'voicing' }, {
      $set: {
        status: 'ready',
        voice : { role: spec.role, model: spec.model, voice: spec.voice, healthMs: spec.healthMs, folder, clips, voicedAt: new Date(), log }
      }
    });
    if (!done.modifiedCount) throw new Error('interview changed while its audio was being recorded');
  } catch (err) {
    log.push(`failed: ${err.message}`);
    await deleteFolder(folder).catch(() => {});
    await MockInterview.updateOne({ _id: interview._id, status: 'voicing' }, {
      $set: { status: 'failed', failureReason: `voice: ${err.message}`, 'voice.log': log, 'voice.folder': '', 'voice.clips': [] }
    });
    throw err;
  }
}

// For interviews planned before pre-made audio existed, or whose audio was
// given back: starts recording in the background. Safe to call repeatedly.
export function startVoicing(interviewId) {
  voiceInterview(interviewId).catch(err => {
    if (!/is not in status "planned"/.test(err.message)) console.error(`Interview ${interviewId} voicing failed:`, err.message);
  });
}

async function deleteFolder(folder) {
  if (!folder) return;
  // invalidate: also purge CDN copies, or a signed link keeps working until the cache expires.
  await cloudinary.api.delete_resources_by_prefix(`${folder}/`, { resource_type: 'raw', type: 'authenticated', invalidate: true });
}

// Called once an interview no longer needs its audio (scored, or deleted).
export async function deleteInterviewAudio(interviewId) {
  const iv = await MockInterview.findById(interviewId).select('voice.folder').lean();
  if (!iv?.voice?.folder) return;
  await deleteFolder(iv.voice.folder);
  await MockInterview.updateOne({ _id: interviewId }, { $set: { 'voice.folder': '', 'voice.clips': [] } });
}

// Same, for interviews that are about to be deleted outright.
export async function deleteAudioFolders(folders) {
  await Promise.all(folders.filter(Boolean).map(f => deleteFolder(f).catch(err =>
    console.error(`Could not delete interview audio ${f}:`, err.message))));
}

// Ready interviews nobody started in ABANDONED_MS: free their audio and send
// them back to planned, so opening one records it again.
export async function sweepAbandonedAudio() {
  const stale = await MockInterview.find({ status: 'ready', 'voice.voicedAt': { $lt: new Date(Date.now() - ABANDONED_MS) } })
    .select('_id voice.folder').limit(20).lean();
  for (const iv of stale) {
    try {
      await deleteFolder(iv.voice.folder);
      await MockInterview.updateOne({ _id: iv._id, status: 'ready' }, { $set: { status: 'planned', 'voice.folder': '', 'voice.clips': [] } });
    } catch (err) {
      console.error(`Interview ${iv._id} audio sweep failed:`, err.message);
    }
  }
}
