/** Send: turns what the panel hands over into a delivery for the target session or a new one, and records it. */

import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDraft, cleanSourcePath, freeId, rewriteImages, writeBundle } from '../server/bundle';
import type { CompanionServer, DeliveryInput } from '../server/contract';
import { isTextPayload, type Launcher, type Outgoing, type SendPayload, type SendResult } from '../shared/ipc';
import { cleanReview } from '../shared/review';
import { composeDelivery, findTool } from '../voice/compose';
import type { Briefs } from './briefs';
import { deliveryImages, type DraftStore } from './drafts';
import type { SendHistory } from './history';
import { startCommand } from './launch';
import type { StateFile } from './store';
import { LAUNCHER_NAMES, type Terminals } from './terminals';

const RECENT_PROJECTS = 8;

export interface SenderDeps {
  state: StateFile;
  history: SendHistory;
  drafts: DraftStore;
  server: CompanionServer;
  briefs: Briefs;
  terminals: Terminals;
  /** Scratch space for turning voice clips into text. */
  voiceDir: string;
}

/** Puts these folders first in the recent projects a new session can start in. */
export function rememberProjects(state: StateFile, cwds: string[]): void {
  const prev = state.state.recentProjects ?? [];
  const next = [...new Set([...cwds, ...prev])].slice(0, RECENT_PROJECTS);
  if (next.join('\n') !== prev.join('\n')) state.update({ recentProjects: next });
}

/** A Send's review, checked. Its path must be one the prompt may name. */
function reviewOf(p: Outgoing): DeliveryInput['review'] {
  const review = p.review && cleanReview(p.review);
  if (!review || !cleanSourcePath(review.path)) return undefined;
  const body = typeof p.review?.body === 'string' ? p.review.body : undefined;
  return { ...review, ...(body?.trim() ? { body } : {}) };
}

/** The delivery fields a draft adds: its pictures, the file it copies, and its review. */
function draftFields(p: Outgoing): Pick<DeliveryInput, 'images' | 'sourcePath' | 'review'> {
  const images = deliveryImages(p.images);
  const sourcePath = cleanSourcePath(p.sourcePath);
  const review = reviewOf(p);
  return { ...(images.length ? { images } : {}), ...(sourcePath ? { sourcePath } : {}), ...(review ? { review } : {}) };
}

/** History fields that depend on what went out. The text points at bundle `id`'s picture files. */
const sent = (input: DeliveryInput, id: string) => ({
  ...(input.boardName ? { board: input.boardName } : {}),
  ...(input.text ? { text: rewriteImages(input.text, id, input.images ?? []) } : {}),
  ...(input.notes ? { notes: input.notes } : {}),
});

export class Sender {
  constructor(private readonly deps: SenderDeps) {}

  /** A delivery from either mode. A written draft alone needs no voice work. */
  async compose(p: Outgoing): Promise<{ input: DeliveryInput; warnings: string[] }> {
    if (!isTextPayload(p)) return this.composeSketch(p);
    return { input: { boardName: '', text: p.text, ...draftFields(p), mode: this.deps.state.state.deliveryMode }, warnings: [] };
  }

  /**
   * Turns a sketch Send into a delivery: transcribes the voice clips with ffmpeg and yap
   * and builds timeline.md. Problems with voice come back as warnings, so the sketch still goes out.
   */
  async composeSketch(p: SendPayload): Promise<{ input: DeliveryInput; warnings: string[] }> {
    const warnings: string[] = [];
    const segments = p.segments.map((s) => ({ ...s, data: Buffer.from(s.data) }));
    const ffmpegPath = findTool('ffmpeg');
    const yapPath = findTool('yap');
    if (segments.length > 0 && (!ffmpegPath || !yapPath)) {
      warnings.push(`voice not transcribed: ${!ffmpegPath ? 'ffmpeg' : 'yap'} not found`);
    }
    const input = await composeDelivery({
      boardName: p.boardName,
      png: Buffer.from(p.png),
      scene: p.scene,
      notes: p.notes || undefined,
      strokes: p.strokes,
      segments,
      bounds: p.bounds,
      mode: this.deps.state.state.deliveryMode,
      text: p.text || undefined,
      transcribe: {
        ffmpegPath: ffmpegPath ?? 'ffmpeg',
        yapPath: yapPath ?? 'yap',
        tmpDir: this.deps.voiceDir,
        onError: (segment, message) => {
          if (ffmpegPath && yapPath) warnings.push(`${segment}: ${message}`);
        },
      },
    });
    return { input: { ...input, ...draftFields(p) }, warnings };
  }

