import {Input,Output,BlobSource,ALL_FORMATS,AudioSampleSink,VideoSampleSink,AudioSampleSource,VideoSampleSource,AudioSample,Mp4OutputFormat,BufferTarget,StreamTarget,getFirstEncodableVideoCodec,getFirstEncodableAudioCodec} from 'mediabunny';

const $=id=>document.getElementById(id);
const FRAME=.02, BLOCK=.25, NFFT=1024, HOP=256;
const S={file:null,input:null,vt:null,at:null,dur:0,env:null,blocks:[],noise:null,segs:[],busy:false,cancel:false,objUrl:null,sr:0,ch:0,outBlob:null,outName:''};
const fmt=t=>{t=Math.max(0,t);const m=Math.floor(t/60),s=t-m*60;return `${m}:${String(Math.floor(s)).padStart(2,'0')}`};
const pretty=t=>{t=Math.round(t);const m=Math.floor(t/60),s=t%60;return m?`${m}분 ${s}초`:`${s}초`};
const say=(msg,kind='')=>{const e=$('status');e.textContent=msg;e.dataset.kind=kind};

/* ---------- FFT ---------- */
const hann=new Float32Array(NFFT);for(let i=0;i<NFFT;i++)hann[i]=.5-.5*Math.cos(2*Math.PI*i/NFFT);
const cosT=new Float32Array(NFFT/2),sinT=new Float32Array(NFFT/2);for(let i=0;i<NFFT/2;i++){cosT[i]=Math.cos(2*Math.PI*i/NFFT);sinT[i]=Math.sin(2*Math.PI*i/NFFT)}
const rev=new Uint16Array(NFFT);{const b=Math.log2(NFFT);for(let i=0;i<NFFT;i++){let r=0;for(let j=0;j<b;j++)if(i&(1<<j))r|=1<<(b-1-j);rev[i]=r}}
function fft(re,im,inv){for(let i=0;i<NFFT;i++){const j=rev[i];if(j>i){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t}}
 for(let size=2;size<=NFFT;size*=2){const h=size/2,st=NFFT/size;for(let i=0;i<NFFT;i+=size)for(let j=0,k=0;j<h;j++,k+=st){const w=cosT[k],x=inv?-sinT[k]:sinT[k],a=i+j,b=a+h;const tr=re[b]*w+im[b]*x,ti=im[b]*w-re[b]*x;re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti}}
 if(inv)for(let i=0;i<NFFT;i++){re[i]/=NFFT;im[i]/=NFFT}}
const rfftRe=new Float32Array(NFFT),rfftIm=new Float32Array(NFFT);
function magSpec(x,off,out){for(let i=0;i<NFFT;i++){rfftRe[i]=(x[off+i]||0)*hann[i];rfftIm[i]=0}fft(rfftRe,rfftIm,false);for(let i=0;i<=NFFT/2;i++)out[i]=Math.hypot(rfftRe[i],rfftIm[i])}

/* streaming spectral noise reducer for one channel */
class Denoiser{constructor(noise,strength){this.n=noise;this.floor=Math.pow(10,-(strength*.3)/20);this.over=1+strength/100*1.6;this.in=new Float32Array(NFFT);this.ola=new Float32Array(NFFT);this.fill=0;this.g=new Float32Array(NFFT/2+1).fill(1);this.re=new Float32Array(NFFT);this.im=new Float32Array(NFFT);this.ng=new Float32Array(NFFT/2+1);this.out=[];this.primed=false;this.skip=NFFT-HOP}
 frame(){const {re,im,n,g,ng}=this;for(let i=0;i<NFFT;i++){re[i]=this.in[i]*hann[i];im[i]=0}fft(re,im,false);
  for(let k=0;k<=NFFT/2;k++){const m=Math.hypot(re[k],im[k])+1e-12;ng[k]=Math.max(this.floor,1-this.over*n[k]/m)}
  for(let k=0;k<=NFFT/2;k++){const a=ng[Math.max(0,k-1)],b=ng[k],c=ng[Math.min(NFFT/2,k+1)],v=(a+2*b+c)/4;g[k]=v>g[k]?.55*v+.45*g[k]:.7*g[k]+.3*v;if(g[k]<this.floor)g[k]=this.floor}
  for(let k=0;k<=NFFT/2;k++){re[k]*=g[k];im[k]*=g[k];if(k>0&&k<NFFT/2){re[NFFT-k]=re[k];im[NFFT-k]=-im[k]}}
  fft(re,im,true);for(let i=0;i<NFFT;i++)this.ola[i]+=re[i]*hann[i]*(2/3)*(HOP/256);
  const o=new Float32Array(HOP);o.set(this.ola.subarray(0,HOP));this.ola.copyWithin(0,HOP);this.ola.fill(0,NFFT-HOP);
  if(this.skip>0){const d=Math.min(this.skip,HOP);this.skip-=d;if(d<HOP)this.out.push(o.subarray(d))}else this.out.push(o)}
 push(x){let p=0;while(p<x.length){const take=Math.min(HOP-this.fill%HOP||HOP,x.length-p);if(!this.primed){this.in.set(x.subarray(p,p+take),NFFT-HOP+this.fill)}else{this.in.set(x.subarray(p,p+take),NFFT-HOP+this.fill)}this.fill+=take;p+=take;if(this.fill===HOP){this.frame();this.in.copyWithin(0,HOP);this.in.fill(0,NFFT-HOP);this.fill=0}}return this.drain()}
 flush(total){const z=new Float32Array(HOP);for(let i=0;i<5;i++)this.push(z);return this.drain()}
 drain(){if(!this.out.length)return new Float32Array(0);const l=this.out.reduce((a,b)=>a+b.length,0),r=new Float32Array(l);let o=0;for(const b of this.out){r.set(b,o);o+=b.length}this.out=[];return r}}

