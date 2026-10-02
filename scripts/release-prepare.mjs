import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeCatalog } from './catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const relativeFile = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');

export function publicPipeline(original) {
  const config = structuredClone(original);
  config.reviews.repairRoundOverrides = {};
  for (const key of ['pilotCases','activeCases','frozenCases']) config.migration[key] = [];
  config.migration.humanReviewFirstCase = null;
  config.contextUpgrade.allowlist = [];
  config.contextUpgrade.batches = {};
  return config;
}

export async function prepareRelease(output, { root = ROOT, manifestPath = path.join(root, 'release/public-files.json'), approved = false } = {}) {
  root = await fs.realpath(root);
  if (!output) throw new Error('用法：npm run release:prepare -- <新的输出目录> [--approved]');
  if (typeof approved !== 'boolean') throw new Error('approved 必须为布尔值。');
  const target = path.resolve(root, output);
  // Never copy into a source directory, overwrite an existing snapshot, or follow a destination symlink.
  if (inside(target, root) || (inside(root, target) && !inside(path.join(root,'tmp','releases'),target))) throw new Error('仓库内输出必须位于 tmp/releases/，不能覆盖工作目录。');
  let ancestor = path.dirname(target);
  while (!(await fs.lstat(ancestor).then(() => true, e => {if(e.code==='ENOENT')return false;throw e;}))) ancestor = path.dirname(ancestor);
  if (path.resolve(await fs.realpath(ancestor)).toLowerCase() !== ancestor.toLowerCase()) throw new Error('输出路径不得经过符号链接或目录联接。');
  if (await fs.lstat(target).then(() => true, e => {if(e.code==='ENOENT')return false;throw e;})) throw new Error('输出目录已存在；请使用新目录，原文件不会覆盖。');
  const manifest = JSON.parse(await fs.readFile(manifestPath,'utf8'));
  const seen = new Set();
  const prepared = [];
  for (const entry of manifest.files) {
    if (!relativeFile(entry.source) || !relativeFile(entry.destination)) throw new Error('非法清单路径');
    const key=entry.destination.toLowerCase();
    if (seen.has(key)) throw new Error('重复输出路径');
    seen.add(key);
    if (/^(cases|inbox)\//.test(key) && key !== 'inbox/readme.md') throw new Error('禁止复制本地材料与案例');
    const source=await fs.realpath(path.join(root,entry.source));
    if (!inside(root,source) || !(await fs.stat(source)).isFile()) throw new Error('源文件越界或不是文件');
    let bytes=await fs.readFile(source);
    const sourceSha256=hash(bytes);
    if (entry.transform === 'pipeline') bytes=Buffer.from(JSON.stringify(publicPipeline(JSON.parse(bytes)),null,2)+'\n');
    else if (entry.transform === 'package') {
      const pkg=JSON.parse(bytes); delete pkg.scripts['promo:export']; delete pkg.scripts['release:prepare'];
      pkg.version='0.1.0';
      pkg.license='SEE LICENSE IN LICENSE';
      pkg.author='guhou-hvi';
      pkg.repository={type:'git',url:'https://github.com/guhou-hvi/quickread.git'};
      pkg.homepage='https://github.com/guhou-hvi/quickread';
      pkg.bugs={url:'https://github.com/guhou-hvi/quickread/issues'};
      bytes=Buffer.from(JSON.stringify(pkg,null,2)+'\n');
    } else if (entry.transform === 'lock') {
      const lock=JSON.parse(bytes); lock.version='0.1.0'; lock.packages[''].version='0.1.0'; lock.packages[''].license='SEE LICENSE IN LICENSE';
      bytes=Buffer.from(JSON.stringify(lock,null,2)+'\n');
    } else if (entry.transform) throw new Error('未知转换：'+entry.transform);
    prepared.push({entry,bytes,sourceSha256});
  }
  await fs.mkdir(path.dirname(target),{recursive:true});
  // mkdir is exclusive: a racing process must not cause us to overwrite its directory.
  await fs.mkdir(target);
  const records=[];
  for (const {entry,bytes,sourceSha256} of prepared) {
    const dest=path.join(target,entry.destination);
    await fs.mkdir(path.dirname(dest),{recursive:true});
    await fs.writeFile(dest,bytes,{flag:'wx'});
    records.push({path:entry.destination,source:entry.source,sourceSha256,sha256:hash(bytes),bytes:bytes.length,transform:entry.transform??null});
  }
  await fs.mkdir(path.join(target,'cases'));
  await writeCatalog(path.join(target,'cases'));
  for (const name of ['README.md','index.html']) {
    const relative='cases/'+name,bytes=await fs.readFile(path.join(target,relative));
    records.push({path:relative,source:null,sha256:hash(bytes),bytes:bytes.length,transform:'empty-catalog'});
  }
  const report={schemaVersion:'1.0.0',status:approved?'release-snapshot':'candidate-not-published',licenseStatus:approved?'owner-approved':'draft-pending-owner-review',manifestSha256:hash(await fs.readFile(manifestPath)),files:records.sort((a,b)=>a.path.localeCompare(b.path)),gitHistoryIncluded:false};
  await fs.writeFile(path.join(target,'release-manifest.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return {output:target,files:records.length,status:report.status};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if (!args[0] || args[0].startsWith('--') || args.slice(1).some(arg=>arg!=='--approved') || args.filter(arg=>arg==='--approved').length>1) {
    console.error('用法：npm run release:prepare -- <新的输出目录> [--approved]');
    process.exitCode=1;
  } else {
    prepareRelease(args[0],{approved:args.includes('--approved')}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
  }
}
