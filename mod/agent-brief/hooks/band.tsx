import type { ElementTable } from 'claude-code'

import type { PrototypeFidelity, SessionMode } from '../types'
import { FIDELITY_IDS, MODE_IDS, bandLabel, fidelityLabel, modeLabel } from './modes'
import type { ModeChoice } from './modes'

export type BandRow = 'none' | 'mode' | 'fidelity'

export type BandView = {
  ingesting: string | null
  isTracking: boolean
  mode: SessionMode
  fidelity: PrototypeFidelity | null
  picking: BandRow
}

export type BandActions = {
  open: (target: 'sketch' | 'stack' | 'write') => Promise<void>
  track: () => Promise<void>
  pick: (row: BandRow) => Promise<unknown>
  choose: (choice: ModeChoice) => Promise<void>
}

/**
 * One row with Sketch, Stack, Write, Track and Mode buttons.
 * The Mode button swaps the row for a mode picker, and Prototype for a fidelity picker.
 */
export function bandTree({ Box, Button, Text }: ElementTable, view: BandView, act: BandActions) {
  const { ingesting, isTracking, mode, fidelity, picking } = view
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

  return (
    <Box>
      <Button key="sketch" label="✎ Sketch" hotkey="s" onPress={() => void act.open('sketch')} />
      <Text> </Text>
      <Button key="stack" label="▤ Stack" hotkey="k" onPress={() => void act.open('stack')} />
      <Text> </Text>
      <Button key="write" label="¶ Write" hotkey="w" onPress={() => void act.open('write')} />
      <Text> </Text>
      <Button
        key="track"
        label={isTracking ? '☑ Track' : '☐ Track'}
        hotkey="t"
        {...(isTracking ? { variant: 'primary' as const } : {})}
        onPress={() => void act.track()}
      />
      <Text> </Text>
      <Button
        key="mode"
        label={bandLabel(mode, fidelity)}
        hotkey="m"
        {...(mode !== 'default' ? { variant: 'primary' as const } : {})}
        onPress={() => void act.pick('mode')}
      />
      {ingesting !== null && <Text dimColor> Transcribing feedback: {ingesting}…</Text>}
    </Box>
  )
}