/* ---------- reading audio ---------- */
function planes(sample,ch){const n=sample.numberOfFrames,r=[];for(let c=0;c<ch;c++){const k=Math.min(c,sample.numberOfChannels-1),o={planeIndex:k,format:'f32-planar'},a=new Float32Array(n);sample.copyTo(a,o);r.push(a)}return r}
function mono(p){if(p.length===1)return p[0];const m=new Float32Array(p[0].length);for(let i=0;i<m.length;i++){let s=0;for(const c of p)s+=c[i];m[i]=s/p.length}return m}

async function openFile(file){
 reset();S.file=file;$('fileName').textContent=file.name;$('fileMeta').textContent=`${(file.size/1048576).toFixed(0)}MB`;
 setStage('analyzing');say('영상을 여는 중이에요');
 try{
  S.input=new Input({formats:ALL_FORMATS,source:new BlobSource(file)});
  S.vt=await S.input.getPrimaryVideoTrack();S.at=await S.input.getPrimaryAudioTrack();
  if(!S.at)throw new Error('이 파일에는 소리가 없어서 말 없는 부분을 찾을 수 없어요.');
  if(!await S.at.canDecode())throw new Error('이 기기 브라우저가 이 파일의 소리 형식을 읽지 못해요. 최신 Chrome에서 다시 열어 보세요.');
  if(S.vt&&!await S.vt.canDecode())throw new Error('이 기기 브라우저가 이 파일의 영상 형식을 읽지 못해요. 고효율(HEVC) 영상이면 카메라 설정을 호환성 우선으로 바꾼 영상을 써 보세요.');
  S.dur=await S.input.computeDuration();S.sr=await S.at.getSampleRate?.()||S.at.sampleRate;S.ch=Math.min(2,await S.at.getNumberOfChannels?.()||S.at.numberOfChannels);
  try{if(S.objUrl)URL.revokeObjectURL(S.objUrl);S.objUrl=URL.createObjectURL(file);$('player').src=S.objUrl;$('playerWrap').hidden=false}catch(e){$('playerWrap').hidden=true}
  await analyze();
  computeSegs();setStage('ready');say('구간을 찾았어요. 분홍색 부분이 잘려요.','ok');
 }catch(e){console.error(e);setStage('empty');say(e.message||'이 파일을 열 수 없어요. 다른 영상으로 해 보세요.','err')}
}
async function analyze(){
 const sink=new AudioSampleSink(S.at),sr=S.sr,fl=Math.round(FRAME*sr),bl=Math.round(BLOCK*sr);
 const nFrames=Math.ceil(S.dur/FRAME)+2;S.env=new Float32Array(nFrames);
 let frameE=0,cnt=0,fi=0,hist=new Float32Array(NFFT),hp=0,since=0;const spec=new Float32Array(NFFT/2+1),tmp=new Float32Array(NFFT);S.blocks=[];
 const t0=performance.now();let lastUi=0;
 for await(const s of sink.samples()){
  if(S.cancel){s.close();throw new Error('취소했어요.')}
  const m=mono(planes(s,S.ch)),ts=s.timestamp;s.close();
  if(fi===0&&ts>0)fi=Math.floor(ts/FRAME);
  for(let i=0;i<m.length;i++){const v=m[i];frameE+=v*v;cnt++;if(cnt>=fl){if(fi<nFrames)S.env[fi]=Math.sqrt(frameE/cnt);fi++;frameE=0;cnt=0}
   hist[hp]=v;hp=(hp+1)%NFFT;since++;
   if(since>=bl){since=0;for(let j=0;j<NFFT;j++)tmp[j]=hist[(hp+j)%NFFT];let e=0;for(let j=0;j<NFFT;j++)e+=tmp[j]*tmp[j];magSpec(tmp,0,spec);S.blocks.push({e,m:spec.slice()})}}
  const now=performance.now();if(now-lastUi>150){lastUi=now;setProg(Math.min(1,(ts+s.duration)/S.dur),'소리 분석 중');await new Promise(r=>setTimeout(r))}
 }
 const sorted=S.blocks.slice().sort((a,b)=>a.e-b.e),take=Math.max(4,Math.floor(sorted.length*.15));
 const n=new Float32Array(NFFT/2+1);for(let i=0;i<Math.min(take,sorted.length);i++){const b=sorted[i].m;for(let k=0;k<n.length;k++)n[k]+=b[k]}
 for(let k=0;k<n.length;k++)n[k]/=Math.min(take,Math.max(1,sorted.length));S.noise=n;S.blocks=[];
 const db=new Float32Array(S.env.length);for(let i=0;i<db.length;i++)db[i]=20*Math.log10(S.env[i]+1e-6);S.db=db;
 const v=Array.from(db).sort((a,b)=>a-b);S.floorDb=v[Math.floor(v.length*.1)];S.peakDb=v[Math.floor(v.length*.97)];
}
function computeSegs(){
 if(!S.db)return;const sens=+$('sens').value/100,gap=+$('gap').value/10,pad=+$('pad').value/1000;
 const range=Math.max(6,S.peakDb-S.floorDb),th=S.floorDb+range*(.62-.5*sens);
 const raw=[];let st=-1;for(let i=0;i<S.db.length;i++){if(S.db[i]>th){if(st<0)st=i}else if(st>=0){raw.push([st*FRAME,i*FRAME]);st=-1}}if(st>=0)raw.push([st*FRAME,S.db.length*FRAME]);
 const merged=[];for(const r of raw){const l=merged[merged.length-1];if(l&&r[0]-l[1]<gap)l[1]=r[1];else merged.push(r.slice())}
 let segs=merged.filter(r=>r[1]-r[0]>=.12).map(r=>[Math.max(0,r[0]-pad),Math.min(S.dur,r[1]+pad)]);
 const out=[];for(const r of segs){const l=out[out.length-1];if(l&&r[0]<=l[1])l[1]=r[1];else out.push(r)}
 S.segs=out;const keep=out.reduce((a,r)=>a+r[1]-r[0],0);
 $('statBefore').textContent=pretty(S.dur);$('statAfter').textContent=pretty(keep);$('statCuts').textContent=`${Math.max(0,out.length-(out.length&&out[0][0]<.05?1:0))}곳`;$('statSaved').textContent=S.dur?`${Math.round((1-keep/S.dur)*100)}%`:'0%';
 $('export').disabled=!out.length;draw();
}

