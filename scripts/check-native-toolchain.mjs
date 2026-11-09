import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';

const expoRequire = createRequire(realpathSync(resolve('apps/mobile/node_modules/expo/package.json')));
const pluginsRequire = createRequire(expoRequire.resolve('@expo/config-plugins'));
const project = pluginsRequire('xcode').project('toolchain-check.pbxproj');
project.allUuids = () => [];
const ids = new Set(Array.from({ length: 100 }, () => project.generateUuid()));
assert.equal(ids.size, 100);
for (const id of ids) assert.match(id, /^[0-9A-F]{24}$/);
console.log('Expo/xcode UUID adapter remains compatible after the security update.');
