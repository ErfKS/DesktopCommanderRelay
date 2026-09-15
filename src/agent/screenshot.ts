import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface ScreenshotCommand {
  command: string;
  args: (outputPath: string) => string[];
}

const SCREENSHOT_COMMANDS: ScreenshotCommand[] = [
  { command: 'gnome-screenshot', args: (outputPath) => ['-f', outputPath] },
  { command: 'scrot', args: (outputPath) => [outputPath] },
  { command: 'grim', args: (outputPath) => [outputPath] },
  { command: 'maim', args: (outputPath) => [outputPath] },
  { command: 'import', args: (outputPath) => ['-window', 'root', outputPath] },
  { command: 'spectacle', args: (outputPath) => ['-b', '-n', '-o', outputPath] },
];

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;

export interface CapturedScreenshot {
  content: Array<{
    type: 'image';
    data: string;
    mimeType: 'image/png';
  }>;
}

export async function captureLinuxScreenshot(
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<CapturedScreenshot> {
  if (process.platform !== 'linux') {
    throw new Error('Screenshot capture is supported only on Linux relay agents');
  }

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Invalid screenshot size limit');
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-relay-screenshot-'));
  const outputPath = path.join(directory, 'capture.png');
  const failures: string[] = [];

  try {
    for (const candidate of SCREENSHOT_COMMANDS) {
      try {
        await runScreenshotCommand(candidate, outputPath);
        const image = await fs.readFile(outputPath);
        if (image.byteLength === 0) {
          throw new Error('the screenshot command produced an empty file');
        }
        if (image.byteLength > maxBytes) {
          throw new Error(`the screenshot is larger than the ${maxBytes}-byte limit`);
        }

        return {
          content: [{
            type: 'image',
            data: image.toString('base64'),
            mimeType: 'image/png',
          }],
        };
      } catch (error) {
        failures.push(`${candidate.command}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  throw new Error(
    `Unable to capture a Linux screenshot. Install and expose one of gnome-screenshot, scrot, grim, maim, ImageMagick, or spectacle. ${failures.join('; ')}`,
  );
}

function runScreenshotCommand(
  candidate: ScreenshotCommand,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.command, candidate.args(outputPath), {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`command timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`exited with ${signal ?? `code ${code}`}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`));
    });

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
  });
}