/* ---------- wave view ---------- */
function exampleEnv(){const n=900,e=new Float32Array(n);for(let i=0;i<n;i++){const t=i/n,sp=[[.03,.2],[.27,.42],[.5,.56],[.66,.93]].some(([a,b])=>t>a&&t<b);e[i]=sp?.15+.7*Math.abs(Math.sin(i*.13)*Math.sin(i*.041+1)):.03+.02*Math.abs(Math.sin(i*.7))}return e}
function draw(){
 const c=$('wave'),w=c.clientWidth||600,h=c.clientHeight||150,dpr=Math.min(2,devicePixelRatio||1);c.width=w*dpr;c.height=h*dpr;const g=c.getContext('2d');g.scale(dpr,dpr);
 const cs=getComputedStyle(document.documentElement),col=n=>cs.getPropertyValue(n).trim();
 const demo=!S.env,env=S.env||exampleEnv(),dur=S.env?S.dur:100,segs=S.env?S.segs:[[3,20],[27,42],[50,56],[66,93]];
 g.fillStyle=col('--cut-bg');g.fillRect(0,0,w,h);g.fillStyle=col('--panel-2');for(const r of segs)g.fillRect(r[0]/dur*w,0,(r[1]-r[0])/dur*w,h);
 let mx=1e-4;for(let i=0;i<env.length;i++)if(env[i]>mx)mx=env[i];const bar=2,step=3,mid=h/2,fr=env.length/w;
 for(let x=0;x<w;x+=step){let m=0;const a=Math.floor(x*fr),b=Math.max(a+1,Math.floor((x+step)*fr));for(let i=a;i<b&&i<env.length;i++)if(env[i]>m)m=env[i];const v=Math.pow(m/mx,.6),t=x/w*dur,kept=segs.some(r=>t>=r[0]&&t<=r[1]),H=Math.max(1,v*(h*.44));g.fillStyle=kept?col('--accent'):col('--cut');g.fillRect(x,mid-H,bar,H*2)}
 $('demoTag').hidden=!demo;
 const p=$('player');if(!demo&&p&&p.duration){g.fillStyle=col('--fg');g.fillRect(p.currentTime/dur*w-1,0,2,h)}
}
function setStage(s){document.body.dataset.stage=s;$('controls').hidden=!(s==='ready'||s==='done'||s==='exporting');$('progressWrap').hidden=!(s==='analyzing'||s==='exporting');$('resultBox').hidden=s!=='done';$('export').hidden=s==='exporting';$('cancel').hidden=s!=='exporting'&&s!=='analyzing'}
function setProg(v,label){$('bar').style.width=(v*100).toFixed(1)+'%';$('progLabel').textContent=`${label} ${Math.round(v*100)}%`}
function reset(){S.cancel=false;S.env=null;S.db=null;S.segs=[];S.outBlob=null;$('resultBox').hidden=true;draw()}

