#!/usr/bin/env node
'use strict';

/**
 * Renames the app (id and/or name) everywhere in the project.
 *
 *   npm run rename -- <new.app.id> "<New Name>"
 *   npm run rename -- <new.app.id>            (keep the name)
 *   npm run rename -- --name "<New Name>"     (keep the id)
 *
 * The current id and name are read from .homeycompose/app.json. All text
 * files (js, json, md, txt, html) are updated; node_modules, .git and
 * .homeybuild are skipped. Run `homey app validate` afterwards to regenerate
 * app.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, '.homeycompose', 'app.json');
const SKIP_DIRS = new Set(['node_modules', '.git', '.homeybuild']);
const EXTENSIONS = new Set(['.js', '.json', '.md', '.txt', '.html']);
// The display name may contain spaces, so it is never replaced in code.
const NAME_EXTENSIONS = new Set(['.json', '.md', '.txt', '.html']);

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = [...argv];
  let newId = null;
  let newName = null;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--name') newName = args.shift();
    else if (!newId) newId = arg;
    else if (!newName) newName = arg;
    else fail(`Unexpected argument: ${arg}`);
  }
  return { newId, newName };
}

function validateId(id) {
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(id)) {
    fail(`"${id}" is not a valid app id (reverse domain notation, lower case, e.g. nl.example.app)`);
  }
  if (/homey|athom/.test(id)) fail('An app id may not contain "homey" or "athom"');
}

function* textFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* textFiles(full);
    else if (EXTENSIONS.has(path.extname(entry.name))) yield full;
  }
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const oldId = manifest.id;
  const oldName = manifest.name.en;
  const { newId, newName } = parseArgs(process.argv.slice(2));

  if (!newId && !newName) {
    console.log(`Current id: ${oldId}\nCurrent name: ${oldName}`);
    console.log('Usage: npm run rename -- <new.app.id> ["<New Name>"]  or  npm run rename -- --name "<New Name>"');
    return;
  }
  if (newId) validateId(newId);
  if (newName !== null && !String(newName).trim()) fail('The name may not be empty');

  const replacements = [];
  if (newId && newId !== oldId) replacements.push({ from: oldId, to: newId, code: true });
  if (newName && newName !== oldName) replacements.push({ from: oldName, to: newName.trim(), code: false });
  if (!replacements.length) {
    console.log('Nothing to change.');
    return;
  }

  let changed = 0;
  for (const file of textFiles(ROOT)) {
    if (file === __filename) continue;
    const isNameFile = NAME_EXTENSIONS.has(path.extname(file));
    const before = fs.readFileSync(file, 'utf8');
    let after = before;
    for (const { from, to, code } of replacements) {
      if (code || isNameFile) after = after.split(from).join(to);
    }
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed++;
      console.log(`updated ${path.relative(ROOT, file)}`);
    }
  }
  console.log(`\n${changed} file(s) updated. Run "homey app validate" to regenerate app.json.`);
}

main();
