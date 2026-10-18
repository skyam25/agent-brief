import type { ElementTable } from 'claude-code'

import type { AttachedInitiative, PrototypeFidelity, SessionMode, VoiceState } from '../types'
import { bandTitle } from './initiative'
import { FIDELITY_IDS, MODE_IDS, bandLabel, fidelityLabel, modeLabel } from './modes'
import type { ModeChoice } from './modes'
import { clockText } from './voice'

export type BandRow = 'none' | 'mode' | 'fidelity' | 'initiative'

export type BandView = {
  ingesting: string | null
  /** The Mode button shows until the session's first prompt. */
  hasPrompted: boolean
  /** The Brief button's label, with its count and mode suffix. */
  briefLabel: string
  mode: SessionMode
  fidelity: PrototypeFidelity | null
  picking: BandRow
  voice: VoiceState | null
  /** The attached initiative. The row reads `Attached <title> · change` while there is one. */
  initiative: AttachedInitiative | null
  /** What the change row offers: the attached initiative, then the recent ones. */
  choices: { id: string; title: string }[]
  /** Draws show.tsx's clear pixel at the row's end, until it learns whether pictures draw here. */
  probe?: { key: string; png: string }
}

export type BandActions = {
  open: (target: 'sketch' | 'stack' | 'write') => Promise<void>
  /** Opens the Brief pane, or closes it while open. */
  brief: () => Promise<void>
  /** Starts dictation, or stops it while listening. */
  talk: () => Promise<void>
  pick: (row: BandRow) => Promise<unknown>
  choose: (choice: ModeChoice) => Promise<void>
  /** Attaches the session to the initiative with this id. */
  attach: (id: string) => Promise<void>
  detach: () => Promise<void>
}

/**
 * One row with Sketch, Stack, Write, Talk, Mode and Brief buttons.
 * Mode shows until the session's first prompt; then the Brief pane's Select and /mode set it.
 * The Mode button swaps the row for a mode picker, and Prototype for a fidelity picker.
 * An attached initiative adds `Attached <title> · change`. Change swaps the row for a pick among the recent ones.
 */
export function bandTree(table: ElementTable, view: BandView, act: BandActions) {
  const { Box, Button, Text } = table
  const { Image } = table as Partial<ElementTable<'terminal'>>
  const { ingesting, hasPrompted, briefLabel, mode, fidelity, picking, voice, initiative, choices, probe } = view
  const current = (isCurrent: boolean) => (isCurrent ? { variant: 'primary' as const, autoFocus: true as const } : {})

  if (picking === 'mode') {
    return (
      <Box gap={1}>
        <Text dimColor>Mode</Text>
        {MODE_IDS.map(id => (
          <Button
            key={`mode-${id}`}
            label={modeLabel(id)}
            {...current(id === mode)}
            onPress={() => void (id === 'prototype' ? act.pick('fidelity') : act.choose({ mode: id, fidelity: null }))}
          />
        ))}
        <Button key="mode-cancel" label="Cancel" dimColor onPress={() => void act.pick('none')} />
      </Box>
    )
  }

  if (picking === 'fidelity') {
    return (
      <Box gap={1}>
        <Text dimColor>Prototype fidelity</Text>
        {FIDELITY_IDS.map(id => (
          <Button
            key={`fidelity-${id}`}
            label={fidelityLabel(id)}
            {...current(mode === 'prototype' && id === fidelity)}
            onPress={() => void act.choose({ mode: 'prototype', fidelity: id })}
          />
        ))}
        <Button key="fidelity-back" label="Back" dimColor onPress={() => void act.pick('mode')} />
      </Box>
    )
  }

  if (picking === 'initiative') {
    return (
      <Box gap={1}>
        <Text dimColor>Initiative</Text>
        {choices.map(c => (
          <Button
            key={`initiative-${c.id}`}
            label={bandTitle(c.title)}
            {...current(c.id === initiative?.id)}
            onPress={() => void (c.id === initiative?.id ? act.pick('none') : act.attach(c.id))}
          />
        ))}
        {initiative !== null && <Button key="initiative-detach" label="Detach" onPress={() => void act.detach()} />}
        <Button key="initiative-cancel" label="Cancel" dimColor onPress={() => void act.pick('none')} />
      </Box>
    )
  }

  return (
    <Box>
      <Button key="sketch" label="✎ Sketch" hotkey="s" onPress={() => void act.open('sketch')} />
      <Text> </Text>
      <Button key="stack" label="▤ Stack" hotkey="k" onPress={() => void act.open('stack')} />
      <Text> </Text>
      <Button key="write" label="¶ Write" hotkey="w" onPress={() => void act.open('write')} />
      <Text> </Text>
      <Button
        key="talk"
        label={voice === null ? '🎙 Talk' : '■ Stop'}
        hotkey="v"
        {...(voice !== null ? { variant: 'primary' as const } : {})}
        onPress={() => void act.talk()}
      />
      {!hasPrompted && <Text> </Text>}
      {!hasPrompted && (
        <Button
          key="mode"
          label={bandLabel(mode, fidelity)}
          hotkey="m"
          {...(mode !== 'default' ? { variant: 'primary' as const } : {})}
          onPress={() => void act.pick('mode')}
        />
      )}
      <Text> </Text>
      <Button key="brief" label={briefLabel} hotkey="b" onPress={() => void act.brief()} />
      {initiative !== null && <Text dimColor>{`  Attached ${bandTitle(initiative.title)} · `}</Text>}
      {initiative !== null && (
        <Button key="initiative-change" plain dimColor label="change" hotkey="i" onPress={() => void act.pick('initiative')} />
      )}
      {voice?.phase === 'listening' && <Text dimColor>{` Listening ${clockText(voice.seconds)}`}</Text>}
      {voice?.phase === 'finishing' && <Text dimColor> Transcribing…</Text>}
      {ingesting !== null && <Text dimColor> Transcribing feedback: {ingesting}…</Text>}
      {probe && Image && <Image key={probe.key} source={{ png: probe.png }} columns={1} rows={1} alt=" " />}
    </Box>
  )
}
