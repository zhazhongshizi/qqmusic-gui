// Browser fixture only: exercises shipped remote assets without an account or native playback.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.QMG_PLAYWRIGHT_MODULE || require.resolve('playwright', {
  paths: [process.cwd(), path.join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node')],
}));
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/remote-webui');
const secret = 'a'.repeat(32);
const commands = [];
const libraryRequests = [];
const localSong = {id:`local_${'a'.repeat(64)}_mp3`,title:'电脑本地歌曲',artist:'本地歌手',album:'本地专辑',durationMs:240000,format:'mp3'};
let signedIn = true;
const catalogSongs = Array.from({length:25}, (_,i)=>({id:`catalog${i}`, title:`曲库歌曲 ${i+1}`, subtitle:'', artists:[{id:'artist1',name:'测试歌手'}], artist:'测试歌手',album:'测试专辑',durationMs:240000,qualityCandidates:['flac','320k','128k'].map(quality=>({quality,available:true,requiresSubscription:false})),availability:{status:'unknown',requiresSubscription:false}}));
const queue = { generation: 1, selectedIndex: 0, items: Array.from({length: 12}, (_, i) => ({ id: `track${i}`, title: i === 0 ? '夏夜晚风' : `旅途中的旋律 ${i + 1}`, artist: '遥控界面测试', album: '沿途的声音', durationMs: 240000 })) };
const player = { state: 'paused', generation: 1, positionMs: 5000, durationMs: 240000, volume: .5, muted: false, currentTrack: {id:queue.items[0].id,title:queue.items[0].title,artist:queue.items[0].artist}, failure: null };
let mode = 'sequence', unavailable = false;
const json = (response, status, value) => { response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); response.end(JSON.stringify(value)); };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    if (request.headers.authorization !== `Bearer ${secret}`) return json(response, 401, {message: '连接码无效'});
    if (unavailable) return json(response, 503, {message: '模拟断线'});
    if (url.pathname === '/api/library') {
      let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
        const c=JSON.parse(body); libraryRequests.push(c);
        if(c.command==='auth_status') return json(response,200,{state:signedIn?'authenticated':'signedOut'});
        if(c.command==='library_set_liked') return json(response,200,{status:'applied',affectedCount:1});
        if(c.command==='local_music_list') return json(response,200,{tracks:[localSong],warningCount:0});
        if(c.command==='library_playlists') return json(response,200,{kind:c.kind,page:1,hasMore:false,total:1,warningCount:0,items:[{id:c.kind==='created'?'123':'456',...(c.kind==='created'?{editableId:'789'}:{}),title:c.kind==='created'?'电脑创建的歌单':'电脑收藏的歌单',description:'',songCount:25}]});
        if(c.command==='queue_replace') { queue.items.splice(0,queue.items.length,...c.ids.map(id=>{const song=catalogSongs.find(t=>t.id===id);return {id:song.id,title:song.title,artist:song.artist,album:song.album,durationMs:song.durationMs};}));queue.generation++;queue.selectedIndex=0;return json(response,200,queue); }
        if(c.command==='queue_enqueue') {
          const song=c.id===localSong.id?localSong:catalogSongs.find(t=>t.id===c.id);
          if(!queue.items.some(t=>t.id===c.id)){queue.items.push({id:song.id,title:song.title,artist:song.artist,album:song.album,durationMs:song.durationMs});queue.generation++;}
          return json(response,200,queue);
        }
        const page=c.page||1;
        return json(response,200,{generation:c.generation,page,hasMore:page===1,warningCount:0,items:catalogSongs.slice((page-1)*20,page*20)});
      });return;
    }
    if (url.pathname === '/api/state') return json(response, 200, { mode, player, requestedQuality: '320k', queue: url.searchParams.get('known') === String(queue.generation) ? null : queue });
    if (url.pathname === '/api/preview') return json(response, 200, mode === 'repeat-one' ? player.currentTrack.id : mode === 'shuffle' ? 'track7' : 'track1');
    if (url.pathname === '/api/lyrics') return json(response, 200, {generation: player.generation, trackId: player.currentTrack?.id, lines: [{atMs: 0, original: '让晚风轻轻吹过'}, {atMs: 4000, original: '把喜欢的歌留在此刻'}, {atMs: 9000, original: '从桌面，到你的手边'}, {atMs: 15000, original: '音乐还在继续'}]});
    if (url.pathname === '/api/cover') return json(response, 404, {message: '测试占位封面'});
    if (url.pathname === '/api/command') {
      let body = ''; request.on('data', (chunk) => body += chunk); request.on('end', () => {
        const command = JSON.parse(body); commands.push(command);
        if (command.action === 'play') player.state = 'playing';
        if (command.action === 'pause') player.state = 'paused';
        if (command.action === 'volume') player.volume = command.value;
        if (command.action === 'mode') mode = command.value;
        if (command.action === 'seek') player.positionMs = command.position_ms;
        if (command.action === 'playTrack') { queue.selectedIndex = queue.items.findIndex((t) => t.id === command.id); queue.generation++; const track = queue.items[queue.selectedIndex]; player.currentTrack = {id:track.id,title:track.title,artist:track.artist}; player.generation++; }
        json(response, 200, command.action === 'mode' ? { mode, player, queue, requestedQuality:'320k' } : command.action === 'playTrack' ? { requestedQuality:'320k', queue, playback:{ quality:'320k',expiresInSeconds:3600,player } } : player);
      }); return;
    }
  }
  const files = {'/': ['index.html', 'text/html'], '/remote.js': ['remote.js', 'text/javascript'], '/remote.css': ['remote.css', 'text/css']};
  const file = files[url.pathname];
  if (!file) { response.writeHead(404); return response.end(); }
  response.writeHead(200, {'Content-Type': file[1] + '; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  response.end(fs.readFileSync(path.join(root, file[0] === 'index.html' ? 'src/remote' : 'src-tauri/remote-dist', file[0])));
});
(async () => {
  fs.mkdirSync(output, {recursive:true});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({executablePath:process.env.QMG_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:768,height:1024}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByLabel('连接码',{exact:true}).fill('wrong');
    await page.getByRole('button',{name:'连接电脑'}).click();
    await page.getByRole('alert').filter({hasText:'无法连接'}).waitFor();
    await page.getByLabel('连接码',{exact:true}).fill(secret);
    await page.getByRole('button',{name:'连接电脑'}).click();
    await page.getByText('已连接',{exact:true}).waitFor();

    await page.getByText('把喜欢的歌留在此刻',{exact:true}).waitFor();
    assert.equal(commands.length,0);
    for (const [width,height] of [[390,844],[768,1024],[1280,900]]) {
      await page.setViewportSize({width,height});
      await page.waitForTimeout(700);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width}`);
      const stage=await page.locator('.stage-lyrics-panel').boundingBox();
      const nav=await page.locator('.remote-nav').boundingBox();
      assert(nav && Math.abs(nav.x+nav.width/2-width/2)<1, 'navigation centered '+width);
      assert(stage && stage.height>150 && stage.y+stage.height<=height,`lyrics usable ${width}`);
      assert(await page.getByRole('button',{name:'打开播放队列'}).isVisible(),`queue control ${width}`);
      assert(await page.getByLabel('音量',{exact:true}).isVisible(),`volume control ${width}`);
      assert(await page.locator('.player-bar__timeline input').isVisible(),`seek control ${width}`);
      await page.screenshot({path:path.join(output,`shared-${width}.png`)});
    }
    await page.getByRole('button',{name:'播放',exact:true}).click();
    await page.getByRole('button',{name:'暂停',exact:true}).waitFor();
    assert.equal(commands.filter(c=>c.action==='play').length,1);
    player.positionMs=17999;
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.stage-song-list').isVisible(),false);
    player.positionMs=18000;
    await page.getByRole('heading',{name:'即将播放',exact:true}).waitFor();
    assert.match(await page.locator('[data-up-next="true"]').innerText(),/旅途中的旋律 2/);
    mode='shuffle';
    await page.locator('[data-up-next="true"]').filter({hasText:'旅途中的旋律 8'}).waitFor();
    unavailable=true;
    await page.getByRole('status').filter({hasText:'连接中断'}).waitFor();
    assert(await page.locator('.remote-player').evaluate(el=>el.inert));
    const before=commands.length;
    unavailable=false;
    await page.getByText('已连接',{exact:true}).waitFor();
    assert.equal(commands.length,before,'reconnect does not replay writes');
    mode='repeat-one';
    await page.getByRole('heading',{name:'即将重播'}).waitFor();
    await page.getByRole('button',{name:'返回歌词',exact:true}).click();
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.stage-song-list').isVisible(),false);
    player.generation++;
    await page.getByRole('heading',{name:'即将重播'}).waitFor();
    player.positionMs=5000;
    await page.getByRole('button',{name:'展开歌曲列表'}).waitFor();
    await page.getByRole('button',{name:'打开播放队列'}).click();
    assert.equal(await page.getByRole('button',{name:'清空播放队列'}).isVisible(),false);
    await page.locator('.queue-list__track').filter({hasText:'旅途中的旋律 3'}).click();
    await page.getByRole('heading',{name:'旅途中的旋律 3',exact:true}).waitFor();
    assert.deepEqual(commands.find(c=>c.action==='playTrack'),{action:'playTrack',id:'track2',queue_generation:1});
    await page.getByRole('button',{name:'关闭播放队列'}).click();
    await page.getByRole('button',{name:'断开',exact:true}).click();
    await page.getByRole('button',{name:'连接电脑'}).waitFor();
    await page.goto(`http://127.0.0.1:${server.address().port}/#code=${secret}`);
    await page.reload();
    await page.waitForFunction(() => location.hash === '');
    await page.getByRole('button',{name:'连接电脑'}).click();
    await page.getByText('已连接',{exact:true}).waitFor();
    for(const [width,height] of [[390,844],[768,1024],[1280,900]]) {
      await page.setViewportSize({width,height});
      await page.getByRole('navigation',{name:'音乐导航'}).getByRole('button',{name:'曲库',exact:true}).click();
      await page.getByRole('button',{name:'在电脑播放',exact:true}).waitFor({timeout:5000}).catch(async e=>{console.log((await page.locator('body').innerText()).slice(-1700));throw e;});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`library overflow ${width}`);
      const button=await page.getByRole('button',{name:'在电脑播放',exact:true}).boundingBox();
      assert(button && button.y+button.height<=height,`play action accessible ${width}`);
      await page.screenshot({path:path.join(output,`library-${width}.png`)});
      await page.getByRole('button',{name:'返回舞台',exact:true}).click();
    }
    await page.getByRole('navigation',{name:'音乐导航'}).getByRole('button',{name:'搜索',exact:true}).click();
    await page.getByRole('searchbox').fill('测试');
    await page.getByRole('button',{name:'下一页',exact:true}).click();
    await page.getByText('第 2 页',{exact:true}).waitFor();
    await page.locator('.catalog-table__title').filter({hasText:'曲库歌曲 21'}).waitFor();
    await page.getByRole('button',{name:'在电脑播放',exact:true}).click();
    await page.waitForTimeout(750);
    assert(libraryRequests.some(c=>c.command==='queue_enqueue'&&c.id==='catalog20'));
    assert(commands.some(c=>c.action==='playTrack'&&c.id==='catalog20'),'enqueued song uses new queue snapshot');
    await page.getByRole('navigation',{name:'音乐导航'}).getByRole('button',{name:'喜欢',exact:true}).click();
    await page.getByRole('button',{name:'取消喜欢',exact:true}).click();
    await page.getByText('已取消喜欢',{exact:true}).waitFor();
    assert(libraryRequests.some(c=>c.command==='library_set_liked'&&c.liked===false));
    signedIn=false;
    await page.getByText('请先登录后读取账号曲库',{exact:true}).waitFor();
    signedIn=true;
    await page.getByRole('button',{name:'取消喜欢',exact:true}).waitFor();
    for(const [width,height] of [[390,844],[768,1024],[1280,900]]) {
      await page.setViewportSize({width,height});
      await page.getByRole('complementary',{name:'曲库导航'}).getByRole('button',{name:'歌单',exact:true}).click();
      await page.getByRole('heading',{name:'电脑创建的歌单',exact:true}).waitFor();
      await page.getByRole('heading',{name:'电脑收藏的歌单',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'删除歌单',exact:true}).count(),0);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`playlist overflow ${width}`);
      await page.screenshot({path:path.join(output,`playlists-${width}.png`)});
      await page.locator('.playlist-card').filter({hasText:'电脑创建的歌单'}).getByRole('button',{name:'打开歌单'}).click();
      await page.locator('.catalog-table__title').filter({hasText:'曲库歌曲 1'}).first().waitFor();
      await page.screenshot({path:path.join(output,`playlist-detail-${width}.png`)});
      await page.getByRole('complementary',{name:'曲库导航'}).getByRole('button',{name:'本地音乐',exact:true}).click();
      await page.getByRole('heading',{name:'电脑本地歌曲',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'导入音乐',exact:true}).count(),0);
      await page.screenshot({path:path.join(output,`local-${width}.png`)});
    }
    await page.getByRole('button',{name:'立即播放',exact:true}).click();
    await page.waitForTimeout(800);
    assert(commands.some(c=>c.action==='playTrack'&&c.id===localSong.id));
    await page.getByRole('complementary',{name:'曲库导航'}).getByRole('button',{name:'歌单',exact:true}).click();
    await page.locator('.playlist-card').filter({hasText:'电脑创建的歌单'}).getByRole('button',{name:'打开歌单'}).click();
    await page.getByRole('button',{name:'播放全部',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.playlist-detail__play-all')?.textContent.includes('播放全部'));
    assert(libraryRequests.some(c=>c.command==='queue_replace'&&c.ids.length===25));
    await page.getByRole('button',{name:'返回舞台',exact:true}).click();
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'shared-result.json'),JSON.stringify({passed:true,viewports:[390,768,1280],checks:['pairing','shared lyrics','3000ms boundary','core shuffle preview','repeat-one','dismiss','generation reset','seek back','reconnect no replay','queue stable id','library viewports','search pagination','catalog enqueue then play','unlike','desktop auth state refresh'],pageErrors:errors},null,2));
    console.log('Shared WebUI browser checks passed');
  } finally { await browser.close(); server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
