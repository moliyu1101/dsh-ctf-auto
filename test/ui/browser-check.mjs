import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFixture } from './fixture.mjs';
import { host } from '../helpers/host.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(process.env.CTF_UI_DEPS ? path.join(path.resolve(process.env.CTF_UI_DEPS),'package.json') : import.meta.url);
const {chromium}=require('playwright');
const fixture=createFixture();
let responder=fixture.response, session="demo";
const cleanups=[];
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CTF Workspace · Browser fixture</title><style>body{margin:0;background:#f4f6f5}#app{max-width:1800px;margin:auto}</style><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.__ModuleLoader__={load({factory}){const plugin=factory(name=>{if(name==='react')return React;throw Error(name)});plugin.apply({effect(fn){fn()},slots:{inject(name,fn){fn()},register(meta,Component){ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(Component,{sessionId:'demo'}));return ()=>{}}}})}};</script><script src="/client.js"></script></html>`;
const assets={'/react.js':path.join(path.dirname(require.resolve('react/package.json')),'umd/react.development.js'),'/react-dom.js':path.join(path.dirname(require.resolve('react-dom/package.json')),'umd/react-dom.development.js'),'/client.js':path.join(root,'lib/client.js')};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(assets[url.pathname]){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(assets[url.pathname]));return;}
  if(url.pathname.startsWith('/dsh-ctf-auto/')){const chunks=[];for await(const c of req)chunks.push(c);const p=JSON.parse(Buffer.concat(chunks).toString()||'{}');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(url.pathname.endsWith('/csrf')?{token:'fixture-csrf'}:await responder(url.pathname.split('/').pop(),p)));return;}
  res.setHeader('Content-Type','text/html');res.end(html.replace('sessionId:\"demo\"','sessionId:\"'+session+'\"'));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CTF_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const out=process.env.CTF_UI_ARTIFACTS||'/tmp/ctf-ui-artifacts';fs.mkdirSync(out,{recursive:true});
