import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const files = ['client.test.mjs', 'performance.test.mjs', 'lifecycle.test.mjs', 'menu-presentation.test.mjs', 'model-switch.test.mjs', 'purple-border.test.mjs'];
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.signal || result.status !== 0) process.exit(result.status || 1);
}
console.log('\nAll test suites passed.');
