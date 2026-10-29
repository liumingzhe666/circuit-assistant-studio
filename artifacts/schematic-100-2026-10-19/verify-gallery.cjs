const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'schematic-gallery-')));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 1060, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  try {
    await window.loadFile(path.join(__dirname, 'after/index.html'));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const images=[...document.querySelectorAll('article img')];
      images.forEach(img=>img.loading='eager');
      await Promise.all(images.map(img=>img.decode()));
      const visible=()=>[...document.querySelectorAll('article')].filter(a=>!a.hidden).length;
      const change=(id,value)=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('input'));};
      const checks=[{name:'100 cards and 100 decoded diagrams',pass:visible()===100&&images.length===100&&images.every(img=>img.naturalWidth>0)}];
      change('family','时序与振荡');checks.push({name:'family filter returns five cases',pass:visible()===5});
      change('family','');change('search','S031');checks.push({name:'ID search returns one case',pass:visible()===1});
      change('search','');change('status','pass');checks.push({name:'structural pass filter',pass:visible()===12});
      change('status','fail');checks.push({name:'structural fail filter',pass:visible()===88});
      change('status','duplicate');checks.push({name:'duplicate groups clearly marked',pass:visible()===100});
      change('status','');
      checks.push({name:'no horizontal overflow',pass:document.documentElement.scrollWidth<=window.innerWidth});
      return {checks,passed:checks.filter(c=>c.pass).length,total:checks.length};
    })()`);
    fs.writeFileSync(path.join(__dirname, 'gallery-verification.json'), JSON.stringify(result, null, 2));
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(__dirname, 'gallery-preview.png'), (await window.webContents.capturePage()).toPNG());
    if (result.passed !== result.total) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(path.join(__dirname, 'gallery-error.log'), error.stack || String(error));
    process.exitCode = 1;
  } finally { window.destroy(); app.exit(process.exitCode || 0); }
});
