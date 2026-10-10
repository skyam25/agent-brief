const DRAW_EXAMPLE = `echo '{"elements":[
  {"id":"a","type":"rectangle","x":0,"y":0,"width":200,"height":80,"label":"Client","color":"blue"},
  {"id":"b","type":"rectangle","x":260,"y":0,"width":200,"height":80,"label":"Server","color":"green"},
  {"type":"arrow","start":{"id":"a"},"end":{"id":"b"}}
]}' | companion draw`;

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
  status: {
    usage: 'companion status [--json]',
    about: 'Shows whether the app runs. Exits 3 when it does not.',
    example: 'companion status',
  },
  sessions: {
    usage: 'companion sessions [--json]',
    about: 'Lists registered Claude Code sessions. A * marks the Send target.',
    example: 'companion sessions',
  },
  boards: {
    usage: 'companion boards [--json]',
    about: 'Lists boards. A * marks the board the panel shows.',
    example: 'companion boards',
  },
  open: {
    usage: 'companion open [--board <name>] [--prompt <text>] [--session <id>] [--json]',
    about: 'Shows the panel. Creates the board when missing. --prompt puts text at the top of the panel. --session makes that session the Send target.',
    example: 'companion open --board login-flow --prompt "Sketch the login screens"',
  },
  read: {
    usage: 'companion read [--board <name>] [--region x,y,w,h] [--json]',
    about: 'Prints the board as compact text, one line per element. Frame children are indented under the frame.',
    example: 'companion read --region 0,0,600,400',
  },
  png: {
    usage: 'companion png [--board <name>] [--region x,y,w,h] [--max-edge 1400] [--out <path>] [--json]',
    about: 'Writes a PNG and prints its path. Read the file to see the board. Default path: ./.feedback/boards/<board>-<timestamp>.png.',
    example: 'companion png --region 0,0,600,400 --out /tmp/crop.png',
  },
  draw: {
    usage: 'companion draw [--board <name>] [--file f.json] [--json]',
    about: 'Adds elements. Reads {"elements":[...]} or a bare array from --file or stdin. One call is one undo step.',
    example: DRAW_EXAMPLE,
  },
  update: {
    usage: 'companion update [--board <name>] [--file f.json] [--json]',
    about: 'Moves, resizes, relabels or recolours elements by id. Reads {"updates":[...]} or a bare array from --file or stdin.',
    example: `echo '[{"id":"a","x":40,"label":"Browser","color":"violet"}]' | companion update`,
  },
  delete: {
    usage: 'companion delete [--board <name>] [--json] <id>...',
    about: 'Removes elements by id. Unknown ids are skipped.',
    example: 'companion delete a b',
  },
};

export function commandHelp(name: string): string {
  const d = DOCS[name];
  const options = name === 'status' || name === 'sessions' || name === 'boards' ? '' : COMMON;
  return `${d.usage}\n\n${d.about}\n${options}\nExample:\n  ${d.example.replace(/\n/g, '\n  ')}\n`;
}

export function topHelp(): string {
  const rows = Object.entries(DOCS)
    .map(([name, d]) => `  ${name.padEnd(10)}${d.about.split('. ')[0].replace(/\.$/, '')}`)
    .join('\n');
  return `companion - draw on and read the Web Agent Companion sketch board

Usage: companion <command> [options]

Commands:
${rows}
  help      Shows this text. "companion <command> --help" shows one command.

Draw example:
  ${DRAW_EXAMPLE.replace(/\n/g, '\n  ')}

Exit codes: 0 ok, 1 server error, 2 bad usage or input, 3 app not running.
Socket: $COMPANION_SOCKET, else the default app socket.
`;
}
