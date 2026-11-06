#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { containJcPath, containJcWritePath, defaultDeniedRoots } from '../dist/jace-commander/filesystem.js';
import { writeFile, editBlock, moveFile } from '../dist/jace-commander/mutations.js';
import { createProcessRegistry } from '../dist/jace-commander/processes.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-write-roots-'));
try {
  const home = path.join(temp, 'home');
  const projects = path.join(home, 'projects');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, 'note.txt'), 'note');
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'secret');
  fs.writeFileSync(path.join(outside, 'x'), 'outside');
  fs.symlinkSync(outside, path.join(home, 'outlink'));
  const policy = {
    roots: [home],
    writeRoots: [projects],
    deniedRoots: defaultDeniedRoots(path.join(home, '.jace-commander'), home)
  };
  assert.equal(containJcPath(path.join(home, 'note.txt'), policy), path.join(home, 'note.txt'));
  assert.throws(() => containJcPath(path.join(outside, 'x'), policy), /outside/);
  assert.throws(() => containJcPath(path.join(home, 'outlink', 'x'), policy), /outside/);
  assert.throws(() => containJcPath(path.join(home, '.ssh', 'id_rsa'), policy), /protected/);
  assert.throws(() => containJcWritePath(path.join(home, 'note.txt'), policy), /writable/);
  await assert.rejects(writeFile({ path: path.join(home, 'other.txt'), content: 'no' }, policy), /writable/);
  await assert.rejects(editBlock({ path: path.join(home, 'note.txt'), old: 'note', new: 'wrong' }, policy), /writable/);
  const projectFile = path.join(projects, 'yes.txt');
  await writeFile({ path: projectFile, content: 'yes' }, policy);
  assert.equal(fs.readFileSync(projectFile, 'utf8'), 'yes');
  await assert.rejects(moveFile({ from: path.join(home, 'note.txt'), to: path.join(projects, 'note.txt') }, policy), /writable/);
  assert.equal(fs.readFileSync(path.join(home, 'note.txt'), 'utf8'), 'note');
  assert.throws(() => createProcessRegistry().start({ argv: [process.execPath, '--version'], cwd: projects }, policy), /disabled/);
  console.log('split root executor regression: passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
