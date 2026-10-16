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

declare module 'claude-code' {
  interface PluginState {
    'agent-brief': {
      sessions: FeedbackInboxSession[]
      ingesting: string | null
      tracking: boolean
      mode: SessionMode
      fidelity: PrototypeFidelity | null
      /** Which picker row the band shows in place of its buttons. */
      picking: 'none' | 'mode' | 'fidelity'
      shown: ShownState | null
      /** Claude's latest finished replies, oldest first, so their last block can carry Copy and Open in Agent Brief. */
      replies: string[]
      /** Dictation from the band's Talk button; null when it is off. */
      voice: VoiceState | null
    }
  }
}
