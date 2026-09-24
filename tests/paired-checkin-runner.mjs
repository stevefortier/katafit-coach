import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {Store} from '../dist/config/store.js';
import {admin} from '../dist/server/admin.js';

const dir=await mkdtemp(tmpdir()+'/paired-operator-');
let app;
const post=(path,body,key)=>fetch(app.origin+path,{method:'POST',headers:{Authorization:'Bearer '+key,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
const get=(path,key)=>fetch(app.origin+path,{headers:key?{Authorization:'Bearer '+key}:{}});
const parse=output=>JSON.parse(output.content.find(part=>part.type==='text').text);
try {
 const store=new Store(dir);await store.init();
 await store.save({...store.publicConfig(),origin:process.env.PAIRED_ORIGIN,token:process.env.PAIRED_TOKEN,apiKey:'synthetic-paired-key'});
 const seen=[];let sent;
 app=await admin(store,0,async (_provider,_prompt,_input,_signal,tools=[])=>{
  let stage='tool catalog';
  try {
  const names=tools.map(t=>t.name);
  for(const name of ['studio_operator_list_members','studio_operator_read_member_coach_feed','studio_operator_send_message','studio_operator_list_dojo_checkins','studio_operator_read_dojo_checkin_image']) assert.ok(names.includes(name),name);
  const tool=name=>({execute:async(id,args)=>{stage=name;return tools.find(t=>t.name===name).execute(id,args)}});
  const members=parse(await tool('studio_operator_list_members').execute('roster',{})).members;
  assert.deepEqual(members.filter(m=>['Alex','Morgan','Pat'].includes(m.display_name)).map(m=>m.display_name).sort(),['Alex','Morgan','Pat']);
  const refs=Object.fromEntries(members.map(m=>[m.display_name,m.member_ref]));
  assert.ok(refs.Alex&&refs.Morgan&&refs.Pat&&refs.Alex!==refs.Morgan);
  const roster=parse(await tool('studio_operator_list_dojo_checkins').execute('checkins',{limit:10}));
  seen.push(roster);
  if(seen.length<=2){
   assert.deepEqual(roster.items.filter(i=>i.access==='shared'&&i.images.length).map(i=>i.display_name).sort(),['Alex','Morgan']);
   assert.equal(roster.items.find(i=>i.display_name==='Pat').access,'not_shared');
   if(seen.length===1){
    for(const name of ['Alex','Morgan']) assert.ok(Array.isArray(parse(await tool('studio_operator_read_member_coach_feed').execute('feed',{member_ref:refs[name]})).items));
    const patFeed=parse(await tool('studio_operator_read_member_coach_feed').execute('pat-feed',{member_ref:refs.Pat}));
    assert.deepEqual(patFeed.items,[]);
    await assert.rejects(tool('studio_operator_read_dojo_checkin_image').execute('denied',{member_ref:refs.Pat,media_ref:roster.items.find(i=>i.display_name==='Alex').images[0].media_ref}),/READ_NOT_AUTHORIZED/);
   }
   for(const row of roster.items.filter(i=>i.access==='shared'&&i.images.length)){
    const image=await tool('studio_operator_read_dojo_checkin_image').execute('read',{member_ref:row.member_ref,media_ref:row.images[0].media_ref});
    if(seen.length===1) assert.match(image.content[0].text,/not visually assessed/);
    else assert.equal(image.content.some(part=>part.type==='image'),true);
   }
   if(seen.length===1){
    sent=parse(await tool('studio_operator_send_message').execute('send',{member_ref:refs.Alex,text:'Synthetic paired Operator hello for Alex.'}));
    assert.equal(sent.status,'delivered');assert.ok(sent.action_id&&sent.message_id);
    await assert.rejects(tool('studio_operator_send_message').execute('second',{member_ref:refs.Morgan,text:'No second send'}),/ARGUMENTS_REJECTED/);
   }
  } else assert.equal(roster.items.find(i=>i.display_name==='Alex').access,'not_shared');
  return 'Synthetic provider fixture reply.';
  } catch(error) { console.error('PAIRED_STAGE',stage,error.message); throw error; }
 });
 const key=store.secrets.admin;
 const reply=await post('/api/operator/chat',{text:'Show current dojo check-in photos and send Alex a synthetic hello'},key);
 assert.equal(reply.status,200,await reply.clone().text());
 const data=await reply.json();assert.equal(data.ephemeral,true);assert.equal(data.images.length,2);
 assert.deepEqual(data.images.map(i=>i.display_name).sort(),['Alex','Morgan']);
 assert.ok(data.images.every(i=>i.checkin_at));
 assert.equal((await get('/api/operator/image?id='+data.images[0].id)).status,401);
 for(const image of data.images){const response=await get('/api/operator/image?id='+image.id,key);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(process.env['PAIRED_PNG_'+image.display_name.toUpperCase()],'base64'));}
 for(const png of [process.env.PAIRED_PNG_ALEX,process.env.PAIRED_PNG_MORGAN]) assert.ok(!JSON.stringify(data).includes(png));
 const clear=await post('/api/operator/clear',{},key);assert.equal(clear.status,200);
 assert.notEqual((await get('/api/operator/image?id='+data.images[0].id,key)).status,200);
 await store.save({...store.publicConfig(),provider:{...store.publicConfig().provider,vision:true}});
 const second=await post('/api/operator/chat',{text:'Show current dojo check-ins'},key);
 assert.equal(second.status,200,await second.clone().text());const secondData=await second.json();assert.equal(secondData.ephemeral,true);assert.equal(secondData.images.length,2);
 assert.equal(seen.length,2);
 const revoke=await fetch(process.env.PAIRED_ORIGIN+'/__paired/revoke',{method:'POST'});assert.equal(revoke.status,204);
 assert.notEqual((await get('/api/operator/image?id='+secondData.images[0].id,key)).status,200);
 const third=await post('/api/operator/chat',{text:'Show current sharing again'},key);assert.equal(third.status,200,await third.clone().text());assert.equal((await third.json()).ephemeral,true);
 assert.equal(seen.length,3);
 console.log(JSON.stringify({status:'pass',cards:data.images.map(({display_name,checkin_at})=>({display_name,checkin_at})),rosterMembers:3,readMembers:2,deniedMember:true,sendStatus:sent.status,clearDenied:true,revokeDenied:true,noStore:true,vision:true}));
}finally{await app?.close();await rm(dir,{recursive:true,force:true});}