/* ---------- player skipping cuts ---------- */
function tick(){const p=$('player');if(!p.paused&&$('skipCuts').checked&&S.segs.length){const t=p.currentTime;let inside=false,next=null;for(const r of S.segs){if(t>=r[0]&&t<r[1]-.01){inside=true;break}if(r[0]>t){next=r[0];break}}if(!inside){if(next===null)p.pause();else p.currentTime=next}}draw();requestAnimationFrame(tick)}

/* ---------- sound preview ---------- */
let actx,src;
async function preview(useFilter){
 if(!S.segs.length)return;const longest=S.segs.slice().sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]))[0];const s0=longest[0],e0=Math.min(longest[1],s0+8);
 $('hearOrig').disabled=$('hearClean').disabled=true;say('소리를 준비하는 중이에요');
 try{const sink=new AudioSampleSink(S.at),pcm=[[],[]];for await(const s of sink.samples(s0,e0)){const p=planes(s,S.ch);for(let c=0;c<S.ch;c++)pcm[c].push(p[c]);s.close()}
  const data=pcm.slice(0,S.ch).map(a=>{const l=a.reduce((x,y)=>x+y.length,0),r=new Float32Array(l);let o=0;for(const b of a){r.set(b,o);o+=b.length}return r});
  const amt=+$('noise').value,res=useFilter&&amt>0?data.map(d=>{const dn=new Denoiser(S.noise,amt),a=dn.push(d),b=dn.flush(),m=new Float32Array(d.length);m.set(a.subarray(0,Math.min(d.length,a.length)));if(a.length<d.length)m.set(b.subarray(0,d.length-a.length),a.length);return m}):data;
  actx=actx||new (window.AudioContext||window.webkitAudioContext)();await actx.resume();if(src)try{src.stop()}catch(e){}
  const buf=actx.createBuffer(res.length,res[0].length,S.sr);res.forEach((d,i)=>buf.copyToChannel(d,i));src=actx.createBufferSource();src.buffer=buf;src.connect(actx.destination);src.start();say(useFilter?'소음을 줄인 소리를 재생하고 있어요':'원본 소리를 재생하고 있어요','ok')
 }catch(e){console.error(e);say('미리 듣기를 재생하지 못했어요.','err')}
 $('hearOrig').disabled=$('hearClean').disabled=false}