const nav=name=>page.getByRole('tab',{name,exact:true});
async function visible(locator){await locator.waitFor({state:'visible',timeout:5000});}
async function shot(name){await page.waitForTimeout(180);await page.screenshot({path:path.join(out,name+'.png'),fullPage:true,style:'.dsh-ctf-toast{visibility:hidden}'});}
async function noOverflow(){const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(size.scroll<=size.width+1,JSON.stringify(size));}
let checks=0;function passed(name){checks++;console.log('PASS '+name);}
try {
 await page.goto('http://127.0.0.1:'+server.address().port);await visible(page.getByRole('heading',{name:'每一步验证，都有迹可循。'}));await shot('overview-light');await noOverflow();passed('overview renders live API data');
 await nav('题目工作台').click();await visible(page.getByRole('button',{name:'打开题目：Serpent cipher'}));await shot('board-light');
 await page.getByLabel('搜索题目',{exact:true}).fill('RSA');await visible(page.getByRole('button',{name:'打开题目：RSA 的另一面'}));assert.equal(await page.locator('.dsh-ctf-card').count(),1);await page.getByLabel('搜索题目',{exact:true}).fill('');passed('board search filters actual rows');
 await page.locator('.dsh-ctf-card').filter({has:page.getByRole('button',{name:'打开题目：Serpent cipher'})}).getByRole('button',{name:'停止',exact:true}).click();
 await visible(page.getByText('已停止：Serpent cipher'));assert.equal(fixture.rows.find(c=>c.id==='cipher').status,'stopped');
 await page.locator('.dsh-ctf-card').filter({has:page.getByRole('button',{name:'打开题目：Serpent cipher'})}).getByRole('button',{name:'继续',exact:true}).click();
 await visible(page.getByText('已重新排队：Serpent cipher'));assert.equal(fixture.rows.find(c=>c.id==='cipher').status,'queued');passed('stop and retry dispatch scoped API mutations');
 await page.getByRole('button',{name:'看板',exact:true}).click();assert.equal(await page.locator('.dsh-ctf-lane').count(),4);await noOverflow();await shot('kanban-light');
 await page.getByRole('button',{name:'打开题目：Serpent cipher'}).click();await visible(page.getByRole('tab',{name:'题面与状态'}));
 for(const name of ['实验黑板','蜂群协作','尝试与事件','学习反馈','附件 1','笔记','脚本 0','产物 0','题面与状态']){await page.getByRole('tab',{name,exact:true}).click();await noOverflow();}
 await page.getByRole('tab',{name:'蜂群协作',exact:true}).click();await shot('workbench-swarm');passed('all workbench sections render with a single active detail');
 await page.getByRole('tab',{name:'笔记',exact:true}).click();await page.getByLabel('题目笔记').fill('尚未保存的笔记');page.once('dialog',d=>d.dismiss());await nav('知识库').click();assert.equal(await nav('题目工作台').getAttribute('aria-selected'),'true');await page.getByRole('button',{name:'保存笔记 *',exact:true}).click();await visible(page.getByRole('button',{name:'保存笔记',exact:true}));passed('dirty notes guard and save');
 await page.getByRole('button',{name:'关闭题目工作台'}).click();await page.getByLabel('全部工作区',{exact:true}).check();await visible(page.getByText('全部工作区 · 只读浏览'));assert.equal(await page.getByRole('button',{name:'一键开始',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'全部停止',exact:true}).count(),0);await page.getByRole('button',{name:'返回当前工作区'}).click();passed('cross-workspace board has no mutation controls');
 for(const name of ['平台接入','调度中心','Flag 台账','复盘报告','知识库','经验记忆','设置']){await nav(name).click();await visible(page.getByRole('heading',{name,exact:true}));await page.waitForTimeout(120);await noOverflow();await shot('page-'+name);}
 passed('all top-level pages render');
 await page.getByRole('button',{name:'平台与靶机',exact:true}).click();await visible(page.getByText('靶机环境',{exact:true}));
 await page.getByLabel('容器题串行执行',{exact:false}).uncheck();await page.getByRole('button',{name:'保存配置',exact:true}).click();await visible(page.getByText('运行时配置已更新'));assert.equal(fixture.calls.filter(c=>c.endpoint==='config.set').at(-1).payload.patch.envSerial,false);passed('environment settings are visible and save correctly');
 await nav('知识库').click();await page.getByLabel('检索知识库',{exact:true}).fill('zip-symlink');
 // Use Enter as supported by the search input.
 await page.getByLabel('检索知识库',{exact:true}).press('Enter');await visible(page.getByText('ZIP 符号链接实验记录'));await visible(page.getByText(/引用行 8–14/));passed('knowledge search preserves citations');
 await page.route('**/dsh-ctf-auto/kb.stats',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:false,error:'测试：知识索引不可读取'})}));
 await page.getByRole('button',{name:'刷新题板',exact:true}).click();await visible(page.getByRole('alert').filter({hasText:'测试：知识索引不可读取'}));
 await page.unroute('**/dsh-ctf-auto/kb.stats');await page.getByRole('button',{name:'刷新题板',exact:true}).click();await page.getByRole('alert').filter({hasText:'测试：知识索引不可读取'}).waitFor({state:'hidden'});passed('resource errors stay visible and reload recovers');
 await page.route('**/dsh-ctf-auto/kb.search',async route=>{const q=route.request().postDataJSON().q;await new Promise(resolve=>setTimeout(resolve,q==='slow'?350:20));await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,results:[{id:q,title:q,source:'imported',snippet:q,score:1}]})});});
 await page.getByLabel('检索知识库',{exact:true}).fill('slow');await page.getByLabel('检索知识库',{exact:true}).press('Enter');await page.getByLabel('检索知识库',{exact:true}).fill('fast');await page.getByLabel('检索知识库',{exact:true}).press('Enter');await visible(page.locator('.dsh-ctf-kbtitle').filter({hasText:'fast'}));await page.waitForTimeout(450);assert.equal(await page.locator('.dsh-ctf-kbtitle').innerText(),'fast');await page.unroute('**/dsh-ctf-auto/kb.search');passed('late search responses cannot replace newer results');

 await page.getByRole('button',{name:'快速查找',exact:true}).last().click();await visible(page.getByRole('dialog'));await page.getByLabel('快速查找关键词').fill('Serpent');await page.getByLabel('快速查找关键词').press('Enter');await visible(page.getByRole('tab',{name:'蜂群协作',exact:true}));assert.equal(await page.getByRole('dialog').count(),0);passed('command palette opens challenge');
 await page.getByRole('button',{name:'关闭题目工作台'}).click();await nav('总览').focus();await page.keyboard.press('End');assert.equal(await nav('设置').getAttribute('aria-selected'),'true');await page.keyboard.press('Home');assert.equal(await nav('总览').getAttribute('aria-selected'),'true');passed('keyboard tab navigation');
 await page.getByRole('button',{name:'快速查找',exact:true}).last().click();await page.getByLabel('快速查找关键词').press('Shift+Tab');assert.equal(await page.locator(':focus').getAttribute('class'),'dsh-ctf-commanditem');await page.keyboard.press('Escape');assert.equal(await page.locator(':focus').getAttribute('aria-label'),'快速查找');passed('dialog traps and restores focus');
 await page.evaluate(()=>document.getElementById('app').style.maxWidth='650px');await noOverflow();assert.equal(await page.locator('.dsh-ctf-rail').evaluate(e=>getComputedStyle(e).position),'static');await page.evaluate(()=>document.getElementById('app').style.maxWidth='1800px');passed('layout responds to host panel width');
 await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));await shot('overview-dark');await nav('题目工作台').click();await page.getByRole('button',{name:'卡片',exact:true}).click();await shot('board-dark');
 await page.setViewportSize({width:390,height:844});await noOverflow();await shot('board-mobile-dark');
 await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));await nav('总览').click();await noOverflow();await shot('overview-mobile');
 for(const name of ['平台接入','调度中心','Flag 台账','复盘报告','知识库','经验记忆','设置']){await nav(name).click();await page.waitForTimeout(80);await noOverflow();}passed('dark theme and all mobile pages fit viewport');
 await page.setViewportSize({width:1440,height:1100});fixture.setFailed(true);await nav('总览').click();await page.getByRole('button',{name:'刷新题板',exact:true}).click();await visible(page.getByText('测试：连接已断开'));fixture.setFailed(false);await page.getByRole('button',{name:'刷新题板',exact:true}).click();await visible(page.getByRole('heading',{name:'每一步验证，都有迹可循。'}));passed('failed refresh preserves data and can recover');
 fixture.setEmpty(true);await page.getByRole('button',{name:'刷新题板',exact:true}).click();await visible(page.getByRole('heading',{name:'从第一道题，开始解题。'}));await nav('题目工作台').click();await visible(page.getByText('题板还是空的'));await shot('empty-state');passed('empty state has actionable guidance');
 await page.getByRole('button',{name:'新建题目',exact:true}).first().click();await page.getByLabel('题目名称 *',{exact:true}).fill('浏览器新建题目');await page.getByLabel('题面 *',{exact:true}).fill('测试新建流程，保留完整 API 参数。');
 await page.getByRole('checkbox',{name:/创建后/}).uncheck();await page.getByRole('button',{name:/创建题目|创建并/}).last().click();await visible(page.getByText('已创建题目（未启动）'));assert.ok(fixture.calls.some(c=>c.endpoint==='challenge.add'&&c.payload.sessionId==='demo'));passed('create challenge preserves session scope');
 // Reuse the shipped host router and file store through the HTTP helper. No contest/platform calls.
 const actual=await host({after:fn=>cleanups.push(fn)});session='a';responder=actual.post;
 await page.reload();await visible(page.getByRole('heading',{name:'从第一道题，开始解题。'}));
 await page.getByRole('button',{name:'新建题目',exact:true}).first().click();await page.getByLabel('题目名称 *',{exact:true}).fill('真实路由工作台验证');await page.getByLabel('题面 *',{exact:true}).fill('验证新界面与真实插件存储接口的兼容性。');await page.getByRole('checkbox',{name:/创建后/}).uncheck();await page.getByRole('button',{name:'创建题目',exact:true}).click();await visible(page.getByText('已创建题目（未启动）'));
 const created=(await actual.post('state.get')).challenges[0];assert.equal(created.title,'真实路由工作台验证');await page.getByRole('button',{name:'打开题目：真实路由工作台验证'}).click();await page.getByRole('tab',{name:'笔记',exact:true}).click();await page.getByLabel('题目笔记').fill('真实接口保存的笔记内容。');await page.getByRole('button',{name:'保存笔记 *',exact:true}).click();await visible(page.getByRole('button',{name:'保存笔记',exact:true}));assert.match((await actual.post('workbench.read',{id:created.id,path:'notes.md'})).text,/真实接口保存/);passed('real host create and notes persistence');
 await page.getByRole('tab',{name:'实验黑板',exact:true}).click();
 async function experiment(key,hypothesis){await page.getByRole('button',{name:'新建实验',exact:true}).click();await page.getByLabel('稳定实验 key（同一路径沿用同一 key）').fill(key);await page.getByLabel('可证伪假设',{exact:true}).fill(hypothesis);await page.getByLabel('测试范围',{exact:true}).fill('本题输入文件');await page.getByLabel('可观察的预期',{exact:true}).fill('可以读取并复验指定输入格式');}
 await experiment('parse-input','输入能否解析为有效记录？');await page.getByRole('button',{name:'保存实验',exact:true}).click();await visible(page.getByText('输入能否解析为有效记录？',{exact:true}));
 await experiment('validate-record','解析后记录是否满足约束？');await page.getByRole('button',{name:'添加前置实验',exact:true}).click();await page.getByLabel('锁定版本',{exact:true}).check();await page.getByRole('button',{name:'保存实验',exact:true}).click();await visible(page.getByText('解析后记录是否满足约束？',{exact:true}));const board=await actual.post('experiment.list',{id:created.id});const child=board.rows.find(r=>r.key==='validate-record');assert.equal(child.dependsOn[0].key,'parse-input');assert.equal(child.dependsOn[0].version,1);await shot('real-experiment-prerequisites');passed('real host prerequisite editor preserves version pins');
 await page.getByRole('tab',{name:'蜂群协作',exact:true}).click();await visible(page.getByText('蜂群协作尚未开启'));await page.getByRole('tab',{name:'学习反馈',exact:true}).click();await visible(page.getByText('尚无可评价的资料'));passed('real host empty collaboration states');
 assert.deepEqual(errors,[]);passed('no browser runtime errors or React warnings');
 console.log(JSON.stringify({checks,artifacts:out,requests:fixture.calls.length}));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));for(const cleanup of cleanups.reverse())await cleanup();}
