const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, ['--test', 'tests/fit-core.test.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
