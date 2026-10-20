const DRAW_EXAMPLE = `echo '{"elements":[
  {"id":"a","type":"rectangle","x":0,"y":0,"width":200,"height":80,"label":"Client","color":"blue"},
  {"id":"b","type":"rectangle","x":260,"y":0,"width":200,"height":80,"label":"Server","color":"green"},
  {"type":"arrow","start":{"id":"a"},"end":{"id":"b"}}
]}' | agent-brief draw`;

interface Doc {
  usage: string;
  about: string;
  example: string;
}

const COMMON = `
Options:
  --board <name>   Board to use. Default: current.
  --json           Print the raw JSON response.`;

export const DOCS: Record<string, Doc> = {
  behavior: {
    usage: 'agent-brief behavior show|update|export <prototype.html> [--session <id>] [--file <patch.json>] [--out <acceptance.md>] [--json]',
    about: 'Reads or updates behavior rules beside a prototype. Update reads a version-checked patch from stdin or --file. Export prints acceptance criteria and open assumptions. Requires the app and a registered session.',
    example: 'agent-brief behavior show prototypes/onboarding.html --json',
  },
  feedback: {
    usage: `agent-brief feedback <verb> [--session <id>] [--json]
  list                                   feedback files in the project, with open counts
  show <output>                          rounds and items, with every line
  round <output> --label <l> [--source <transcript>] [--date YYYY-MM-DD]
                                         adds the round, or says it already exists. One source has one number across the project
  catalog <output> --label <l> [--source <transcript>] [--date YYYY-MM-DD] --items <file.json | ->
                                         adds the round and every point in one call, and names look-alikes
  add <output> --title <t> [--src '<round> · <speaker> · <time> · "<quote>"']... [--change <text>] [--where <selector or heading>] [--option "<letter> · <text>"]... [--related "<output> #N"]... [--round N]
  log <output> <n> <key> <text>          appends one line, such as Claude "note · asked about mobile" or Src '2 · Maya · 00:14 · "..."'
  change <output> <n> <text>             revises the proposed change. Earlier Change lines stay as history
  done <output> <n> [text] [--commit <sha>]
  related <output> (<n> | --text <point>...) links and look-alike items across the project. Repeat --text to check several points
  workspace <output> <n>                 prints the item's board, fb-<stem>-<n>, after making it or adding a frame for its newest round
  snap <output> <n> --before|--after [--round N]  pictures the item's Where: element in its section, or the whole page, in an HTML output
  graph                                  how rounds, items, outputs and workspaces link across the project

Quotes go in as said, inner quotes included, with no backslashes. Only JSON escapes them.
A catalog file is a JSON list. Each point is a new item, or "same" joins an item it repeats:
  [{"title": "Hard to find the filters", "src": ["Ana · 03:02 · \\"Where do I filter?\\""], "change": "…", "where": "#filters",
    "options": ["A · …", "B · …"], "related": ["pricing.html #3"]},
   {"same": 6, "src": ["Maya · 00:14 · \\"Still no filters\\""], "change": "the revised change"}]
A src without a round number is in the catalog's round.`,
    about:
      'Keeps feedback items beside an output in <output>.feedback.md. Every write only adds: a round, an item, a line, or a closed checkbox. Dates are added for you. Claude writes Claude lines; You lines come from the panel. Requires the app and a registered session.',
    example: `agent-brief feedback catalog prototype/checkout.html --label customers --source transcripts/cust-1.md --date 2026-10-12 --items round-1.json\nagent-brief feedback add prototype/checkout.html --title "Hard to find the filters" --src '1 · Ana · 03:02 · "Where do I filter?"' --where '#filters'\nagent-brief feedback change prototype/checkout.html 6 "Put the filters in a sticky bar"\nagent-brief feedback done prototype/checkout.html 6 --commit 3f2a91c`,
  },
  status: {
    usage: 'agent-brief status [--json]',
    about: 'Shows whether the app runs. Exits 3 when it does not.',
    example: 'agent-brief status',
  },
  sessions: {
    usage: 'agent-brief sessions [--json]',
    about: 'Lists registered Claude Code sessions. A * marks the Send target.',
    example: 'agent-brief sessions',
  },
  boards: {
    usage: 'agent-brief boards [--json]',
    about: 'Lists boards. A * marks the board the panel shows.',
    example: 'agent-brief boards',
  },
  open: {
    usage: 'agent-brief open [--board <name> | --note <id> | --output <path>] [--prompt <text>] [--session <id>] [--layout freeform|stack] [--json]',
    about: "Shows the panel. Creates the board when missing. --note shows a saved note in Write instead; `agent-brief note` prints its id. --output shows a session's Markdown output as a note in Write, or its HTML output in the review pane. --prompt puts text at the top of the panel. --session makes that session the Send target; run from Claude Code, it defaults to that session. With a session and no --board, the panel reopens the session's last board or note and makes no new board. --layout stack files each drop or paste of screenshots as a numbered group.",
    example: 'agent-brief open --board login-flow --prompt "Sketch the login screens"',
  },
  read: {
    usage: 'agent-brief read [--board <name>] [--region x,y,w,h] [--json]',
    about: 'Prints the board as compact text, one line per element. Frame children are indented under the frame.',
    example: 'agent-brief read --region 0,0,600,400',
  },
  png: {
    usage: 'agent-brief png [--board <name>] [--region x,y,w,h] [--max-edge 1400] [--out <path>] [--json]',
    about: 'Writes a PNG and prints its path. Read the file to see the board. Default path: ./.feedback/boards/<board>-<timestamp>.png.',
    example: 'agent-brief png --region 0,0,600,400 --out /tmp/crop.png',
  },
  draw: {
    usage: 'agent-brief draw [--board <name>] [--file f.json] [--json]',
    about: 'Adds elements. Reads {"elements":[...]} or a bare array from --file or stdin. One call is one undo step. An image element takes "file", a png, jpeg, gif or webp path, and keeps its proportions when you give only a width or height. Prints one line per new element as read does. Warnings name arrows whose label hides them, boxes that grew over a neighbour, and frames that grew over another frame. Run from Claude Code with --board, it files the board under that session and shows it, unless the panel shows another session.',
    example: DRAW_EXAMPLE,
  },
  snap: {
    usage: 'agent-brief snap <image> [--caption <text>] [--note <text>] [--width 720] [--board <name>] [--json]',
    about: 'Adds a screenshot as the next numbered step, in a frame titled with the caption. Steps run three to a row. --note adds a sticky under the picture.',
    example: 'agent-brief snap /tmp/step.png --board checkout-run --caption "Cart" --note "Total skips the discount"',
  },
  update: {
    usage: 'agent-brief update [--board <name>] [--file f.json] [--json]',
    about: 'Moves, resizes, relabels or recolours elements by id. Reads {"updates":[...]} or a bare array from --file or stdin. Moving a frame moves everything in it. Warnings name boxes that grew over a neighbour.',
    example: `echo '[{"id":"a","x":40,"label":"Browser","color":"violet"}]' | agent-brief update`,
  },
  delete: {
    usage: 'agent-brief delete [--board <name>] [--json] <id>...',
    about: 'Removes elements by id. Unknown ids are skipped.',
    example: 'agent-brief delete a b',
  },
  show: {
    usage: 'agent-brief show <file>... [--title <text>] [--labels "A|B|C"] [--board <name>] [--url <link>]',
    about: 'Shows a picture inline in the Claude Code session that runs it. Two to four files are options the user picks from; --labels names them in order. PNG, JPEG, WebP, GIF, TIFF, SVG or .wireframe. Needs the agent-brief plugin in that session, not the app.',
    example: 'agent-brief show .feedback/shots/after.png --title "Checkout after the fix"',
  },
  output: {
    usage: 'agent-brief output <title> (--path <file> | --url <link>) [--status drafting|ready]',
    about: "Lists a deliverable in the Agent Brief panel's Outputs. Needs the agent-brief plugin in the session that runs it.",
    example: 'agent-brief output "Pricing brief" --path docs/pricing.md --status ready',
  },
  note: {
    usage: 'agent-brief note [title] [--text <markdown> | --file <path>] [--session <id> | --id <note id>] [--json]',
    about: "Saves Markdown as a note in Agent Brief's Write mode without opening the panel. Prints the note's id and the `agent-brief open --note` line that shows it. --id replaces that note's text in place, and its title when one is given, so the user keeps one copy. Reads stdin unless --text or --file is given. Files a new note under the Claude Code session that runs it, or --session, else under Notes. Exits 3 when the app is not running.",
    example: `agent-brief note "Launch message" <<'EOF'\nHi team, **v2 is live**.\nEOF`,
  },
  'herdr-pictures': {
    usage: 'agent-brief herdr-pictures [on|off|status]',
    about: 'Lets Claude Code draw pictures in Herdr panes. "on" adds a marked block to your zsh and bash startup files, and a fish conf.d file, that sets CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 only when HERDR_ENV is set. "off" removes it. "status" shows each file and this shell.',
    example: 'agent-brief herdr-pictures on',
  },
  initiative: {
    usage: `agent-brief initiative <verb> [--json]
  list                                  every initiative
  recent [--limit 3]                    the ones touched last, one line each
  find <words>                          the top 3 by overlap with title, Understanding and decisions
  show <id or title>                    the brief, its folders and recent history
  attach <id or title> [--session <id>] binds the initiative to this session
  detach [--session <id>]               unbinds it
  create <title> --folder <path> [--file draft.json]
  update <id or title> [--file patch.json]`,
    about:
      'Reads and changes initiatives, the standing briefs above sessions. Reads work with the app closed. attach, detach, create and update need the app and exit 3 without it. --session defaults to the Claude Code session that runs the command. A create draft may hold understanding, decisions, open, working and folders. An update patch needs the revision you read, plus any of understanding, decisions, open and folders; a stale revision is a conflict.',
    example: `agent-brief initiative recent\nagent-brief initiative attach Pricing\necho '{"revision":3,"open":["Legal review of trial terms"]}' | agent-brief initiative update Pricing`,
  },
};

/** Commands that use no board and print no JSON. */
const NO_COMMON = new Set(['status', 'sessions', 'boards', 'herdr-pictures', 'show', 'output', 'note', 'initiative', 'feedback']);

export function commandHelp(name: string): string {
  const d = DOCS[name];
  const options = NO_COMMON.has(name) ? '' : COMMON;
  return `${d.usage}\n\n${d.about}\n${options}\nExample:\n  ${d.example.replace(/\n/g, '\n  ')}\n`;
}

export function topHelp(): string {
  const rows = Object.entries(DOCS)
    .map(([name, d]) => `  ${name.padEnd(16)}${d.about.split('. ')[0].replace(/\.$/, '')}`)
    .join('\n');
  return `agent-brief - draw on and read the Agent Brief sketch board

Usage: agent-brief <command> [options]

Commands:
${rows}
  help            Shows this text. "agent-brief <command> --help" shows one command.

Draw example:
  ${DRAW_EXAMPLE.replace(/\n/g, '\n  ')}

Exit codes: 0 ok, 1 server error, 2 bad usage or input, 3 app not running.
Socket: $COMPANION_SOCKET, else the default app socket.
`;
}
