import type { ElementTable, RenderElement } from 'claude-code'

import type { AttachedInitiative, BriefAnswer, BriefBoard, BriefItems, BriefOutput, BriefView, PrototypeFidelity, SessionMode } from '../types'
import { AGREE_TEXT, ago, briefCounts, inlineSummary, itemRows, outputRows } from './brief-logic'
import type { ItemRow, OutputRow } from './brief-logic'
import { DEFAULT_FIDELITY, FIDELITY_IDS, MODE_IDS, fidelityLabel, modeLabel } from './modes'

export type BriefPaneView = {
  placement: 'dock' | 'inline'
  /** False on a surface that draws no Input or Select, as mobile. */
  hasFields: boolean
  project: string
  mode: SessionMode
  fidelity: PrototypeFidelity | null
  isTracking: boolean
  outputs: BriefOutput[]
  /** The boards the app files under this session. */
  boards: BriefBoard[]
  /** Epoch ms the pane draws at, for each output's age. */
  now: number
  /** Open feedback items by output ref. */
  feedback: Record<string, number>
  items: BriefItems | null
  answers: BriefAnswer[]
  /** How many questions Claude asked that wait in the Questions section. */
  asked: number
  view: BriefView
  /** The attached initiative, or null while the session has none. */
  initiative: AttachedInitiative | null
  /** What the Initiative Select offers: the attached initiative, then the recent ones. */
  initiatives: { id: string; title: string }[]
  /** How many initiative changes the app refused. Each gives the Select a new key, so it drops the refused pick. */
  refusals: number
}

export type BriefActions = {
  /** Opens the file in its default app, or the URL in the browser. */
  open: (ref: string) => Promise<void>
  /** Opens a Markdown/HTML output or a file's Feedback view in Agent Brief. */
  openInApp: (ref: string, tab?: 'feedback') => Promise<void>
  /** Shows one of the session's boards in the Agent Brief app. */
  openBoard: (name: string) => Promise<void>
  pickMode: (mode: SessionMode) => Promise<void>
  pickFidelity: (fidelity: PrototypeFidelity) => Promise<void>
  attach: (id: string) => Promise<void>
  detach: () => Promise<void>
  track: () => Promise<void>
  hold: (n: number, text: string) => Promise<void>
  clear: (n: number) => Promise<void>
  send: () => Promise<void>
  /** `expanded` swaps the inline seat between its summary line and the full Brief. */
  fold: (section: 'touched' | 'done' | 'expanded') => Promise<void>
}

/**
 * Sections drawn by other modules.
 * `questions` is the Questions section's tree. It draws between Outputs and Items,
 * and it brings its own Send: Items and Questions never share one.
 */
export type BriefSlots = { questions?: RenderElement | null }

/**
 * The Brief pane: a header with the Mode Select and the Initiative Select, Outputs, the Questions slot, then Items.
 * Outputs lists declared outputs, the session's boards, then touched documents.
 * Without fields, or with no initiatives to pick, the Initiative line is text.
 * Seated inline above the prompt it draws one summary line and the Ready outputs, until Expand.
 * There a Markdown or HTML output opens in Agent Brief, since the inline line has no In Agent Brief button.
 */
export function briefTree(table: ElementTable, pane: BriefPaneView, act: BriefActions, slots: BriefSlots = {}) {
  if (pane.placement === 'inline' && !pane.view.isExpanded) return inlineTree(table, pane, act)
  const { Box, Button, Text } = table
  return (
    <Box flexDirection="column">
      {pane.placement === 'inline' && (
        <Button key="brief-expand" plain dimColor label="▾ Collapse" onPress={() => void act.fold('expanded')} />
      )}
      {headerTree(table, pane, act)}
      {outputsTree(table, pane, act)}
      {slots.questions ? <Box marginTop={1}>{slots.questions}</Box> : null}
      {itemsTree(table, pane, act)}
      <Text> </Text>
    </Box>
  )
}

function inlineTree(table: ElementTable, pane: BriefPaneView, act: BriefActions) {
  const { Box, Button, Text } = table
  const ready = outputRows(pane.outputs).declared.filter(r => r.status === 'Ready')
  return (
    <Box flexDirection="column">
      <Text>{inlineSummary(briefCounts(pane.outputs, pane.items?.text ?? null, pane.asked), pane.mode)}</Text>
      {ready.length > 0 && (
        <Box flexWrap="wrap" columnGap={1}>
          {ready.map(row => (
            <Button
              key={`inline-open-${row.ref}`}
              plain
              label={`Open ${row.label}`}
              onPress={() => void (row.canBrief ? act.openInApp(row.ref, row.feedback === undefined ? undefined : 'feedback') : act.open(row.ref))}
            />
          ))}
        </Box>
      )}
      <Button key="brief-expand" plain dimColor label="▸ Expand" onPress={() => void act.fold('expanded')} />
    </Box>
  )
}

