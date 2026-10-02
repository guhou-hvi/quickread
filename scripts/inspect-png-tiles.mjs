import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveCaseDir, sha256File, writeJson } from './lib.mjs';

// Read-only visual inspection: display existing PNG pixels at 1:1 and capture
// viewport tiles. Never edits the deliverable or reflows its HTML content.
const caseDir=resolveCaseDir(process.argv[2]);
const out=path.join(caseDir,'work/visual-inspection');
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
try{
  const images=[];
  for(const name of ['quickread.png','quickread-mobile.png']){
    const png=path.join(caseDir,'output',name);
    const header=await fs.readFile(png);
    const width=header.readUInt32BE(16),height=header.readUInt32BE(20);
    const page=await browser.newPage({viewport:{width,height:Math.min(4500,height)},deviceScaleFactor:1});
    await page.setContent('<style>html,body{margin:0;padding:0;overflow:hidden}img{display:block;max-width:none;position:absolute;left:0;top:0}</style><img>');
    // Playwright routes the local bytes; no file permission changes or network.
    await page.route('https://quickread-inspection.invalid/source.png',route=>route.fulfill({body:header,contentType:'image/png'}));
    await page.locator('img').evaluate((img,url)=>{img.src=url;},'https://quickread-inspection.invalid/source.png');
    await page.locator('img').evaluate(img=>img.decode());
    const tiles=[];
    for(let top=0,index=1;top<height;top+=4500,index++){
      const tileHeight=Math.min(4500,height-top);
      await page.setViewportSize({width,height:tileHeight});
      await page.locator('img').evaluate((img,y)=>{img.style.top=`-${y}px`;},top);
      const filename=`${path.basename(name,'.png')}-${String(index).padStart(2,'0')}.png`;
      await page.screenshot({path:path.join(out,filename),animations:'disabled'});
      tiles.push({file:filename,top,width,height:tileHeight});
    }
    images.push({file:name,sha256:await sha256File(png),width,height,tiles});
    await page.close();
  }
  await writeJson(path.join(out,'tiles.json'),{caseId:path.basename(caseDir),method:'existing_png_pixels_1_to_1',images,reviewStatus:'pending'});
  console.log(out);
}finally{await browser.close();}
