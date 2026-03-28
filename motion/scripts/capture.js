/**
 * Render-em Motion — Capture Pipeline
 *
 * Converts HTML/CSS animations into ProRes 4444 video clips
 * with frame-perfect accuracy at 4K resolution.
 *
 * Usage:
 *   node capture.js <config.json> <output-dir>
 *
 * Config format (array of clips):
 *   [
 *     { "name": "00-title", "html": "clips/00-title.html", "duration": 6.0 },
 *     ...
 *   ]
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const WIDTH = 3840;
const HEIGHT = 2160;
const FPS = 29.97;
const FRAME_DURATION = 1000 / FPS;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Parse args ---
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node capture.js <config.json> <output-dir>');
  console.log('');
  console.log('Config format:');
  console.log('  [{ "name": "00-title", "html": "clips/00-title.html", "duration": 6.0 }]');
  process.exit(1);
}

const configPath = path.resolve(args[0]);
const outputBase = path.resolve(args[1]);
const configDir = path.dirname(configPath);

const files = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

if (files.length === 0) {
  console.log('No clips defined in config. Nothing to capture.');
  process.exit(0);
}

console.log(`Loaded ${files.length} clip(s) from ${configPath}`);

async function captureStill(page, file, outputDir) {
  const htmlPath = path.resolve(configDir, file.html);
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

  // Wait for animations to finish, then capture final state
  await sleep(Math.ceil(file.duration * 1000) + 500);

  const stillPath = path.join(outputDir, `${file.name}.png`);
  await page.screenshot({ path: stillPath, type: 'png' });
  console.log(`  Still saved: ${stillPath}`);
}

async function captureFrames(page, file, framesDir) {
  const htmlPath = path.resolve(configDir, file.html);
  const totalFrames = Math.ceil(file.duration * FPS);

  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

  // Pause all CSS animations at time 0
  await page.evaluate(() => {
    document.getAnimations().forEach(a => a.pause());
    document.getAnimations().forEach(a => { a.currentTime = 0; });
  });

  for (let i = 0; i < totalFrames; i++) {
    const timeMs = i * FRAME_DURATION;

    await page.evaluate((t) => {
      document.getAnimations().forEach(a => { a.currentTime = t; });
    }, timeMs);

    await sleep(30);

    const framePath = path.join(framesDir, `frame_${String(i).padStart(5, '0')}.png`);
    await page.screenshot({ path: framePath, type: 'png' });

    if (i % 30 === 0) {
      console.log(`  Frame ${i}/${totalFrames} (${(timeMs / 1000).toFixed(2)}s)`);
    }
  }

  return totalFrames;
}

function encodeToProRes(framesDir, outputPath) {
  const cmd = [
    'ffmpeg', '-y',
    '-framerate', '29.97',
    '-i', path.join(framesDir, 'frame_%05d.png'),
    '-c:v', 'prores_ks',
    '-profile:v', '4',
    '-pix_fmt', 'yuva444p10le',
    '-vendor', 'apl0',
    '-bits_per_mb', '8000',
    '-s', `${WIDTH}x${HEIGHT}`,
    outputPath
  ].join(' ');

  console.log(`  Encoding: ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
  console.log(`  Video saved: ${outputPath}`);
}

(async () => {
  const stillsDir = path.join(outputBase, 'stills');
  const videoDir = path.join(outputBase, 'video');
  const tempDir = path.join(outputBase, '_temp_frames');

  fs.mkdirSync(stillsDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--window-size=${WIDTH},${HEIGHT}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--force-device-scale-factor=1',
    ],
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();

  // --- Pass 1: Stills ---
  console.log('\n=== Capturing stills ===\n');
  for (const file of files) {
    console.log(`Processing: ${file.name}`);
    await captureStill(page, file, stillsDir);
  }

  // --- Pass 2: Frame sequences + ProRes ---
  let hasFFmpeg = false;
  try {
    execSync('which ffmpeg', { stdio: 'pipe' });
    hasFFmpeg = true;
  } catch {
    console.log('\n=== ffmpeg not found — skipping video encoding ===');
    console.log('Install ffmpeg (brew install ffmpeg) and run again.\n');
  }

  if (hasFFmpeg) {
    console.log('\n=== Capturing frames & encoding ProRes ===\n');
    for (const file of files) {
      const framesDir = path.join(tempDir, file.name);
      fs.mkdirSync(framesDir, { recursive: true });

      console.log(`\nCapturing frames: ${file.name} (${file.duration}s @ ${FPS}fps)`);
      await captureFrames(page, file, framesDir);

      const outputPath = path.join(videoDir, `${file.name}.mov`);
      console.log(`Encoding ProRes 4444: ${file.name}`);
      encodeToProRes(framesDir, outputPath);

      // Clean up frames
      fs.rmSync(framesDir, { recursive: true });
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  await browser.close();

  console.log('\n=== Done! ===');
  console.log(`Stills:  ${stillsDir}/`);
  if (hasFFmpeg) console.log(`Videos:  ${videoDir}/`);
  console.log('');
})();
