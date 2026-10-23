import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

// Exercise the production host, worker protocol, and FileReaderSync.
// Unlike benchmark.mjs, this includes runtime initialization and browser I/O.
const [runtimeRoot, fixture, resultPath, mode = 'stream'] = process.argv.slice(2);
if (!runtimeRoot || !fixture || !['stream', 'encode', 'mine'].includes(mode)) {
    throw new Error(
        'Usage: node benchmark-browser.mjs RUNTIME_DIRECTORY MEDIA_FILE [RESULT_JSON] [stream|encode|mine]'
    );
}
const repo = resolve(import.meta.dirname, '../..');
const runtime = resolve(runtimeRoot);
const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'));
const archivePath = '/ffmpeg/runtime.tgz';
// Pack the runtime like a release so the app downloads, verifies, and unpacks it as in production.
const archiveRoot = await mkdtemp(join(tmpdir(), 'asbplayer-benchmark-runtime-'));
const archiveFile = join(archiveRoot, 'runtime.tgz');
execFileSync('tar', [
    '--format=ustar',
    `--transform=s|^${basename(runtime)}|${manifest.runtimeVersion}|`,
    '-czf',
    archiveFile,
    '-C',
    dirname(runtime),
    basename(runtime),
]);
const archive = await readFile(archiveFile);
const bundle = await build({
    stdin: {
        contents: `export { webAudioTranscodeHost } from './client/src/services/ffmpeg.ts';
                   export { createMiningAudioSource, snapshotMiningAudio } from './common/audio-transcode/mining-audio.ts';
                   export { AudioClip } from './common/audio-clip/index.ts';
                   export { default as MediaFragment } from './common/src/media-fragment.ts';
                   export { createBlobUrl, revokeBlobUrl } from './common/blob-url/index.ts';
                   export { transcodeAudioTrack } from './common/audio-transcode/audio-transcoder.ts';
                   export { useTranscodedAudio } from './common/app/hooks/use-transcoded-audio.ts';
                   export { useStreamingAudio } from './common/app/hooks/use-streaming-audio.ts';
                   export { useExternalAudioTrack } from './common/app/hooks/use-external-audio-track.ts';
                   export { clampAudioSeek } from './common/audio-transcode/streaming-audio.ts';
                   export { default as React } from './common/node_modules/react/index.js';
                   export { createRoot } from './common/node_modules/react-dom/client.js';`,
        resolveDir: repo,
        sourcefile: 'benchmark-browser.ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    define: {
        __ASB_FFMPEG_RUNTIME_ARCHIVE__: JSON.stringify({
            url: archivePath,
            sha256: createHash('sha256').update(archive).digest('hex'),
            bytes: archive.byteLength,
        }),
        __ASB_FFMPEG_RELEASE_API_URL__: 'null',
        __ASB_FFMPEG_RUNTIME_VERSION__: JSON.stringify(manifest.runtimeVersion),
        __ASB_FFMPEG_VERSION__: JSON.stringify(manifest.ffmpeg.version),
    },
});
const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (path === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><title>WASM benchmark</title><input type="file" id="input"><div id="root"></div>');
        } else if (path === '/session.js') {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(bundle.outputFiles[0].text);
        } else if (path === archivePath) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.end(archive);
        } else {
            res.writeHead(404);
            res.end();
        }
    } catch (error) {
        res.writeHead(500);
        res.end(error.message);
    }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'asbplayer-audio-benchmark-'));
