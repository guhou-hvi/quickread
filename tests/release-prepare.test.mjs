import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareRelease, publicPipeline} from '../scripts/release-prepare.mjs';

test('public defaults cannot inherit case-specific repair or migration authorization',()=>{
  const original={reviews:{maximumRepairRounds:2,repairRoundOverrides:{'QR-0002':4}},migration:{pilotCases:['QR-0002'],activeCases:['QR-0002'],frozenCases:[],humanReviewFirstCase:'QR-0017'},contextUpgrade:{allowlist:['QR-0002'],batches:{one:['QR-0002']}}};
  const result=publicPipeline(original);
  assert.equal(result.reviews.maximumRepairRounds,2);
  assert.deepEqual(result.reviews.repairRoundOverrides,{});
  assert.deepEqual(result.migration.activeCases,[]);
  assert.deepEqual(result.contextUpgrade.batches,{});
  assert.equal(original.reviews.repairRoundOverrides['QR-0002'],4);
});

test('snapshot uses an explicit allowlist, starts empty, and cannot overwrite a destination',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'quickread-release-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'allowed.txt'),'original fixture');
  await fs.writeFile(path.join(root,'private.txt'),'must never ship');
  const manifestPath=path.join(root,'manifest.json');
  await fs.writeFile(manifestPath,JSON.stringify({files:[{source:'allowed.txt',destination:'README.md'}]}));
  const output=path.join(root,'tmp/releases/one');
  const result=await prepareRelease(output,{root,manifestPath});
  assert.equal(result.files,3);
  assert.equal(result.status,'candidate-not-published');
  const snapshot=JSON.parse(await fs.readFile(path.join(output,'release-manifest.json'),'utf8'));
  assert.equal(snapshot.licenseStatus,'draft-pending-owner-review');
  assert.equal(await fs.readFile(path.join(output,'README.md'),'utf8'),'original fixture');
  assert.equal(await fs.stat(path.join(output,'private.txt')).then(()=>true,()=>false),false);
  assert.match(await fs.readFile(path.join(output,'cases/index.html'),'utf8'),/0 个案例/u);
  await assert.rejects(prepareRelease(output,{root,manifestPath}),/已存在/u);
  await assert.rejects(prepareRelease(root,{root,manifestPath}),/不能覆盖/u);
  await fs.writeFile(manifestPath,JSON.stringify({files:[{source:'allowed.txt',destination:'../escape'}]}));
  await assert.rejects(prepareRelease(path.join(root,'tmp/releases/two'),{root,manifestPath}),/非法/u);
});

test('approved export records approval without claiming remote publication',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'quickread-approved-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'LICENSE'),'Owner-approved license text');
  const manifestPath=path.join(root,'manifest.json');
  await fs.writeFile(manifestPath,JSON.stringify({files:[{source:'LICENSE',destination:'LICENSE'}]}));
  const output=path.join(root,'tmp/releases/final');
  const result=await prepareRelease(output,{root,manifestPath,approved:true});
  const snapshot=JSON.parse(await fs.readFile(path.join(output,'release-manifest.json'),'utf8'));
  assert.equal(result.status,'release-snapshot');
  assert.equal(snapshot.licenseStatus,'owner-approved');
  assert.equal(snapshot.gitHistoryIncluded,false);
  assert.equal(snapshot.pushed,undefined);
  assert.equal(await fs.readFile(path.join(output,'LICENSE'),'utf8'),'Owner-approved license text');
});

test('public package metadata points to the planned independent repository',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'quickread-public-metadata-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const original={name:'quickread-longform',version:'1.0.0',private:true,scripts:{test:'node --test','promo:export':'local-promo','release:prepare':'local-release'},repository:'private-worktree'};
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify(original));
  const manifestPath=path.join(root,'manifest.json');
  await fs.writeFile(manifestPath,JSON.stringify({files:[{source:'package.json',destination:'package.json',transform:'package'}]}));
  const output=path.join(root,'tmp/releases/public');
  await prepareRelease(output,{root,manifestPath});
  const pkg=JSON.parse(await fs.readFile(path.join(output,'package.json'),'utf8'));
  assert.equal(pkg.version,'0.1.0');
  assert.equal(pkg.author,'guhou-hvi');
  assert.equal(pkg.repository.url,'https://github.com/guhou-hvi/quickread.git');
  assert.equal(pkg.bugs.url,'https://github.com/guhou-hvi/quickread/issues');
  assert.equal(pkg.license,'SEE LICENSE IN LICENSE');
  assert.deepEqual(pkg.scripts,{test:'node --test'});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')),original);
});
