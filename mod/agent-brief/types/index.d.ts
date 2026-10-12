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
    }
  }
}