const chrome = spawn(
    process.env.ASB_CHROME ?? 'google-chrome',
    [
        '--headless=new',
        '--no-sandbox',
        '--disable-extensions',
        '--disable-background-networking',
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
);
let chromeLog = '';
chrome.stderr.on('data', (bytes) => (chromeLog += bytes));
chrome.on('error', (error) => (chromeLog += error.message));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
    let port;
    for (let i = 0; i < 100; i++) {
        try {
            port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
            break;
        } catch {
            await sleep(100);
        }
    }
    if (!port) throw new Error(chromeLog);
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    ws = new WebSocket(targets.find(({ type }) => type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (!message.id) return;
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.reject(message.error);
        else request.resolve(message.result);
    };
    const call = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const requestId = ++id;
            pending.set(requestId, { resolve, reject });
            ws.send(JSON.stringify({ id: requestId, method, params }));
        });
    const evaluate = async (expression) => {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    await call('Page.navigate', { url: origin });
    await sleep(300);
    const document = await call('DOM.getDocument');
    const input = await call('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#input' });
    await call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [resolve(fixture)] });
    await evaluate(`(async()=>{
        const {webAudioTranscodeHost,transcodeAudioTrack,useTranscodedAudio,useStreamingAudio,useExternalAudioTrack,clampAudioSeek,createMiningAudioSource,snapshotMiningAudio,AudioClip,MediaFragment,createBlobUrl,revokeBlobUrl,React,createRoot}=await import('/session.js');
        const start=performance.now(),file=document.querySelector('#input').files[0],mode=${JSON.stringify(mode)};
        let sessions=0;window.benchmark={stage:'starting'};
        const host={...webAudioTranscodeHost,createSession:options=>{sessions++;return webAudioTranscodeHost.createSession(options)}};
        const result=(extra)=>({done:true,seconds:(performance.now()-start)/1000,sessions,inputBytes:file.size,
            cores:navigator.hardwareConcurrency,memoryGb:navigator.deviceMemory,crossOriginIsolated,browser:navigator.userAgent,...extra});
        if(mode==='mine') {
            const fileUrl=createBlobUrl(file);
            let complete=false,checking=false,mining,miningStage='waiting for audio';
            let resolveMining,rejectMining;
            const mined=new Promise((resolve,reject)=>{resolveMining=resolve;rejectMining=reject});
            // Attach a rejection handler immediately while conversion is still running.
            mined.catch(()=>{});
            try {
                const output=await transcodeAudioTrack({file,trackIndex:0,host,signal:new AbortController().signal,
                    onAudio:audio=>{
                        window.benchmark={stage:'transcoding',outputBytes:audio.size,wallSeconds:(performance.now()-start)/1000,sessions,miningStage};
                        if(checking||mining)return;
                        checking=true;
                        void snapshotMiningAudio({audio,required:true,complete:false}).then(createMiningAudioSource).then(async source=>{
                            checking=false;
                            if(!source.transcodedAudioBlobUrl||source.transcodedAudioDurationMs<1200||mining){
                                if(source.transcodedAudioBlobUrl)revokeBlobUrl(source.transcodedAudioBlobUrl);
                                return;
                            }
                            const minedWhileConverting=!complete;
                            const snapshotUrl=source.transcodedAudioBlobUrl;
                            miningStage="loading snapshot";
                            mining=(async()=>{
                                const snapshotAudio=new Audio(snapshotUrl);
                                await new Promise((resolve,reject)=>{
                                    snapshotAudio.addEventListener('loadedmetadata',resolve,{once:true});
                                    snapshotAudio.addEventListener('error',()=>reject(new Error(snapshotAudio.error.message)),{once:true});
                                    snapshotAudio.load();
                                });
                                const snapshotDuration=snapshotAudio.duration;
                                miningStage="recording snapshot";
                                snapshotAudio.removeAttribute('src');snapshotAudio.load();
                                const model={name:file.name,blobUrl:fileUrl,...source};
                                const clip=AudioClip.fromFile(model,source.transcodedAudioDurationMs-600,source.transcodedAudioDurationMs+1000,1,false);
                                const recorded=await clip.blob();
                                miningStage="decoding recording";
                                const context=new AudioContext();
                                const decoded=await context.decodeAudioData(await recorded.arrayBuffer());
                                const samples=decoded.getChannelData(0);
                                let energy=0;for(const sample of samples)energy+=sample*sample;
                                const rms=Math.sqrt(energy/samples.length);
                                await context.close();
                                miningStage="taking screenshot";
                                const screenshot=await MediaFragment.fromFile(model,500,320,180,false).blob();
                                const exported=await clip.base64();
                                miningStage="checking preview cancellation";
                                const preview=AudioClip.fromFile(model,100,1500,1,false);
                                const cancelledRecording=preview.blob().then(()=>false,()=>true);
                                await new Promise(resolve=>setTimeout(resolve,250));
                                await preview.play();
                                await new Promise(resolve=>setTimeout(resolve,200));
                                preview.stop();
                                const recordingCancelled=await cancelledRecording;
                                // Stop must leave the borrowed source alive, and rerecording must still work.
                                const interior=await preview.slice(100,400).blob();
                                const sourceAlive=await fetch(snapshotUrl).then(r=>r.ok);
                                const checks={minedWhileConverting,snapshotDuration,snapshotLimit:source.transcodedAudioDurationMs/1000,
                                    recordedBytes:recorded.size,recordedDuration:decoded.duration,rms,screenshotBytes:screenshot.size,
                                    exportedBytes:exported.length,recordingCancelled,interiorBytes:interior.size,sourceAlive,clippedEnd:clip.end};
                                clip.stop();revokeBlobUrl(snapshotUrl);
                                if(!minedWhileConverting||!recordingCancelled||!interior.size||!sourceAlive||!screenshot.size||!exported.length||rms<0.001||
                                    Math.abs(snapshotDuration-checks.snapshotLimit)>0.03||decoded.duration<0.4||decoded.duration>1.2||clip.end!==source.transcodedAudioDurationMs)
                                    throw new Error('Incomplete mining validation failed: '+JSON.stringify(checks));
                                return checks;
                            })();
                            mining.then(resolveMining,rejectMining);
                        }).catch(rejectMining);
                    }});
                complete=true;
                const timeout=new Promise((_,reject)=>setTimeout(()=>reject(new Error('Incomplete mining timed out: '+miningStage)),15000));
                const checks=await Promise.race([mined,timeout]);
                window.benchmark=result({outputBytes:output.size,...checks});
            }catch(error){window.benchmark=result({error:error.message})}
            finally{revokeBlobUrl(fileUrl)}
            return;
        }
        if(mode==='encode') {
            let firstChunkSeconds;
            try {
                const output=await transcodeAudioTrack({file,trackIndex:0,host,signal:new AbortController().signal,
                    onAudio:audio=>{
                        firstChunkSeconds??=(performance.now()-start)/1000;
                        window.benchmark={stage:'transcoding',outputBytes:audio.size,wallSeconds:(performance.now()-start)/1000,sessions};
                    }});
                window.benchmark=result({mimeType:output.type,outputBytes:output.size,firstChunkSeconds});
            }catch(error){window.benchmark=result({error:error.message})}
            return;
        }
        const source={id:'benchmark',file},videoUrl=URL.createObjectURL(file);
        let firstBufferedSeconds,firstPlaybackSeconds,conversionSeconds,playedWhileConverting=false,seekChecked=false,seekBlocked=false,lastRange,renderCount=0;
        let playingSeconds=0,lastVideoTime=0;
        const mediaEvents=[];let miningProbeStarted=false,completedSeekSucceeded=false;
        function Harness(){
            const [video,setVideo]=React.useState(),[audio,setAudio]=React.useState(null);
            const conversion=useTranscodedAudio(source,host);
            const active=conversion.state==='transcoding'||conversion.state==='ready';
            const url=useStreamingAudio({audio:conversion.blob,complete:conversion.complete,active,video,
                onBuffered:range=>{lastRange=range;if(range?.end>0)firstBufferedSeconds??=(performance.now()-start)/1000},
                onError:error=>window.benchmark=result({error:error.message})});
            useExternalAudioTrack({video,audio,source:url,active,streaming:!conversion.complete});
            React.useEffect(()=>{if(video&&!video.dataset.started){video.dataset.started='true';void video.play()}},[video]);
            React.useEffect(()=>{
                if(!video||!audio)return;
                const update=()=>{
                    const advanced=video.currentTime-lastVideoTime;
                    if(advanced>0&&advanced<0.5&&!video.paused&&!audio.paused)playingSeconds+=advanced;
                    lastVideoTime=video.currentTime;
                    if(!video.paused&&!audio.paused&&audio.currentTime>0){
                        firstPlaybackSeconds??=(performance.now()-start)/1000;
                        if(!conversion.complete)playedWhileConverting=true;
                    }
                    if(!seekChecked&&!conversion.complete&&audio.buffered.length&&audio.currentTime>0){
                        seekChecked=true;video.currentTime=clampAudioSeek(100000,lastRange);
                        setTimeout(()=>{seekBlocked=video.currentTime<=audio.buffered.end(audio.buffered.length-1)},100);
                    }
                };
                const record=(event)=>{mediaEvents.push({event:event.target.tagName+':'+event.type,t:(performance.now()-start)/1000,
                    vt:video.currentTime,at:audio.currentTime,vp:video.paused,ap:audio.paused,vr:video.readyState,ar:audio.readyState,
                    buffered:audio.buffered.length?audio.buffered.end(audio.buffered.length-1):0});if(mediaEvents.length>80)mediaEvents.shift()};
                const types=['play','pause','playing','waiting','seeking','seeked','canplay','error'];
                for(const type of types){video.addEventListener(type,record);audio.addEventListener(type,record)}
                video.addEventListener('timeupdate',update);
                const timer=setInterval(update,50);
                return()=>{video.removeEventListener('timeupdate',update);for(const type of types){video.removeEventListener(type,record);audio.removeEventListener(type,record)}clearInterval(timer)};
            },[video,audio,conversion.complete]);
            React.useEffect(()=>{
                if(conversion.state==='failed')window.benchmark=result({error:String(conversion.error)});
                else if(conversion.complete){
                    conversionSeconds??=(performance.now()-start)/1000;
                    if(!miningProbeStarted){
                        miningProbeStarted=true;
                        const probeUrl=URL.createObjectURL(conversion.blob),probe=new Audio(probeUrl);
                        probe.addEventListener('canplay',()=>{
                            const target=Math.max(0,probe.duration-1);
                            probe.addEventListener('seeked',()=>{
                                completedSeekSucceeded=Number.isFinite(probe.duration)&&probe.readyState>=3&&Math.abs(probe.currentTime-target)<0.1;
                                probe.pause();probe.removeAttribute('src');probe.load();URL.revokeObjectURL(probeUrl);
                            },{once:true});
                            probe.currentTime=target;
                        },{once:true});
                        probe.load();
                    }
                    setTimeout(()=>{if(!window.benchmark.done)window.benchmark=result({outputBytes:conversion.blob.size,
                        firstBufferedSeconds,firstPlaybackSeconds,conversionSeconds,playingSeconds,completedSeekSucceeded,playedWhileConverting,seekBlocked,renderCount,mediaEvents,
                        videoTime:video?.currentTime,audioTime:audio?.currentTime,muted:video?.muted,videoPaused:video?.paused,audioPaused:audio?.paused,videoReadyState:video?.readyState,audioReadyState:audio?.readyState,videoError:video?.error?.message,duration:video?.duration,
                        audioDuration:audio?.duration,bufferedEnd:lastRange?.end,audioError:audio?.error?.message})},1000);
                }else window.benchmark={stage:conversion.state,outputBytes:conversion.blob?.size,wallSeconds:(performance.now()-start)/1000,sessions,firstBufferedSeconds,firstPlaybackSeconds,playingSeconds,videoTime:video?.currentTime,audioTime:audio?.currentTime,videoPaused:video?.paused,audioPaused:audio?.paused,videoReady:video?.readyState,audioReady:audio?.readyState,range:lastRange,mediaEvents,playedWhileConverting};
            },[conversion,video,audio]);
            renderCount++;
            return React.createElement(React.Fragment,null,
                React.createElement('video',{ref:setVideo,src:videoUrl,width:160,controls:true}),
                active&&React.createElement('audio',{ref:setAudio,src:url,preload:'auto'}));
        }
        createRoot(document.querySelector('#root')).render(React.createElement(Harness));
    })();true`);
    for (let i = 0; i < 120; i++) {
        await sleep(5000);
        const status = await evaluate('window.benchmark');
        if (status?.done) {
            if (status.error) throw new Error(JSON.stringify(status));
            if (
                mode === 'stream' &&
                (!status.playedWhileConverting ||
                    !status.seekBlocked ||
                    !status.completedSeekSucceeded ||
                    status.playingSeconds < 0.5 ||
                    !Number.isFinite(status.audioDuration) ||
                    status.audioDuration <= 0 ||
                    status.audioError)
            ) {
                throw new Error(`Streaming playback/seek validation failed: ${JSON.stringify(status)}`);
            }
            const result = {
                fixture: basename(fixture),
                mode,
                wasmSha256: manifest.runtime.find(({ filename }) => filename === 'ffmpeg-core.wasm').sha256,
                ...status,
            };
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
            if (resultPath) await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
            break;
        }
        if (i % 3 === 0) process.stdout.write(JSON.stringify(status) + '\n');
        if (i === 119) throw new Error('Browser benchmark exceeded ten minutes');
    }
} finally {
    ws?.close();
    chrome.kill();
    server.closeAllConnections();
    server.close();
    await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        chrome.once('close', () => {
            clearTimeout(timeout);
            resolve();
        });
    });
    await rm(profile, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
}