function headerTree(table: ElementTable, pane: BriefPaneView, act: BriefActions) {
  const { Box, Text } = table
  const { Select } = (pane.hasFields ? table : {}) as Partial<ElementTable<'terminal'>>
  const { mode, fidelity, view } = pane
  const showsFidelity = mode === 'prototype' || view.isPrototypePending
  const fidelityOptions = [
    ...(view.isPrototypePending ? [{ value: '', label: 'Pick a fidelity' }] : []),
    ...FIDELITY_IDS.map(id => ({ value: id, label: fidelityLabel(id) })),
  ]
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>{`Brief · ${pane.project}`}</Text>
        {Select ? (
          <Select
            key="brief-mode"
            options={MODE_IDS.map(id => ({ value: id, label: modeLabel(id) }))}
            value={view.isPrototypePending ? 'prototype' : mode}
            onSelect={value => void act.pickMode(value as SessionMode)}
          />
        ) : (
          <Text dimColor>{modeLabel(mode)}</Text>
        )}
      </Box>
      {showsFidelity && Select && (
        <Box justifyContent="flex-end">
          <Select
            key="brief-fidelity"
            label="Fidelity"
            options={fidelityOptions}
            value={view.isPrototypePending ? '' : (fidelity ?? DEFAULT_FIDELITY)}
            onSelect={value => {
              if (value !== '') void act.pickFidelity(value as PrototypeFidelity)
            }}
          />
        </Box>
      )}
      {Select && pane.initiatives.length > 0 ? (
        <Box justifyContent="space-between">
          <Text dimColor>{pane.initiative === null ? 'Initiative' : `Initiative · revision ${pane.initiative.revision}`}</Text>
          <Select
            key={pane.refusals === 0 ? 'brief-initiative' : `brief-initiative-${pane.refusals}`}
            options={[{ value: '', label: 'None' }, ...pane.initiatives.map(c => ({ value: c.id, label: c.title }))]}
            value={pane.initiative?.id ?? ''}
            onSelect={value => {
              if (value === (pane.initiative?.id ?? '')) return
              if (value === '') void act.detach()
              else if (pane.initiatives.some(c => c.id === value)) void act.attach(value)
            }}
          />
        </Box>
      ) : pane.initiative === null ? (
        <Text dimColor>Initiative · none</Text>
      ) : (
        <Text wrap="truncate-end">
          <Text dimColor>Initiative · </Text>
          {pane.initiative.title}
          <Text dimColor>{` · revision ${pane.initiative.revision}`}</Text>
        </Text>
      )}
    </Box>
  )
}

function outputRowTree(table: ElementTable, row: OutputRow, now: number, act: BriefActions) {
  const { Box, Button, Text } = table
  const tab = row.feedback === undefined ? undefined : 'feedback'
  return (
    <Box key={`output-${row.ref}`} flexDirection="column">
      <Box columnGap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{row.label}</Text>
        </Box>
        {row.status !== undefined && <Text dimColor>{row.status}</Text>}
        {row.at !== undefined && <Text dimColor>{ago(now - row.at)}</Text>}
        <Button key={`output-open-${row.ref}`} plain dimColor label="Open" onPress={() => void act.open(row.ref)} />
        {row.canBrief && (
          <Button key={`output-app-${row.ref}`} plain dimColor label="In Agent Brief" onPress={() => void act.openInApp(row.ref, tab)} />
        )}
      </Box>
      {row.feedback !== undefined && <Text color="yellow">{`  ${row.feedback}`}</Text>}
    </Box>
  )
}

function boardRowTree(table: ElementTable, board: BriefBoard, now: number, act: BriefActions) {
  const { Box, Button, Text } = table
  return (
    <Box key={`board-${board.name}`} columnGap={1}>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{board.name}</Text>
      </Box>
      <Text dimColor>Board</Text>
      <Text dimColor>{ago(now - board.updatedAt)}</Text>
      <Button key={`board-open-${board.name}`} plain dimColor label="In Agent Brief" onPress={() => void act.openBoard(board.name)} />
    </Box>
  )
}

