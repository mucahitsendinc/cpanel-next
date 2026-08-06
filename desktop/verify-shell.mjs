import { app, BrowserWindow } from 'electron';
app.whenReady().then(async () => {
  const { startServer } = await import(new URL('./app-lib/ui-server/server.mjs', import.meta.url).href);
  const server = await startServer({ port: 0 });
  const probe = `(() => {
    const h = document.createElement('header');
    const b = document.createElement('button');
    h.appendChild(b); document.body.appendChild(h);
    const cs = getComputedStyle(h), bs = getComputedStyle(b);
    const out = { bodyClass: document.body.className, drag: cs.webkitAppRegion,
                  padLeft: cs.paddingLeft, btnDrag: bs.webkitAppRegion };
    h.remove(); return out;
  })()`;
  const w = new BrowserWindow({ show: false, titleBarStyle: 'hiddenInset', webPreferences: { sandbox: true } });
  await w.loadURL(`${server.url}&shell=mac`);
  console.log('MASAUSTU=' + JSON.stringify(await w.webContents.executeJavaScript(probe)));
  const w2 = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await w2.loadURL(server.url);
  console.log('TARAYICI=' + JSON.stringify(await w2.webContents.executeJavaScript(probe)));
  await server.close(); app.exit(0);
}).catch((e) => { console.error('HATA', e.message); app.exit(1); });
