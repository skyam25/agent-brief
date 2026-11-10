import type { ElementTable } from 'claude-code'

import type { AttachedInitiative, PrototypeFidelity, SessionMode, VoiceState } from '../types'
import { bandTitle } from './initiative'
import { FIDELITY_IDS, MODE_IDS, bandLabel, fidelityLabel, modeLabel } from './modes'
import type { ModeChoice } from './modes'
import { clockText } from './voice'

export type BandRow = 'none' | 'mode' | 'fidelity' | 'initiative'

export type OpenTarget = 'sketch' | 'stack' | 'write'

const OPEN_OPTIONS: { value: OpenTarget; label: string; hotkey: string }[] = [
  { value: 'sketch', label: '✎ Sketch', hotkey: 's' },
  { value: 'stack', label: '▤ Stack', hotkey: 'k' },
  { value: 'write', label: '¶ Write', hotkey: 'w' },
]

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
  /** The attached initiative. The row reads `◆ <title>` while there is one, and `attach initiative` otherwise. */
  initiative: AttachedInitiative | null
  /** What the change row offers: the attached initiative, then the recent ones. */
  choices: { id: string; title: string }[]
  /** The iPad button shows only while the app says an iPad is paired. */
  ipadPaired: boolean
  /** In the Herdr app the picker offers Sketch and Write only, and the iPad button never shows. */
  isHerdr: boolean
  /** What the open picker shows: the last of Sketch, Stack and Write picked in this session. */
  lastOpen: OpenTarget
  /** False on a surface that may draw no Select, as mobile. The row then has one button each. */
  hasFields: boolean
  /** Draws show.tsx's clear pixel at the row's end, until it learns whether pictures draw here. */
  probe?: { key: string; png: string }
}

export type BandActions = {
  /** Opens the target and makes it the one the open picker shows. */
  open: (target: OpenTarget) => Promise<void>
  /** Asks the paired iPad for a sketch, tied to this session. */
  ipad: () => Promise<void>
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
 * Where the band's focus goes when its row changes: the current choice in a pick row, and Brief back on the main row.
 * The ring otherwise keeps its position, which can land on the wrong choice or on the open picker, which takes every key.
 */
export function bandFocusKey(row: BandRow, view: Pick<BandView, 'mode' | 'fidelity' | 'initiative' | 'choices'>): string {
  if (row === 'mode') return `mode-${view.mode}`
  if (row === 'fidelity') return `fidelity-${view.mode === 'prototype' && view.fidelity !== null ? view.fidelity : FIDELITY_IDS[0]}`
  if (row === 'initiative') {
    const current = view.choices.find(c => c.id === view.initiative?.id) ?? view.choices[0]
    return current ? `initiative-${current.id}` : 'initiative-cancel'
  }
  return 'brief'
}

/**
 * One row with the open picker, Talk, Mode and Brief, and an iPad button at the end while an iPad is paired.
 * In the Herdr app the picker drops Stack and the iPad button never shows.
 * The picker shows the last of Sketch, Stack and Write picked. Enter opens it, and its list opens the others.
 * A focused Select takes every key, so the band's focus starts on Brief and the hotkeys keep working.
 * Mode shows until the session's first prompt; then the Brief pane's Select and /mode set it.
 * The Mode button swaps the row for a mode picker, and Prototype for a fidelity picker.
 * An attached initiative adds `◆ <title>`, which opens the pick. Without one, `attach initiative` shows while there are any to pick.
 * Either swaps the row for a pick among the recent ones.
 */
export function bandTree(table: ElementTable, view: BandView, act: BandActions) {
  const { Box, Button, Text } = table
  const { Image, Select } = table as Partial<ElementTable<'terminal'>>
  const { ingesting, hasPrompted, briefLabel, mode, fidelity, picking, voice, initiative, choices, ipadPaired, isHerdr, lastOpen, hasFields, probe } = view
  const opens = isHerdr ? OPEN_OPTIONS.filter(o => o.value !== 'stack') : OPEN_OPTIONS
  const shown = opens.some(o => o.value === lastOpen) ? lastOpen : opens[0]!.value
  const hasIpad = ipadPaired && !isHerdr
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
      {hasFields && Select ? (
        <Select
          key="open"
          value={shown}
          options={opens.map(({ value, label }) => ({ value, label }))}
          onSelect={value => void act.open(value as OpenTarget)}
        />
      ) : (
        opens.map(({ value, label, hotkey }) => (
          <Box key={`open-${value}`}>
            <Button key={value} label={label} hotkey={hotkey} onPress={() => void act.open(value)} />
            <Text> </Text>
          </Box>
        ))
      )}
      {hasFields && Select && <Text> </Text>}
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
      <Button key="brief" label={briefLabel} hotkey="b" {...(hasFields && Select ? { autoFocus: true as const } : {})} onPress={() => void act.brief()} />
      {initiative !== null && <Text>  </Text>}
      {initiative !== null && (
        <Button key="initiative-change" plain dimColor label={`◆ ${bandTitle(initiative.title)}`} hotkey="i" onPress={() => void act.pick('initiative')} />
      )}
      {initiative === null && choices.length > 0 && <Text>  </Text>}
      {initiative === null && choices.length > 0 && (
        <Button key="initiative-attach" plain dimColor label="attach initiative" hotkey="i" onPress={() => void act.pick('initiative')} />
      )}
      {hasIpad && <Text> </Text>}
      {hasIpad && <Button key="ipad" label="↗ iPad" hotkey="p" onPress={() => void act.ipad()} />}
      {voice?.phase === 'listening' && <Text dimColor>{` Listening ${clockText(voice.seconds)}`}</Text>}
      {voice?.phase === 'finishing' && <Text dimColor> Transcribing…</Text>}
      {ingesting !== null && <Text dimColor> Transcribing feedback: {ingesting}…</Text>}
      {probe && Image && <Image key={probe.key} source={{ png: probe.png }} columns={1} rows={1} alt=" " />}
    </Box>
  )
}
