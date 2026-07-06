import { spawn } from 'node:child_process';

const INTERVAL_MINUTES = Number(process.env.SCRAPE_INTERVAL_MINUTES ?? 15);
const BATCH_LIMIT = String(process.env.SCRAPE_BATCH_LIMIT ?? 5);
const TARGETS = String(process.env.LOCAL_SCRAPE_TARGETS ?? 'hk01')
  .split(',')
  .map(value => value.trim().toLowerCase())
  .filter(Boolean);

const TARGET_COMMANDS = {
  hk01: ['node', 'src/scrapers/hk01Scraper.js'],
  christine: ['node', 'src/scrapers/christineScraper.js'],
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString();
}

async function runTarget(target) {
  const command = TARGET_COMMANDS[target];
  if (!command) {
    console.warn(`[${timestamp()}] Skipping unknown target: ${target}`);
    return;
  }

  console.log(`[${timestamp()}] Starting ${target} with batch limit ${BATCH_LIMIT}`);

  await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      env: {
        ...process.env,
        SCRAPE_BATCH_LIMIT: BATCH_LIMIT,
      },
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${target} exited with code ${code}`));
    });
  });

  console.log(`[${timestamp()}] Finished ${target}`);
}

async function runLoop() {
  if (!TARGETS.length) {
    throw new Error('No local scrape targets configured');
  }

  const intervalMs = INTERVAL_MINUTES * 60 * 1000;
  console.log(
    `[${timestamp()}] Local scrape scheduler started. Targets=${TARGETS.join(',')} interval=${INTERVAL_MINUTES}m batch=${BATCH_LIMIT}`
  );

  while (true) {
    const cycleStartedAt = Date.now();

    for (const target of TARGETS) {
      try {
        await runTarget(target);
      } catch (error) {
        console.error(`[${timestamp()}] ${target} failed: ${error.message}`);
      }
    }

    const elapsedMs = Date.now() - cycleStartedAt;
    const waitMs = Math.max(intervalMs - elapsedMs, 0);
    console.log(`[${timestamp()}] Cycle complete. Sleeping ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
}

runLoop().catch(error => {
  console.error(`[${timestamp()}] Fatal scheduler error: ${error.message}`);
  process.exit(1);
});
