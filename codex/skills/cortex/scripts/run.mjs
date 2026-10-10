import { main } from '../../../commands/mods.mjs';
await main(['cortex', ...process.argv.slice(2)]);
