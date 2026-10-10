import { main } from '../../../commands/mods.mjs';
await main(['fleet', ...process.argv.slice(2)]);