function outputsTree(table: ElementTable, pane: BriefPaneView, act: BriefActions) {
  const { Box, Button, Text } = table
  const { declared, touched } = outputRows(pane.outputs, pane.feedback)
  const boards = [...pane.boards].sort((a, b) => b.updatedAt - a.updatedAt)
  const isOpen = pane.view.isTouchedOpen
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Outputs</Text>
      {declared.length === 0 && boards.length === 0 && touched.length === 0 && <Text dimColor>No outputs yet.</Text>}
      {declared.map(row => outputRowTree(table, row, pane.now, act))}
      {boards.map(board => boardRowTree(table, board, pane.now, act))}
      {touched.length > 0 && (
        <Button
          key="brief-touched"
          plain
          dimColor
          label={`${isOpen ? '▾' : '▸'} Touched (${touched.length})`}
          onPress={() => void act.fold('touched')}
        />
      )}
      {isOpen && touched.map(row => outputRowTree(table, row, pane.now, act))}
    </Box>
  )
}

/** Buttons for options, Agree for a proposal, an Input for free text. A surface without fields draws a hint for the Input. */
function controlTree(table: ElementTable, row: ItemRow, hasFields: boolean, act: BriefActions) {
  const { Box, Button, Text } = table
  const { Input } = (hasFields ? table : {}) as Partial<ElementTable<'terminal'>>
  const control = row.control
  if (control === undefined) return null
  const input = Input ? (
    <Input
      key={`item-${row.n}-answer`}
      placeholder="Your answer"
      value={row.held ?? ''}
      submitLabel="hold"
      onSubmit={value => void act.hold(row.n, value)}
    />
  ) : (
    <Text dimColor>Answer in the terminal or in Agent Brief.</Text>
  )
  if (control.kind === 'text') return input
  if (control.kind === 'proposal') {
    return (
      <Box columnGap={1}>
        <Button key={`item-${row.n}-agree`} label="Agree" onPress={() => void act.hold(row.n, AGREE_TEXT)} />
        <Box flexGrow={1}>{input}</Box>
      </Box>
    )
  }
  return (
    <Box flexWrap="wrap" columnGap={1}>
      {control.options.map((option, i) => (
        <Button
          key={`item-${row.n}-option-${i}`}
          label={option}
          {...(row.held === option ? { variant: 'primary' as const } : {})}
          onPress={() => void act.hold(row.n, option)}
        />
      ))}
    </Box>
  )
}

function itemTree(table: ElementTable, row: ItemRow, hasFields: boolean, act: BriefActions) {
  const { Box, Button, Text } = table
  return (
    <Box key={`item-${row.n}`} flexDirection="column" marginTop={1}>
      <Text>
        <Text bold>#{row.n}</Text> {row.title}
      </Text>
      {row.claude !== undefined && <Text dimColor>Claude: {row.claude}</Text>}
      {controlTree(table, row, hasFields, act)}
      {row.held !== undefined && (
        <Box columnGap={1}>
          <Text color="green">→ {row.held}</Text>
          <Button key={`item-${row.n}-clear`} plain dimColor label="Clear" onPress={() => void act.clear(row.n)} />
        </Box>
      )}
      {row.you !== undefined && <Text dimColor>You: {row.you}</Text>}
    </Box>
  )
}

function itemsTree(table: ElementTable, pane: BriefPaneView, act: BriefActions) {
  const { Box, Button, Text } = table
  const { open, done } = itemRows(pane.items?.text ?? null, pane.answers)
  const isDoneOpen = pane.view.isDoneOpen
  const empty = pane.isTracking ? 'No items yet. Claude adds them as they come up.' : 'Track is off. Turn it on and Claude keeps items here.'
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold>Items</Text>
        <Button
          key="brief-track"
          label={pane.isTracking ? '☑ Track' : '☐ Track'}
          {...(pane.isTracking ? { variant: 'primary' as const } : {})}
          onPress={() => void act.track()}
        />
      </Box>
      {open.length === 0 && done.length === 0 && <Text dimColor>{empty}</Text>}
      {open.map(row => itemTree(table, row, pane.hasFields, act))}
      {done.length > 0 && (
        <Box marginTop={1}>
          <Button
            key="brief-done"
            plain
            dimColor
            label={`${isDoneOpen ? '▾' : '▸'} Done (${done.length})`}
            onPress={() => void act.fold('done')}
          />
        </Box>
      )}
      {isDoneOpen &&
        done.map(row => (
          <Text key={`done-${row.n}`} dimColor>
            #{row.n} {row.title}
          </Text>
        ))}
      {open.length > 0 && (
        <Box marginTop={1}>
          <Button
            key="brief-send"
            label={pane.answers.length > 0 ? `Send answers (${pane.answers.length})` : 'Send answers'}
            {...(pane.answers.length > 0 ? { variant: 'primary' as const } : {})}
            onPress={() => void act.send()}
          />
        </Box>
      )}
    </Box>
  )
}
