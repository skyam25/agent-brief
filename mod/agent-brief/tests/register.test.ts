import { describe, expect, mock, test } from 'claude-code/testing'

import { BAND, CWD, INBOX, SESSION, command, textOf, worldOf } from './world'

const LATEST = 'mcp__agent-brief__feedback_latest'
const LIST = 'mcp__agent-brief__feedback_list'

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal' as const],
  tools: [],
  outputStyle: null,
  traits: [],
}

describe('ingest on /apply-feedback', () => {
  test('nothing is ingested or announced until the user asks', async ($, on) => {
    const world = worldOf(on, { [`${INBOX}/pricing-1.zip`]: 'zip' })
    const clock = mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)
    expect(world.tools.sort()).toEqual(['feedback_latest', 'feedback_list'])
    expect(world.commands).toEqual(['apply-feedback', 'sketch'])
    await clock.advance(60_000)

    expect(world.runs.some(r => r.argv[1]?.endsWith('/bin/ingest.mjs'))).toBe(false)
    expect(world.toasts).toEqual([])
    expect(textOf(await $.ui.render(BAND))).not.toContain('feedback session')
    expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro'])
    const listed = String(((await $.tool.call({ tool: LIST } as never)) as { result?: unknown }).result)
    expect(listed).toContain('1 recording waits in the inbox')
  })

  test('ingests every waiting zip into this project, then applies the newest', async ($, on) => {
    const world = worldOf(on, { [`${INBOX}/pricing-1.zip`]: 'zip', [`${INBOX}/pricing-2.zip`]: 'zip' })
    const clock = mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)
    expect(await $.command.run(command('apply-feedback'))).toEqual({ text: 'Transcribing 2 recordings from the inbox…' })
    await clock.settle()

    const ingests = world.runs.filter(r => r.argv[1]?.endsWith('/bin/ingest.mjs'))
    expect(ingests.map(r => r.argv[2])).toEqual([`${INBOX}/processing/pricing-1.zip`, `${INBOX}/processing/pricing-2.zip`])
    expect(ingests[0]?.argv).toEqual([
      'node',
      expect.stringMatching(/\/bin\/ingest\.mjs$/),
      `${INBOX}/processing/pricing-1.zip`,
      '--project',
      CWD,
      '--transcriber',
      'yap',
    ])
    expect(ingests[0]?.timeoutMs).toBe(600_000)
    expect(world.files.has(`${INBOX}/done/pricing-1.zip`)).toBe(true)
    expect(world.files.has(`${INBOX}/done/pricing-2.zip`)).toBe(true)
    expect(world.submitted).toEqual([
      'Read .feedback/pricing-2/report.md and the screenshots it references. Blockquotes and annotations are my feedback. Summarize what I asked for, then do it.',
    ])
    expect(world.toasts).toEqual([])
    expect(textOf(await $.ui.render(BAND))).not.toContain('Transcribing')
  })

  test('skips a zip another session claimed first (A9)', async ($, on) => {
    const world = worldOf(on, { [`${INBOX}/taken.zip`]: 'zip' })
    world.answer = argv =>
      argv[0] === 'mv'
        ? { exitCode: 1, stdout: '', stderr: 'mv: rename: No such file or directory' }
        : { exitCode: 0, stdout: '', stderr: '' }
    const clock = mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)
    await $.command.run(command('apply-feedback'))
    await clock.settle()

    expect(world.runs.some(r => r.argv[1]?.endsWith('/bin/ingest.mjs'))).toBe(false)
    expect(world.submitted).toEqual([])
    expect(world.toasts).toEqual(['No feedback sessions in .feedback/ or the inbox yet.'])
  })

  test('moves a failed ingest to failed/ and toasts the error', async ($, on) => {
    const world = worldOf(on, { [`${INBOX}/old.zip`]: 'zip' })
    const base = world.answer
    world.answer = argv =>
      argv[1]?.endsWith('/bin/ingest.mjs')
        ? { exitCode: 1, stdout: '{"ok":false,"error":"session.json has no feedbackVersion"}\n', stderr: '' }
        : base(argv)
    const clock = mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)
    await $.command.run(command('apply-feedback'))
    await clock.settle()

    expect(world.files.has(`${INBOX}/failed/old.zip`)).toBe(true)
    expect(world.toasts).toEqual([
      'Feedback ingest failed (old): session.json has no feedbackVersion',
      'No feedback sessions in .feedback/ or the inbox yet.',
    ])
  })

  test('passes the whisper settings through', { options: { transcriber: 'whisper', whisperModel: '/m/ggml.bin' } }, async ($, on) => {
    const world = worldOf(on, { [`${INBOX}/w.zip`]: 'zip' })
    const clock = mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)
    await $.command.run(command('apply-feedback'))
    await clock.settle()

    const node = world.runs.find(r => r.argv[1]?.endsWith('/bin/ingest.mjs'))
    expect(node?.argv.slice(-4)).toEqual(['--transcriber', 'whisper', '--whisper-model', '/m/ggml.bin'])
  })
})

const ON_DISK = {
  [`${CWD}/.feedback/manual/report.md`]: '# Session Report: manual\n\n> 🎙️ [00:00] Rename the Pricing heading to Plans.\n',
  [`${CWD}/.feedback/manual/screenshots/001-0012.jpg`]: 'jpg',
  [`${CWD}/.feedback/manual/session.json`]: JSON.stringify({
    feedbackVersion: 1,
    events: [{ type: 'annotation' }, { type: 'voice-segment', payload: { transcript: 'Make it blue.' } }],
  }),
}

describe('hand-off', () => {
  test('feedback_latest returns the report and screenshots, then marks the session consumed', async ($, on) => {
    worldOf(on, ON_DISK)
    mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)
    const latest = await $.tool.call({ tool: LATEST } as never)
    const text = String((latest as { result?: unknown }).result)
    expect(text).toContain('Rename the Pricing heading to Plans.')
    expect(text).toContain(`${CWD}/.feedback/manual/screenshots/001-0012.jpg`)
    expect(text).toContain(`${CWD}/.feedback/manual/report.md`)

    const listed = String(((await $.tool.call({ tool: LIST } as never)) as { result?: unknown }).result)
    expect(listed).toContain('manual [applied] 1 annotation, 1 note')
    expect(listed).not.toContain('inbox')
  })

  test('/apply-feedback applies a session already on disk', async ($, on) => {
    const world = worldOf(on, ON_DISK)
    const clock = mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)
    expect(await $.command.run(command('apply-feedback'))).toEqual({ text: 'Applying feedback: manual' })
    await clock.settle()
    expect(world.submitted).toEqual([
      'Read .feedback/manual/report.md and the screenshots it references. Blockquotes and annotations are my feedback. Summarize what I asked for, then do it.',
    ])
  })

  test('/apply-feedback with an unknown name says so', async ($, on) => {
    worldOf(on)
    mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)
    expect(await $.command.run(command('apply-feedback', 'nope'))).toEqual({ text: 'No feedback session named "nope".' })
  })

  test('forgets stored sessions whose folder was removed', async ($, on) => {
    const world = worldOf(on, ON_DISK)
    const clock = mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)
    await $.command.run(command('apply-feedback'))
    await clock.settle()
    for (const path of Object.keys(ON_DISK)) world.files.delete(path)

    expect(await $.command.run(command('apply-feedback'))).toEqual({ text: 'No feedback sessions in .feedback/ or the inbox yet.' })
    const listed = String(((await $.tool.call({ tool: LIST } as never)) as { result?: unknown }).result)
    expect(listed).toBe('No feedback sessions in .feedback/ yet.')
  })
})
