import { main } from '../../../commands/mods.mjs';
await main(['autopilot', ...process.argv.slice(2)]);
