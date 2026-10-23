import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffmpegAvailable, probe, makeShort } from '../reframe.js';

const hasFfmpeg = await ffmpegAvailable();
const opts = { skip: hasFfmpeg ? false : 'ffmpeg absent' };

function gen(dir, name, args) {
  const file = path.join(dir, name);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, '-pix_fmt', 'yuv420p', file]);
  assert.equal(r.status, 0, String(r.stderr));
  return file;
}

test('cadrage auto : action répartie -> image entière sur fond flou', opts, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const input = gen(dir, 'wide.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=4']);
  const info = await probe(input);
  const r = await makeShort({ input, start: 0, end: 4, framing: 'auto', outPath: path.join(dir, 'o.mp4'), info });
  assert.equal(r.framing, 'blur');
  assert.match(r.note, /fond flou/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cadrage auto : sujet concentré -> recadrage vertical', opts, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const input = gen(dir, 'focus.mp4', [
    '-f', 'lavfi', '-i', 'color=c=0x303030:size=1280x720:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'testsrc2=size=240x426:rate=25:duration=4',
    '-filter_complex', '[0][1]overlay=x=800:y=150',
  ]);
  const info = await probe(input);
  const out = path.join(dir, 'o.mp4');
  const r = await makeShort({ input, start: 0, end: 4, framing: 'auto', outPath: out, info });
  assert.equal(r.framing, 'auto');
  const p = await probe(out);
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  fs.rmSync(dir, { recursive: true, force: true });
});
