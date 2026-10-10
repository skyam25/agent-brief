import { main } from './main';

const chunks: Buffer[] = [];

const code = await main(process.argv.slice(2), {
  stdin: async () => {
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  },
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
});

process.exitCode = code;
