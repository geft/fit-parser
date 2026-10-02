// Backward-compatible test entry point; field math is tested against raw FIT IDs.
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=published|big endian|compressed', 'tests/fit-core.test.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