/* ---------- export ---------- */
async function makeTarget(){try{const root=await navigator.storage.getDirectory();const h=await root.getFileHandle('malcut-output.mp4',{create:true});const w=await h.createWritable();return {target:new StreamTarget(w,{chunked:true}),format:new Mp4OutputFormat({fastStart:false}),done:async()=>new Blob([await h.getFile()],{type:'video/mp4'})}}catch(e){const t=new BufferTarget();return {target:t,format:new Mp4OutputFormat({fastStart:'in-memory'}),done:async()=>new Blob([t.buffer],{type:'video/mp4'})}}}
async function runExport(){
 if(S.busy)return;S.busy=true;S.cancel=false;setStage('exporting');$('controls').classList.add('locked');let lock=null;try{lock=await navigator.wakeLock?.request('screen')}catch(e){}
 const total=S.segs.reduce((a,r)=>a+r[1]-r[0],0);let doneV=0,doneA=0;const hasV=!!S.vt,update=()=>setProg(Math.min(1,hasV?(doneV/total*.8+doneA/total*.2):doneA/total),'영상 만드는 중');
 let output;
 try{
  const {target,format,done}=await makeTarget();output=new Output({format,target});
  let vsrc=null;
  if(hasV){const w=await (S.vt.getDisplayWidth?.()??S.vt.displayWidth),h=await (S.vt.getDisplayHeight?.()??S.vt.displayHeight);
   let br=8e6;try{const st=await S.vt.computePacketStats(120);if(st.averageBitrate)br=Math.round(Math.min(25e6,Math.max(15e5,st.averageBitrate)))}catch(e){}
   const vc=await getFirstEncodableVideoCodec(['avc','hevc','vp9','av1'],{width:w,height:h,bitrate:br});if(!vc)throw new Error('이 기기 브라우저에서 영상을 저장할 수 없어요. 최신 Chrome에서 해 보세요.');
   vsrc=new VideoSampleSource({codec:vc,bitrate:br,keyFrameInterval:2,latencyMode:'quality'});const meta={};const rot=await S.vt.getRotation();if(rot)meta.rotation=rot;output.addVideoTrack(vsrc,meta)}
  const ac=await getFirstEncodableAudioCodec(['aac','opus'],{numberOfChannels:S.ch,sampleRate:S.sr,bitrate:192e3})||await getFirstEncodableAudioCodec(['aac','opus'],{numberOfChannels:S.ch,sampleRate:48000,bitrate:192e3});if(!ac)throw new Error('이 기기 브라우저에서 소리를 저장할 수 없어요.');
  const outSr=ac==='opus'?48000:S.sr;
  const asrc=new AudioSampleSource({codec:ac,bitrate:192e3});output.addAudioTrack(asrc);
  await output.start();
  const check=()=>{if(S.cancel)throw new Error('__cancel')};
  const videoJob=async()=>{if(!hasV)return;const sink=new VideoSampleSink(S.vt);let off=0,last=-1;
   for(const [a,b] of S.segs){for await(const s of sink.samples(a,b)){try{check();const ts=Math.max(off,off+s.timestamp-a);if(ts>last){s.setTimestamp(ts);await vsrc.add(s);last=ts;doneV=ts;update()}}finally{s.close()}}off+=b-a}};
  const audioJob=async()=>{const sink=new AudioSampleSink(S.at),amt=+$('noise').value;let writtenFrames=0;const fade=Math.round(.008*outSr),ratio=outSr/S.sr;
   const emit=async(ch)=>{const n=ch[0].length;if(!n)return;const data=new Float32Array(n*S.ch);for(let c=0;c<S.ch;c++)data.set(ch[c],c*n);const smp=new AudioSample({data,format:'f32-planar',numberOfChannels:S.ch,sampleRate:outSr,timestamp:writtenFrames/outSr});await asrc.add(smp);smp.close();writtenFrames+=n;doneA=writtenFrames/outSr;update()};
   for(const [a,b] of S.segs){const dn=amt>0?Array.from({length:S.ch},()=>new Denoiser(S.noise,amt)):null;const want=Math.round((b-a)*S.sr);let got=0,out=0,fresh=true;const wantOut=Math.round((b-a)*outSr);const carry=[];let rs=Array.from({length:S.ch},()=>({pos:0,prev:0}));
    const prepare=async(ch)=>{if(ratio!==1)ch=ch.map((x,c)=>{const st=rs[c],len=Math.floor((x.length-st.pos)*ratio),r=new Float32Array(Math.max(0,len));for(let i=0;i<r.length;i++){const p=st.pos+i/ratio,i0=Math.floor(p),f=p-i0,x0=i0<0?st.prev:x[i0],x1=x[Math.min(x.length-1,i0+1)];r[i]=x0+(x1-x0)*f}st.pos=st.pos+r.length/ratio-x.length;st.prev=x[x.length-1];return r});
     let n=Math.min(ch[0].length,wantOut-out);if(n<=0)return;ch=ch.map(x=>x.subarray(0,n));if(fresh){for(const x of ch)for(let i=0;i<Math.min(fade,n);i++)x[i]*=i/fade;fresh=false}out+=n;const remaining=wantOut-out;if(remaining<fade)for(const x of ch)for(let i=Math.max(0,n-(fade-remaining));i<n;i++){const left=wantOut-(out-n+i);x[i]*=Math.max(0,left/fade)}await emit(ch)};
    for await(const s of sink.samples(a,b+.05)){try{check();let p=planes(s,S.ch);const st=s.timestamp;let skip=Math.max(0,Math.round((a-st)*S.sr));if(skip>=p[0].length)continue;p=p.map(x=>x.subarray(skip));const rem=want-got;if(rem<=0)continue;if(p[0].length>rem)p=p.map(x=>x.subarray(0,rem));got+=p[0].length;
      const ch=dn?p.map((x,c)=>dn[c].push(x)):p;if(ch[0].length)await prepare(ch)}finally{s.close()}}
    if(dn){const t=dn.map(d=>d.flush());if(t[0].length)await prepare(t)}
    if(out<wantOut){const z=Array.from({length:S.ch},()=>new Float32Array(wantOut-out));await emit(z);out=wantOut}
   }};
  await Promise.all([videoJob(),audioJob()]);vsrc&&vsrc.close();asrc.close();await output.finalize();
  S.outBlob=await done();S.outName=S.file.name.replace(/\.[^.]+$/,'')+'_말컷.mp4';$('resultMeta').textContent=`${pretty(total)} · ${(S.outBlob.size/1048576).toFixed(0)}MB`;window.__lastBlob=S.outBlob;
  setStage('done');say('완성했어요. 저장 버튼을 눌러 주세요.','ok');
 }catch(e){try{await output?.cancel()}catch(_){}
  if(e.message==='__cancel'){setStage('ready');say('저장을 취소했어요.')}else{console.error(e);setStage('ready');say(e.message&&/[가-힣]/.test(e.message)?e.message:'영상을 만들다 멈췄어요. 메모리가 부족할 수 있으니 다른 앱을 닫고 다시 해 보세요.','err')}}
 S.busy=false;$('controls').classList.remove('locked');try{lock?.release()}catch(e){}}
