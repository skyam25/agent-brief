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

declare module 'claude-code' {
  interface PluginState {
    'feedback-inbox': {
      sessions: FeedbackInboxSession[]
      ingesting: string | null
    }
  }
}
