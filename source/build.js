const esbuild=require('esbuild'),fs=require('fs');
const js=esbuild.buildSync({entryPoints:['src/app.js'],bundle:true,minify:true,format:'iife',target:'chrome100',write:false,charset:'utf8',legalComments:'none'}).outputFiles[0].text.replace(/<\/script/g,'<\\/script');
const body=fs.readFileSync('src/body.html','utf8');
const fonts='<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans+KR:wght@400;600;700&display=swap">';
fs.mkdirSync('dist/pages',{recursive:true});
fs.writeFileSync('dist/malcut.html',`<title>말컷</title><meta name="claude:viewport-fit-sides" content="cover">${fonts}\n${body}\n<script>${js}</script>\n`);
fs.writeFileSync('dist/pages/index.html',`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>말컷</title><link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#2340c8">${fonts}<script>window.__PWA=true</script></head><body>\n${body}\n<script>${js}</script>\n</body></html>\n`);
console.log((js.length/1024|0)+'KB');