async function saveResult(){
 if(!S.outBlob)return;try{const dl=window.claude?await Promise.race([window.claude.use('downloads'),new Promise(r=>setTimeout(()=>r(null),3000))]):null;
  if(dl){await dl.save({filename:S.outName,data:S.outBlob});say('저장했어요. 내 파일의 다운로드 폴더를 확인해 주세요.','ok');return}}catch(e){if(e.code==='declined'){say('저장을 취소했어요.');return}if(e.code==='too_large'){say('파일이 너무 커서 여기서는 저장할 수 없어요. 일반 브라우저로 이 앱을 열면 저장할 수 있어요.','err');return}}
 const u=URL.createObjectURL(S.outBlob),a=document.createElement('a');a.href=u;a.download=S.outName;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000);say('저장했어요. 내 파일의 다운로드 폴더를 확인해 주세요.','ok')}

/* ---------- wiring ---------- */
$('file').addEventListener('change',e=>{const f=e.target.files[0];if(f)openFile(f)});
for(const id of ['sens','gap','pad'])$(id).addEventListener('input',()=>{$(id+'Val').textContent=id==='gap'?(+$(id).value/10).toFixed(1)+'초':id==='pad'?(+$(id).value/1000).toFixed(2)+'초':$(id).value;computeSegs()});
$('noise').addEventListener('input',()=>{const v=+$('noise').value;$('noiseVal').textContent=v===0?'끔':v<35?'약하게':v<70?'보통':'강하게'});
$('export').addEventListener('click',runExport);$('cancel').addEventListener('click',()=>{S.cancel=true});$('save').addEventListener('click',saveResult);
$('hearOrig').addEventListener('click',()=>preview(false));$('hearClean').addEventListener('click',()=>preview(true));
$('wave').addEventListener('click',e=>{if(!S.env)return;const r=e.target.getBoundingClientRect(),t=(e.clientX-r.left)/r.width*S.dur,p=$('player');if(p.src)p.currentTime=t;draw()});
addEventListener('resize',draw);new ResizeObserver(draw).observe($('wave'));
setStage('empty');draw();requestAnimationFrame(tick);
if('serviceWorker' in navigator&&window.__PWA){navigator.serviceWorker.register('sw.js').catch(()=>{})}
