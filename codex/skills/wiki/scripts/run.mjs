import { main } from '../../../commands/mods.mjs';
await main(['wiki', ...process.argv.slice(2)]);
