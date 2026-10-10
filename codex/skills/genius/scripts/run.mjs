import { main } from '../../../commands/mods.mjs';
await main(['genius', ...process.argv.slice(2)]);