  /** Delivers to the target session and records the send in the history. */
  async send(payload: Outgoing): Promise<SendResult> {
    const { server } = this.deps;
    if (!server.sessions().targetSessionId) return { ok: false, message: 'Choose a session to send to.' };
    try {
      const { input, warnings } = await this.compose(payload);
      const delivery = await server.deliver(input);
      const target = this.sessionName(delivery.sessionId);
      this.record({ id: delivery.id, sentAt: delivery.createdAt, target, dir: delivery.dir, draft: delivery.draft, ...sent(input, delivery.id) }, input);
      this.usedUp(payload);
      for (const w of warnings) console.warn(`[companion] ${w}`);
      const note = warnings.length ? ` (${warnings[0]})` : '';
      return { ok: true, message: `Sent to ${target}${note}` };
    } catch (err) {
      return { ok: false, message: `Send failed: ${(err as Error).message}` };
    }
  }

  /** Writes the bundle into `cwd`, then starts Claude Code there on it, or copies the command that does. */
  async sendNew(payload: Outgoing, { cwd, via }: { cwd: string; via: Launcher }): Promise<SendResult> {
    try {
      return await this.startNew(payload, cwd, via);
    } catch (err) {
      return { ok: false, message: `Could not start Claude Code: ${(err as Error).message}` };
    }
  }

  private async startNew(payload: Outgoing, cwd: string, via: Launcher): Promise<SendResult> {
    const { state, terminals } = this.deps;
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return { ok: false, message: `No folder at ${cwd}` };
    const { input, warnings } = await this.compose(payload);
    const sentAt = Date.now();
    const sketches = join(cwd, '.feedback', 'sketches');
    const id = freeId(sketches, sentAt);
    const dir = join(sketches, id);
    await writeBundle(dir, input);
    const draft = buildDraft(id, input);
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, draft);
    rememberProjects(state, [cwd]);
    this.record({ id, sentAt, target: `new session (${LAUNCHER_NAMES[via]})`, dir, draft, ...sent(input, id) }, input);
    for (const w of warnings) console.warn(`[companion] ${w}`);
    if (via === 'copy') {
      terminals.copy(startCommand(cwd, promptPath));
      this.usedUp(payload);
      const what = input.png ? 'sketch' : 'draft';
      return { ok: true, message: `Copied a command that starts Claude Code on this ${what}. Paste it into a terminal.` };
    }
    await terminals.start(via, cwd, promptPath);
    this.usedUp(payload);
    return { ok: true, message: `Started Claude Code in ${LAUNCHER_NAMES[via]}` };
  }

  private sessionName(id: string | undefined): string {
    const s = this.deps.server.sessions().sessions.find((x) => x.sessionId === id);
    return s?.title || s?.cwd.split('/').filter(Boolean).pop() || id || 'the session';
  }

  private record(entry: Parameters<SendHistory['add']>[0], input: DeliveryInput): void {
    try {
      this.deps.history.add(entry, { png: input.png, scene: input.scene });
    } catch (err) {
      console.warn(`[companion] could not record the send: ${(err as Error).message}`);
    }
  }

  /** Deletes the draft a successful Send used up. History keeps its text. The Send went out even if this fails. */
  private usedUp(payload: Outgoing): void {
    if (!payload.draftId) return;
    try {
      this.deps.drafts.remove(payload.draftId);
      this.deps.briefs.touched({ draftId: payload.draftId });
    } catch (err) {
      console.warn(`[companion] could not delete the sent draft: ${(err as Error).message}`);
    }
  }
}
