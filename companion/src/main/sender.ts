/** Send: turns what the panel hands over into a delivery for the target session or a new one, and records it. */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDraft, cleanSourcePath, freeId, rewriteImages, writeBundle } from '../server/bundle';
import type { CompanionServer, DeliveryInput } from '../server/contract';
import { feedbackDir, tidyFeedback } from '../server/feedback-dir';
import { isTextPayload, type Launcher, type Outgoing, type SendPayload, type SendResult } from '../shared/ipc';
import { cleanBoardComments } from '../shared/board-comments';
import { cleanAnnotations } from '../shared/annotations';
import { cleanReview } from '../shared/review';
import { portablePrompt } from '../shared/sessions';
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

/** A Send's comments on passages of its draft, checked, with the note's name. */
function annotationsOf(p: Outgoing): DeliveryInput['annotations'] {
  const annotations = cleanAnnotations(p.annotations);
  if (!annotations) return undefined;
  const title = typeof p.annotations?.title === 'string' ? p.annotations.title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const noteId = typeof p.annotations?.noteId === 'string' && /^[\w-]{1,64}$/.test(p.annotations.noteId) ? p.annotations.noteId : undefined;
  return { ...annotations, ...(title ? { title } : {}), ...(noteId ? { noteId } : {}) };
}

/** The delivery fields a draft adds: its pictures, the file it copies, its review, and its comments. */
function draftFields(p: Outgoing): Pick<DeliveryInput, 'images' | 'sourcePath' | 'review' | 'annotations'> {
  const images = deliveryImages(p.images);
  const sourcePath = cleanSourcePath(p.sourcePath);
  const review = reviewOf(p);
  const annotations = review ? undefined : annotationsOf(p);
  return {
    ...(images.length ? { images } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(review ? { review } : {}),
    ...(annotations ? { annotations } : {}),
  };
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
    const comments = cleanBoardComments(p.comments);
    return { input: { ...input, ...draftFields(p), ...(comments ? { comments } : {}) }, warnings };
  }

  /** Delivers to the target session and records the send in the history. */
  async send(payload: Outgoing, requestedSessionId?: string): Promise<SendResult> {
    const { server } = this.deps;
    const sessionId = requestedSessionId ?? server.sessions().targetSessionId;
    if (!sessionId) return { ok: false, message: 'Choose a session to send to.' };
    try {
      this.checkFileProject(payload, this.deps.briefs.cwdOf(sessionId));
      const { input, warnings } = await this.compose(payload);
      const delivery = await server.deliver({ ...input, sessionId });
      const target = this.sessionName(delivery.sessionId);
      this.record(
        { id: delivery.id, sentAt: delivery.createdAt, target, sessionId: delivery.sessionId, dir: delivery.dir, draft: delivery.draft, ...sent(input, delivery.id) },
        input,
      );
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

  /** Writes the bundle into `cwd` and copies a prompt with absolute paths, to paste into any session. */
  async copyPrompt(payload: Outgoing, cwd: string): Promise<SendResult> {
    try {
      const { id, dir, draft, input, warnings } = await this.saveBundle(payload, cwd);
      this.record({ id, sentAt: Date.now(), target: 'the clipboard', dir, draft, ...sent(input, id) }, input);
      for (const w of warnings) console.warn(`[companion] ${w}`);
      this.deps.terminals.copy(portablePrompt(draft, id, dir));
      this.usedUp(payload);
      return { ok: true, message: 'Copied the prompt. Paste it into the session it is for.' };
    } catch (err) {
      return { ok: false, message: `Could not copy the prompt: ${(err as Error).message}` };
    }
  }

  /** Writes the bundle and its prompt file under `cwd`'s `.feedback/sketches`. */
  private async saveBundle(payload: Outgoing, cwd: string) {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`No folder at ${cwd}`);
    this.checkFileProject(payload, cwd);
    const { input, warnings } = await this.compose(payload);
    const sketches = join(feedbackDir(cwd), 'sketches');
    const id = freeId(sketches, Date.now());
    const dir = join(sketches, id);
    await writeBundle(dir, input);
    tidyFeedback(feedbackDir(cwd), Date.now());
    const draft = buildDraft(id, input, cwd);
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, draft);
    rememberProjects(this.deps.state, [cwd]);
    return { id, dir, draft, promptPath, input, warnings };
  }

  private async startNew(payload: Outgoing, cwd: string, via: Launcher): Promise<SendResult> {
    const { terminals } = this.deps;
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return { ok: false, message: `No folder at ${cwd}` };
    const sentAt = Date.now();
    const { id, dir, draft, promptPath, input, warnings } = await this.saveBundle(payload, cwd);
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

  /** A relative file path must keep naming the project it came from after a note is refiled. */
  private checkFileProject(payload: Outgoing, destination: string | undefined): void {
    if (!payload.sourcePath && !payload.review) return;
    const draft = payload.draftId ? this.deps.drafts.get(payload.draftId) : undefined;
    const owner = payload.fileSessionId ?? draft?.source?.sessionId ?? draft?.sessionId;
    if (!owner) throw new Error('Reopen the output in its project before sending this review.');
    const source = this.deps.briefs.cwdOf(owner);
    if (!source || !destination || !existsSync(source) || !existsSync(destination)) throw new Error('The source project is unavailable. Reopen the output before sending.');
    if (realpathSync(source) !== realpathSync(destination)) throw new Error('This note reviews a file in another project. Send it to a session in its original project, or copy its text into a new note.');
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
      const stored = this.deps.drafts.get(payload.draftId);
      if (payload.draftRevision !== undefined && stored && stored.updatedAt > payload.draftRevision) return;
      this.deps.drafts.remove(payload.draftId);
      this.deps.briefs.touched({ draftId: payload.draftId });
    } catch (err) {
      console.warn(`[companion] could not delete the sent draft: ${(err as Error).message}`);
    }
  }
}
