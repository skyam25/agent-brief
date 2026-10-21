export type FeedbackInboxCounts = {
  annotations: number
  notes: number
  utterances: number
  markers: number
}

export type FeedbackInboxSession = {
  name: string
  dir: string
  reportPath: string
  screenshots: string[]
  counts: FeedbackInboxCounts | null
  ingestedAt: number
  isConsumed: boolean
}

/** As `SessionMode` and `PrototypeFidelity` in hooks/companion-protocol.ts. */
export type SessionMode = 'default' | 'product' | 'prototype' | 'orchestrate'

export type PrototypeFidelity = 'wireframe' | 'styled' | 'live-patch' | 'freeze-patch' | 'interactive' | 'existing'

/** As `Shown` in hooks/show-logic.ts: what the /show pane draws. */
export type ShownState = {
  title: string
  items: { path: string; source: string; width: number; height: number; title: string }[]
  url?: string
  board?: string
}

/** Band dictation: yap is listening, or has been told to stop and is printing its transcript. */
export type VoiceState = { phase: 'listening' | 'finishing'; seconds: number }

/** As `OutputRecord` in hooks/companion-protocol.ts: one record of the session's outputs file. */
export type BriefOutput = {
  ref: string
  url?: string
  title?: string
  kind: string
  tier: 'declared' | 'detected'
  status?: 'drafting' | 'ready'
  origin?: 'created' | 'edited'
  declaredAt?: number
  firstWriteAt?: number
  lastWriteAt?: number
  writes?: number
}

/** A board the app files under this session, as `GET /boards` lists it. */
export type BriefBoard = { name: string; updatedAt: number }

/** The session's items file as the Brief pane last read it. `text` is null while the file does not exist. */
export type BriefItems = { path: string; relPath: string; text: string | null }

/** An answer the Brief pane holds for item `n` until Send. */
export type BriefAnswer = { n: number; text: string }

/** How the Brief pane takes an answer to a question: a Button per option, a Select, or an Input. */
export type QuestionKind = 'options' | 'select' | 'text'

/**
 * A question Claude asked with ask_questions, and the answer the Brief pane holds until Send.
 * `isOther` is set while an options or select question takes the user's own words instead of a listed option.
 */
export type BriefQuestion = { id: string; text: string; kind: QuestionKind; options?: string[]; answer?: string; isOther?: true }

/**
 * What the Brief pane has folded open, and whether its Mode Select waits on a fidelity.
 * `isExpanded` makes the pane draw the full Brief while seated inline above the prompt.
 */
export type BriefView = { isPrototypePending: boolean; isTouchedOpen: boolean; isDoneOpen: boolean; isExpanded: boolean }

/** The initiative this session is attached to, as the band and the Brief pane show it. As `InitiativeSnapshot` in hooks/companion-protocol.ts. */
export type AttachedInitiative = { id: string; title: string; revision: number; attachmentRevision: number }

/** A recent initiative, as `InitiativeSummary` in hooks/companion-protocol.ts. */
export type InitiativeChoice = { id: string; title: string; line: string }

/** As `FiledNote` in hooks/companion-logic.ts. */
export type FiledNote = { id: string; title?: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-brief': {
      sessions: FeedbackInboxSession[]
      ingesting: string | null
      tracking: boolean
      mode: SessionMode
      fidelity: PrototypeFidelity | null
      /** Which picker row the band shows in place of its buttons. */
      picking: 'none' | 'mode' | 'fidelity' | 'initiative'
      shown: ShownState | null
      /** Claude's latest finished replies, oldest first, so their last block can carry Copy and Open in Agent Brief. */
      replies: string[]
      /** Notes Claude filed with `agent-brief note` since the last finished reply. */
      turnNotes: FiledNote[]
      /** The notes each kept reply's turn filed, keyed by the reply's text. */
      replyNotes: Record<string, FiledNote[]>
      /** Dictation from the band's Talk button; null when it is off. */
      voice: VoiceState | null
      /** The folder the session started in. The shell's folder moves with each cd; this one stays. */
      home: string | null
      /** Epoch ms when the main loop last finished a reply. */
      activeAt: number | null
      /** True once the session has a submitted prompt. The band drops its Mode button then. */
      hasPrompted: boolean
      /** The session's outputs file records, kept current by each write. */
      outputs: BriefOutput[]
      /** This session's boards in the app, read with the Brief, after each agent-brief command and each minute the pane shows. */
      boards: BriefBoard[]
      /** Open feedback items by output ref, read with the Brief and after each turn. */
      feedback: Record<string, number>
      /** The session's items file, read at start, on each write and when the Brief pane opens. */
      items: BriefItems | null
      /** Answers the Brief pane holds until Send answers. */
      answers: BriefAnswer[]
      brief: BriefView
      /** Claude's open questions from ask_questions, in the order asked. */
      questions: BriefQuestion[]
      /** True while /grill has Claude interview the user before it starts. */
      grilling: boolean
      /** The attached initiative; null while the session has none or the app has not said. */
      initiative: AttachedInitiative | null
      /** Up to 20 initiatives, most recent first, read when the session registers, when the band's pick row opens and when the Brief pane draws. */
      recentInitiatives: InitiativeChoice[]
      /** How many initiative changes the app refused, which keys the Brief pane's Select afresh. */
      initiativeRefusals: number
      /** The snapshot last appended to a prompt: its token, its title, and the session it went to. */
      initiativeSent: { sessionId: string; token: string; title: string } | null
      /** True after a compaction, so the next prompt carries the snapshot again. */
      isInitiativeStale: boolean
      /** True once the session needs no recent-initiatives line: initiative context went out, or the session resumed. */
      isRecentLineDone: boolean
    }
  }
}
